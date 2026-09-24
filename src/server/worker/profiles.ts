/**
 * Perfis de worker: identidade + configuração de cada processo worker, guardados no banco (nada de env).
 * Regras de validação vivem aqui (zod) e também como CHECK na migration — a API e o worker usam as mesmas.
 */
import { z } from "zod";

/** Tipos de job que um worker pode processar. Também validados no banco (CHECK) porque o `claim` os interpola no SQL. */
export const KNOWN_JOB_TYPES = ["PREVIEW_UPLOAD", "IMPORT_UPLOAD", "SOURCE_REFRESH", "DERIVED_REFRESH", "METADATA_CLEANUP", "MIGRATE_STORAGE_PROJECT", "MIGRATE_STORAGE_DATASET"] as const;
export type JobType = (typeof KNOWN_JOB_TYPES)[number];

/**
 * "Peso" do job = classe de custo (0 e 1 = leves, 2 = pesados). Um perfil pode se restringir a alguns pesos (faixa);
 * lista vazia = todos (comportamento anterior). Também validado no banco (CHECK).
 */
export const KNOWN_WEIGHTS = [0, 1, 2] as const;

/** Pesos que cada tipo de job PODE ter (quem enfileira: actions.ts, sources.ts, derived.ts, retenção). Base da checagem de cobertura. */
export const JOB_WEIGHTS_BY_TYPE: Record<JobType, readonly number[]> = {
  PREVIEW_UPLOAD: [0, 2],
  IMPORT_UPLOAD: [1, 2],
  SOURCE_REFRESH: [0, 2],
  DERIVED_REFRESH: [2],
  METADATA_CLEANUP: [0],
  // Copia tabela por tabela entre StorageServers — mesma classe de custo (I/O + memória) de um
  // DERIVED_REFRESH grande, então só a faixa pesada.
  MIGRATE_STORAGE_PROJECT: [2],
  MIGRATE_STORAGE_DATASET: [2],
};

export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MEMORY_LIMIT = /^[0-9]+(\.[0-9]+)?(MB|GB)$/;

export const PROFILE_DEFAULTS = { concurrency: 1, pollMs: 2000, duckdbMemoryLimit: "1GB", enabled: true } as const;

const jobTypes = z
  .array(z.enum(KNOWN_JOB_TYPES))
  .min(1, "Escolha ao menos um tipo de job")
  .transform((types) => [...new Set(types)]);

const weights = z
  .array(z.number().int().min(0).max(2))
  .transform((ws) => [...new Set(ws)].sort((a, b) => a - b));

const concurrency = z.number().int().min(1).max(20);
const pollMs = z.number().int().min(250).max(60_000);
const duckdbMemoryLimit = z.string().regex(MEMORY_LIMIT, "Use o formato 512MB ou 1.5GB");

export const profileCreateSchema = z.object({
  name: z.string().regex(PROFILE_NAME, "Use letras minúsculas, números e hífen (até 63 caracteres)"),
  jobTypes,
  weights: weights.default([]),
  concurrency: concurrency.default(PROFILE_DEFAULTS.concurrency),
  pollMs: pollMs.default(PROFILE_DEFAULTS.pollMs),
  duckdbMemoryLimit: duckdbMemoryLimit.default(PROFILE_DEFAULTS.duckdbMemoryLimit),
  enabled: z.boolean().default(PROFILE_DEFAULTS.enabled),
});

/** Edição parcial: campos ausentes ficam como estão (sem aplicar padrões) e o nome não muda. */
export const profilePatchSchema = z.object({
  jobTypes: jobTypes.optional(),
  weights: weights.optional(),
  concurrency: concurrency.optional(),
  pollMs: pollMs.optional(),
  duckdbMemoryLimit: duckdbMemoryLimit.optional(),
  enabled: z.boolean().optional(),
});

export type ProfileInput = z.infer<typeof profileCreateSchema>;

/** Campos cuja mudança só vale depois de reiniciar o processo (o filho relê poll/memória sozinho). */
export const RESTART_REQUIRED_FIELDS = ["jobTypes", "weights", "concurrency"] as const;

type Restartable = { jobTypes: string[]; concurrency: number; weights?: number[] };
const sortedKey = (xs: (string | number)[]) => [...xs].sort().join(",");

export function needsRestart(before: Restartable, after: Restartable): boolean {
  return before.concurrency !== after.concurrency
    || sortedKey(before.jobTypes) !== sortedKey(after.jobTypes)
    || sortedKey(before.weights ?? []) !== sortedKey(after.weights ?? []);
}

/** Tipos de job que ficariam SEM nenhum perfil habilitado (aviso ao editar/remover). */
export function uncoveredJobTypes(profiles: { enabled: boolean; jobTypes: string[] }[]): JobType[] {
  const covered = new Set(profiles.filter((p) => p.enabled).flatMap((p) => p.jobTypes));
  return KNOWN_JOB_TYPES.filter((t) => !covered.has(t));
}

/** O perfil aceita jobs deste peso? (lista vazia = todos) */
export function acceptsWeight(weights: readonly number[] | undefined, weight: number): boolean {
  return !weights || weights.length === 0 || weights.includes(weight);
}

/**
 * Pares (tipo, peso) que ficariam SEM nenhum perfil habilitado: esses jobs ficam na fila para sempre.
 * Só considera os pesos que o tipo realmente pode ter (JOB_WEIGHTS_BY_TYPE). Vazio = tudo coberto.
 */
export function uncoveredLanes(profiles: { enabled: boolean; jobTypes: string[]; weights?: number[] }[]): { type: JobType; weight: number }[] {
  const on = profiles.filter((p) => p.enabled);
  const out: { type: JobType; weight: number }[] = [];
  for (const type of KNOWN_JOB_TYPES) {
    for (const weight of JOB_WEIGHTS_BY_TYPE[type]) {
      if (!on.some((p) => p.jobTypes.includes(type) && acceptsWeight(p.weights, weight))) out.push({ type, weight });
    }
  }
  return out;
}

/** Avisos legíveis de cobertura (tipo sem perfil, ou só a faixa pesada/leve dele sem perfil). */
export function coverageWarnings(profiles: { enabled: boolean; jobTypes: string[]; weights?: number[] }[]): string[] {
  const uncoveredTypes = new Set(uncoveredJobTypes(profiles));
  const warnings: string[] = [];
  if (uncoveredTypes.size) warnings.push(`Nenhum perfil habilitado processa: ${[...uncoveredTypes].join(", ")}.`);
  for (const l of uncoveredLanes(profiles)) {
    if (uncoveredTypes.has(l.type)) continue; // já dito acima
    warnings.push(`Nenhum perfil habilitado processa jobs ${l.type} ${l.weight >= 2 ? "pesados" : "leves"} (peso ${l.weight}): eles ficarão na fila.`);
  }
  return warnings;
}

/** "todas as cargas" | "só leves" | "só pesadas" | "pesos 1" — para a tela. */
export function weightsLabel(weights: readonly number[] | undefined): string {
  if (!weights || weights.length === 0) return "todas as cargas";
  const k = [...weights].sort((a, b) => a - b).join(",");
  if (k === "0,1") return "só cargas leves";
  if (k === "2") return "só cargas pesadas";
  return `pesos ${k}`;
}

/** Limite de memória do DuckDB em bytes aproximados, só para comparar/mostrar. */
export function memoryLimitBytes(limit: string): number | null {
  const m = MEMORY_LIMIT.exec(limit);
  if (!m) return null;
  const n = parseFloat(limit);
  return Math.round(n * (limit.endsWith("GB") ? 1024 ** 3 : 1024 ** 2));
}
