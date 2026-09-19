/**
 * Perfis de worker: identidade + configuração de cada processo worker, guardados no banco (nada de env).
 * Regras de validação vivem aqui (zod) e também como CHECK na migration — a API e o worker usam as mesmas.
 */
import { z } from "zod";

/** Tipos de job que um worker pode processar. Também validados no banco (CHECK) porque o `claim` os interpola no SQL. */
export const KNOWN_JOB_TYPES = ["PREVIEW_UPLOAD", "IMPORT_UPLOAD", "SOURCE_REFRESH", "DERIVED_REFRESH", "METADATA_CLEANUP"] as const;
export type JobType = (typeof KNOWN_JOB_TYPES)[number];

export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MEMORY_LIMIT = /^[0-9]+(\.[0-9]+)?(MB|GB)$/;

export const PROFILE_DEFAULTS = { concurrency: 1, pollMs: 2000, duckdbMemoryLimit: "1GB", enabled: true } as const;

const jobTypes = z
  .array(z.enum(KNOWN_JOB_TYPES))
  .min(1, "Escolha ao menos um tipo de job")
  .transform((types) => [...new Set(types)]);

const concurrency = z.number().int().min(1).max(20);
const pollMs = z.number().int().min(250).max(60_000);
const duckdbMemoryLimit = z.string().regex(MEMORY_LIMIT, "Use o formato 512MB ou 1.5GB");

export const profileCreateSchema = z.object({
  name: z.string().regex(PROFILE_NAME, "Use letras minúsculas, números e hífen (até 63 caracteres)"),
  jobTypes,
  concurrency: concurrency.default(PROFILE_DEFAULTS.concurrency),
  pollMs: pollMs.default(PROFILE_DEFAULTS.pollMs),
  duckdbMemoryLimit: duckdbMemoryLimit.default(PROFILE_DEFAULTS.duckdbMemoryLimit),
  enabled: z.boolean().default(PROFILE_DEFAULTS.enabled),
});

/** Edição parcial: campos ausentes ficam como estão (sem aplicar padrões) e o nome não muda. */
export const profilePatchSchema = z.object({
  jobTypes: jobTypes.optional(),
  concurrency: concurrency.optional(),
  pollMs: pollMs.optional(),
  duckdbMemoryLimit: duckdbMemoryLimit.optional(),
  enabled: z.boolean().optional(),
});

export type ProfileInput = z.infer<typeof profileCreateSchema>;

/** Campos cuja mudança só vale depois de reiniciar o processo (o filho relê poll/memória sozinho). */
export const RESTART_REQUIRED_FIELDS = ["jobTypes", "concurrency"] as const;

export function needsRestart(before: { jobTypes: string[]; concurrency: number }, after: { jobTypes: string[]; concurrency: number }): boolean {
  return before.concurrency !== after.concurrency
    || [...before.jobTypes].sort().join(",") !== [...after.jobTypes].sort().join(",");
}

/** Tipos de job que ficariam SEM nenhum perfil habilitado (aviso ao editar/remover). */
export function uncoveredJobTypes(profiles: { enabled: boolean; jobTypes: string[] }[]): JobType[] {
  const covered = new Set(profiles.filter((p) => p.enabled).flatMap((p) => p.jobTypes));
  return KNOWN_JOB_TYPES.filter((t) => !covered.has(t));
}

/** Limite de memória do DuckDB em bytes aproximados, só para comparar/mostrar. */
export function memoryLimitBytes(limit: string): number | null {
  const m = MEMORY_LIMIT.exec(limit);
  if (!m) return null;
  const n = parseFloat(limit);
  return Math.round(n * (limit.endsWith("GB") ? 1024 ** 3 : 1024 ** 2));
}
