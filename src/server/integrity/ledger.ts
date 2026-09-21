/**
 * Livro de integridade das cargas (cw_load_ledger): uma linha por TENTATIVA de carga, com o esperado, o lido, o gravado, o anterior e o
 * veredito (docs/estudo-confiabilidade-dados.md, seção 6). É a evidência que faltava: a auditoria guardava os fatos e marcava sucesso.
 *
 * Escrito por SQL direto (não depende do Prisma client regenerado) e NUNCA derruba uma carga: `recordLedger` engole e loga qualquer erro;
 * `ledgerInsert` devolve um PrismaPromise para entrar na transação que já publica a carga (mesma atomicidade dos metadados).
 */
import { prisma } from "@/server/db";
import type { Evaluation, Verdict } from "./policy";

export type LedgerEntry = {
  kind: "upload" | "source" | "derived";
  outcome: "COMPLETED" | "FAILED";
  verdict: Verdict;
  datasetId?: string | null;
  tableId?: string | null;
  uploadId?: string | null;
  sourceId?: string | null;
  jobId?: string | null;
  tableName?: string | null;
  mode?: string | null;
  attempt?: number | null;
  expectedRows?: number | null;
  parsedRows?: number | null;
  physicalRows?: number | null;
  prevRows?: number | null;
  /** motivos do veredito + qualquer detalhe estruturado (parser usado, retentativa, tempos) */
  detail?: Record<string, unknown>;
};

const big = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : BigInt(Math.trunc(n)));

/** Detalhe padrão a partir de uma avaliação de integridade. */
export function evaluationDetail(e: Evaluation | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(e ? { reasons: e.reasons } : {}), ...extra };
}

/** INSERT para compor `prisma.$transaction([...])` junto com os metadados da carga. */
export function ledgerInsert(e: LedgerEntry) {
  return prisma.$executeRaw`
    INSERT INTO cw_load_ledger (kind, dataset_id, table_id, upload_id, source_id, job_id, table_name, mode, attempt, outcome, verdict,
                                expected_rows, parsed_rows, physical_rows, prev_rows, detail_json)
    VALUES (${e.kind}, ${e.datasetId ?? null}::uuid, ${e.tableId ?? null}::uuid, ${e.uploadId ?? null}::uuid, ${e.sourceId ?? null}::uuid,
            ${e.jobId ?? null}::uuid, ${e.tableName ?? null}, ${e.mode ?? null}, ${e.attempt ?? null}, ${e.outcome}, ${e.verdict},
            ${big(e.expectedRows)}, ${big(e.parsedRows)}, ${big(e.physicalRows)}, ${big(e.prevRows)},
            ${e.detail ? JSON.stringify(e.detail).slice(0, 8000) : null})
  `;
}

/** Grava fora de transação; nunca lança. */
export async function recordLedger(e: LedgerEntry): Promise<void> {
  try {
    await ledgerInsert(e);
  } catch (err) {
    console.error("[ledger] falha ao gravar (a carga não é afetada): %s", err instanceof Error ? err.message : String(err));
  }
}

/** Evento de auditoria para uma carga barrada ou suspeita (success=false: aparece nos filtros de falha). */
export async function auditIntegrity(e: LedgerEntry & { resourceId: string }): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        eventType: "DATA_INTEGRITY_SUSPECT",
        resourceType: e.kind,
        resourceId: e.resourceId,
        detailJson: JSON.stringify({ verdict: e.verdict, outcome: e.outcome, datasetId: e.datasetId, table: e.tableName, expected: e.expectedRows, parsed: e.parsedRows, prev: e.prevRows, ...e.detail }).slice(0, 8000),
        success: false,
      },
    });
  } catch (err) {
    console.error("[ledger] falha ao gravar o evento de auditoria: %s", err instanceof Error ? err.message : String(err));
  }
}

export type IntegritySummary = {
  windowHours: number;
  loads: number;
  failed: number;
  suspect: number;
  /** tabelas cujo ÚLTIMO veredito não foi OK */
  tablesNeedingAttention: { tableId: string | null; tableName: string | null; verdict: string; lastAt: string; expectedRows: number | null; parsedRows: number | null }[];
};

/** Resumo para o endpoint de saúde e o dashboard. */
export async function summarizeIntegrity(windowHours = 24): Promise<IntegritySummary> {
  const counts = await prisma.$queryRaw<{ verdict: string; outcome: string; n: bigint }[]>`
    SELECT verdict, outcome, COUNT(*) AS n FROM cw_load_ledger WHERE created_at > now() - (${windowHours}::text || ' hours')::interval GROUP BY 1, 2`;
  const last = await prisma.$queryRaw<{ table_id: string | null; table_name: string | null; verdict: string; created_at: Date; expected_rows: bigint | null; parsed_rows: bigint | null }[]>`
    SELECT DISTINCT ON (COALESCE(table_id::text, table_name)) table_id, table_name, verdict, created_at, expected_rows, parsed_rows
    FROM cw_load_ledger WHERE created_at > now() - interval '7 days'
    ORDER BY COALESCE(table_id::text, table_name), created_at DESC`;
  const n = (v: string, o?: string) => counts.filter((c) => c.verdict === v && (!o || c.outcome === o)).reduce((s, c) => s + Number(c.n), 0);
  return {
    windowHours,
    loads: counts.reduce((s, c) => s + Number(c.n), 0),
    failed: counts.filter((c) => c.outcome === "FAILED").reduce((s, c) => s + Number(c.n), 0),
    suspect: n("SUSPECT"),
    tablesNeedingAttention: last.filter((r) => r.verdict !== "OK").map((r) => ({
      tableId: r.table_id, tableName: r.table_name, verdict: r.verdict, lastAt: r.created_at.toISOString(),
      expectedRows: r.expected_rows === null ? null : Number(r.expected_rows), parsedRows: r.parsed_rows === null ? null : Number(r.parsed_rows),
    })),
  };
}
