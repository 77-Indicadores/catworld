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
  // XLSX e sempre lido inteiro em memoria (ExcelJS Workbook, sem streaming — ver nota em
  // parser.ts sobre o bug do WorkbookReader streaming). Limite bem mais baixo que o CSV
  // (que e 100% streamed via DuckDB/csv-parse) pra conter o risco de OOM.
  // 100MB (valor antigo) se mostrou perigoso demais em producao: um xlsx de so 28MB ja
  // consumiu +1GB de RSS num unico job (~35x o tamanho do arquivo, medido via
  // cw_job_metrics) — o container acaba morto pelo OOM killer do host, sem log de erro
  // da aplicacao ("exited" misterioso). 40MB no pior caso fica em ~1.4GB por job, e o
  // gate de heavy job (ver XLSX_HEAVY_THRESHOLD em uploads/actions.ts) ja limita xlsx
  // grande a 1 job concorrente.
  CATWORLD_XLSX_MAX_BYTES: z.coerce.number().int().positive().default(40 * 1024 * 1024),
  // Teto de memoria por instancia DuckDB (uma instancia ":memory:" por import/preview
  // de CSV — ver parser-duckdb.ts). Sem isso, uma instancia pode tentar usar uma fatia
  // grande da RAM do host sem limite. Formato aceito pelo proprio DuckDB (ex: "1GB").
  CATWORLD_DUCKDB_MEMORY_LIMIT: z.string().default("1GB"),
  // Pausa entre batches de import (ms). Reduz pico de DTU sem mudar throughput médio.
  // 0 = máxima velocidade; 200-500 = modo gentil (recomendado para S0/S1)
  CATWORLD_IMPORT_BATCH_DELAY_MS: z.coerce.number().int().min(0).default(200),
  CATWORLD_MAX_HEAVY_JOBS: z.coerce.number().int().min(1).max(20).default(2),
  // Máximo de SOURCE_REFRESH simultâneos por storageServerId.
  // Evita saturar o pool de conexões de um único storage com muitos syncs paralelos.
  CATWORLD_MAX_SYNCS_PER_STORAGE: z.coerce.number().int().min(1).max(20).default(3),
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