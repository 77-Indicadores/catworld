import { z } from "zod";

const schema = z.object({
  CATWORLD_DATABASE_URL: z.string().min(1),
  CATWORLD_ENCRYPTION_KEY: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  CATWORLD_UPLOAD_DIR: z.string().default("./var/uploads"),
  CATWORLD_WORKER_ID: z.string().default("worker-1"),
  CATWORLD_JOB_POLL_MS: z.coerce.number().int().positive().default(2000),
  CATWORLD_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),
});

export function env() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Configuração inválida: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return parsed.data;
}