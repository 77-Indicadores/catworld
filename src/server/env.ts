import { z } from "zod";

const schema = z.object({
  CATWORLD_DATABASE_URL: z.string().min(1),
  CATWORLD_ENCRYPTION_KEY: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  CATWORLD_UPLOAD_DIR: z.string().default("./var/uploads"),
  CATWORLD_WORKER_ID: z.string().default("worker-1"),
  CATWORLD_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(1),
  CATWORLD_JOB_POLL_MS: z.coerce.number().int().positive().default(2000),
  CATWORLD_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),
  CATWORLD_AZURE_BLOB_CONNECTION_STRING: z.string().optional(),
  CATWORLD_AZURE_BLOB_CONTAINER: z.string().default("catworld-uploads"),
  // Pausa entre batches de import (ms). Reduz pico de DTU sem mudar throughput médio.
  // 0 = máxima velocidade; 200-500 = modo gentil (recomendado para S0/S1)
  CATWORLD_IMPORT_BATCH_DELAY_MS: z.coerce.number().int().min(0).default(200),
  CATWORLD_MAX_HEAVY_JOBS: z.coerce.number().int().min(1).max(20).default(2),
  // Filtra quais tipos de job este worker processa. Ex: "SOURCE_REFRESH" ou "PREVIEW_UPLOAD,IMPORT_UPLOAD".
  // Vazio/ausente = processa todos os tipos.
  CATWORLD_WORKER_JOB_TYPES: z.string().optional(),
  CATWORLD_PUBLIC_ORIGIN: z.string().url().optional(),
});

export function env() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Configuração inválida: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}