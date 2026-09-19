import { z } from "zod";

/**
 * Variáveis de ambiente do Catworld: SÓ o que é infraestrutura ou segredo e precisa existir ANTES de o banco estar
 * acessível. Configuração de worker (perfis, concorrência, tipos de job, limites, upload) vive no banco e é editada em
 * Configurações > Worker — nenhuma env de worker é lida, nem como fallback. Ver docs/config-contract.md.
 */
const schema = z.object({
  CATWORLD_DATABASE_URL: z.string().min(1),
  CATWORLD_ENCRYPTION_KEY: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  CATWORLD_UPLOAD_DIR: z.string().default("./var/uploads"),
  CATWORLD_PUBLIC_ORIGIN: z.string().url().optional(),
});

/** Envs de worker que existiam antes dos perfis: agora são IGNORADAS (só avisamos, uma vez, para a migração). */
export const LEGACY_WORKER_ENV = [
  "CATWORLD_WORKER_ID",
  "CATWORLD_WORKER_CONCURRENCY",
  "CATWORLD_WORKER_JOB_TYPES",
  "CATWORLD_JOB_POLL_MS",
  "CATWORLD_DUCKDB_MEMORY_LIMIT",
  "CATWORLD_IMPORT_BATCH_DELAY_MS",
  "CATWORLD_MAX_HEAVY_JOBS",
  "CATWORLD_MAX_SYNCS_PER_STORAGE",
  "CATWORLD_UPLOAD_MAX_BYTES",
  "CATWORLD_XLSX_MAX_BYTES",
] as const;

/** Legadas presentes no ambiente, com o valor (para o administrador copiá-las para a tela). */
export function legacyWorkerEnvPresent(source: Record<string, string | undefined>): { name: string; value: string }[] {
  return LEGACY_WORKER_ENV.flatMap((name) => (source[name] !== undefined && source[name] !== "" ? [{ name, value: source[name]! }] : []));
}

let warned = false;

export function env() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Configuração inválida: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  if (!warned) {
    warned = true;
    const legacy = legacyWorkerEnvPresent(process.env);
    if (legacy.length) {
      console.warn(
        `[config] variáveis de worker IGNORADAS (agora ficam em Configurações > Worker): ${legacy.map((l) => `${l.name}=${l.value}`).join(", ")}. ` +
        "Copie os valores que você quer manter para a tela e remova-as do ambiente.",
      );
    }
  }
  return parsed.data;
}
