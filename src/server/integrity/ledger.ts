/**
 * Livro de integridade das cargas (cw_load_ledger): uma linha por TENTATIVA de carga, com o esperado, o lido, o gravado, o anterior e o
 * veredito (docs/estudo-confiabilidade-dados.md, seção 6). É a evidência que faltava: a auditoria guardava os fatos e marcava sucesso.
 *
 * Escrito por SQL direto (não depende do Prisma client regenerado) e NUNCA derruba uma carga: `recordLedger` engole e loga qualquer erro;
 * `ledgerInsert` devolve um PrismaPromise para entrar na transação que já publica a carga (mesma atomicidade dos metadados).
 */
import { prisma } from "@/server/db";
import type { Evaluation, Verdict } from "./policy";

/**
 * `ERROR` = a tentativa falhou por causa TRANSITORIA/operacional (rede, timeout, 409 de estrutura, trava perdida) e a tabela anterior
 * segue intacta: nao e problema de integridade e nao entra em "precisa de atencao". `FAILED` e so a barra de integridade
 * (IntegrityError); `SUSPECT` = publicada, mas possivelmente incompleta.
 */
export type LedgerVerdict = Verdict | "ERROR";

export type LedgerEntry = {
  kind: "upload" | "source" | "derived";
  outcome: "COMPLETED" | "FAILED";
  verdict: LedgerVerdict;
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

/** Primeiro motivo legível do veredito (para o selo do dashboard). */
function firstReason(detailJson: string | null): string | null {
  if (!detailJson) return null;
  try {
    const d = JSON.parse(detailJson) as { reasons?: { message?: string }[]; error?: string };
    return d.reasons?.[0]?.message ?? d.error ?? null;
  } catch { return null; }
}

/** Retencao do livro (dias): sem ela a tabela cresce sem limite e o resumo varre tudo. */
export const LEDGER_RETENTION_DAYS = 90;

/**
 * Apaga entradas com mais de `days` dias, em lotes curtos (um DELETE unico de milhoes de linhas segura locks e gera pico de WAL; ver
 * db/batched-delete.ts, que so aceita cw_audit_events/cw_jobs — por isso o mesmo padrao vive aqui). Chamar da rotina de retencao
 * dos metadados (worker), uma vez por ciclo: `await purgeLedger()`.
 */
export async function purgeLedger(days = LEDGER_RETENTION_DAYS, batch = 20_000, maxBatches = 500): Promise<number> {
  const size = Math.max(1, Math.floor(batch));
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM cw_load_ledger WHERE ctid IN (SELECT ctid FROM cw_load_ledger WHERE created_at < now() - ($1::text || ' days')::interval LIMIT ${size})`,
      String(Math.max(1, Math.floor(days))),
    );
    total += n;
    if (n < size) break;
  }
  return total;
}

export type IntegritySummary = {
  windowHours: number;
  loads: number;
  failed: number;
  suspect: number;
  /** tabelas cujo ÚLTIMO veredito não foi OK */
  tablesNeedingAttention: { mode?: string | null; tableId: string | null; tableName: string | null; verdict: string; lastAt: string; expectedRows: number | null; parsedRows: number | null; reason: string | null }[];
};

/**
 * Resumo para o endpoint de saúde e o dashboard.
 *
 * "Precisa de atenção" = o ÚLTIMO veredito, por (tabela, tipo de rodada: reconciliação x demais), é SUSPECT ou uma barra de integridade
 * (FAILED com motivos estruturados). Falha transitória (`ERROR`, ou FAILED só com `error`: rede, timeout, 409) NÃO conta: a tabela
 * anterior está intacta. Uma reconciliação barrada não é mascarada por um incremental OK depois: só uma reconciliação bem-sucedida a
 * limpa. Ficam de fora tabelas que não existem mais, cuja fonte foi apagada, ou cujas origens estão todas pausadas/inativas (nada mais
 * vai carregar para limpar o alerta).
 */
export async function summarizeIntegrity(windowHours = 24): Promise<IntegritySummary> {
  const counts = await prisma.$queryRaw<{ verdict: string; outcome: string; n: bigint }[]>`
    SELECT verdict, outcome, COUNT(*) AS n FROM cw_load_ledger WHERE created_at > now() - (${windowHours}::text || ' hours')::interval GROUP BY 1, 2`;
  type Row = { table_id: string | null; table_name: string | null; mode: string | null; verdict: string; created_at: Date; expected_rows: bigint | null; parsed_rows: bigint | null; detail_json: string | null };
  const last = await prisma.$queryRaw<Row[]>`
    WITH last AS (
      SELECT DISTINCT ON (l.dataset_id, l.table_name, (COALESCE(l.mode, '') = 'reconciliation'))
             l.dataset_id, l.table_id, l.source_id, l.table_name, l.mode, l.verdict, l.created_at, l.expected_rows, l.parsed_rows, l.detail_json
      FROM cw_load_ledger l WHERE l.created_at > now() - interval '7 days' AND l.table_name IS NOT NULL
      ORDER BY l.dataset_id, l.table_name, (COALESCE(l.mode, '') = 'reconciliation'), l.created_at DESC)
    SELECT t.id AS table_id, l.table_name, l.mode, l.verdict, l.created_at, l.expected_rows, l.parsed_rows, l.detail_json
    FROM last l
    JOIN cw_tables t ON t.id = COALESCE(l.table_id, (SELECT t2.id FROM cw_tables t2 WHERE t2.dataset_id = l.dataset_id AND t2.sql_name = l.table_name))
    WHERE (l.verdict = 'SUSPECT' OR (l.verdict = 'FAILED' AND l.detail_json LIKE '%"reasons"%'))
      AND (l.source_id IS NULL OR EXISTS (SELECT 1 FROM cw_dataset_sources s WHERE s.id = l.source_id))
      AND NOT (
        (EXISTS (SELECT 1 FROM cw_dataset_sources s WHERE s.target_table_id = t.id) OR EXISTS (SELECT 1 FROM cw_derived_tables d WHERE d.target_table_id = t.id))
        AND NOT EXISTS (SELECT 1 FROM cw_dataset_sources s WHERE s.target_table_id = t.id AND s.active)
        AND NOT EXISTS (SELECT 1 FROM cw_derived_tables d WHERE d.target_table_id = t.id AND d.active))
    ORDER BY l.created_at DESC`;
  // Uma entrada por tabela (a mais recente entre os tipos de rodada).
  const seen = new Set<string>();
  const attention = last.filter((r) => { const k = r.table_id ?? `${r.table_name}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const n = (v: string, o?: string) => counts.filter((c) => c.verdict === v && (!o || c.outcome === o)).reduce((s, c) => s + Number(c.n), 0);
  return {
    windowHours,
    loads: counts.reduce((s, c) => s + Number(c.n), 0),
    failed: counts.filter((c) => c.outcome === "FAILED").reduce((s, c) => s + Number(c.n), 0),
    suspect: n("SUSPECT"),
    tablesNeedingAttention: attention.map((r) => ({
      mode: r.mode, tableId: r.table_id, tableName: r.table_name, verdict: r.verdict, lastAt: r.created_at.toISOString(),
      expectedRows: r.expected_rows === null ? null : Number(r.expected_rows), parsedRows: r.parsed_rows === null ? null : Number(r.parsed_rows),
      reason: firstReason(r.detail_json),
    })),
  };
}
