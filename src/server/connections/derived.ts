import { randomUUID } from "crypto";
import { prisma } from "@/server/db";
import { withAdvisoryLock } from "@/server/db/advisory-lock";
import { getStorageConnection } from "@/server/storage/connection";
import { validateReadOnlySql } from "@/server/security/sql-safety";
import { contractTranslate } from "@/server/sql-contract/apply";
import { ApiError } from "@/server/http";
import { nextRefreshFromCron } from "./sources";
import { evaluateLoad, getIntegritySettings, IntegrityError } from "@/server/integrity/policy";

/** Contrato de SQL: a derivada e escrita em T-SQL, validada como read-only e traduzida por backend. */
export async function prepareDerivedSql(querySql: string, provider: string): Promise<string> {
  const v = validateReadOnlySql(querySql);
  if (!v.safe) throw new ApiError(400, "UNSAFE_SQL", v.reason);
  if (provider === "sqlserver") return v.statement;
  const { sql, topLimit } = await contractTranslate(v.statement, "postgres", "derived", "passthrough");
  return topLimit !== null ? `${sql} LIMIT ${topLimit}` : sql;
}

function stagingName(sqlName: string) {
  const safe = sqlName.slice(0, 28).replace(/[^a-z0-9_]/g, "_");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `__drv_${safe}_${suffix}`;
}

export async function queueDerivedRefresh(derivedTableId: string) {
  return withAdvisoryLock(derivedTableId, async () => {
    const existing = await prisma.job.findFirst({
      where: {
        type: "DERIVED_REFRESH",
        status: { in: ["QUEUED", "RUNNING"] },
        payloadJson: JSON.stringify({ derivedTableId }),
      },
    });
    if (existing) {
      if (existing.status === "QUEUED") {
        await prisma.derivedTable.update({ where: { id: derivedTableId }, data: { lastStatus: "queued", lastError: null } });
      }
      return existing;
    }
    const [job] = await prisma.$transaction([
      prisma.job.create({
        // weight 2 (unbounded) sempre: diferente de SOURCE_REFRESH, tabela derivada
        // não tem noção de janela/delta — é sempre um SELECT/CREATE TABLE AS completo
        // a partir do querySql, então nunca há um caminho "bounded" disponível pra
        // ela (ver isBoundedSourceRun em sources.ts para o mesmo princípio aplicado
        // a fontes, onde ele às vezes resulta em bounded).
        data: { type: "DERIVED_REFRESH", payloadJson: JSON.stringify({ derivedTableId }), maxAttempts: 2, weight: 2 },
      }),
      prisma.derivedTable.update({ where: { id: derivedTableId }, data: { lastStatus: "queued", lastError: null } }),
    ]);
    return job;
  });
}

export async function enqueueDueDerivedRefreshes() {
  const due = await prisma.derivedTable.findMany({
    where: { active: true, refreshCron: { not: null }, nextRefreshAt: { lte: new Date() } },
    select: { id: true },
    take: 20,
  });
  for (const dt of due) await queueDerivedRefresh(dt.id);
}

export async function refreshDerivedTable(derivedTableId: string) {
  const dt = await prisma.derivedTable.findUniqueOrThrow({
    where: { id: derivedTableId },
    include: { dataset: true },
  });

  const conn = await getStorageConnection(dt.dataset.storageServerId);
  const schema = dt.dataset.schemaName;
  const staging = stagingName(dt.sqlName);

  await prisma.derivedTable.update({ where: { id: derivedTableId }, data: { lastStatus: "running" } });

  try {
    const querySql = await prepareDerivedSql(dt.querySql, conn.provider);
    // Cria tabela staging como resultado do querySql (sintaxe depende do provider)
    if (conn.provider === "sqlserver") {
      const qSchema = `[${schema}]`;
      const qStaging = `${qSchema}.[${staging}]`;
      const pool = await (conn as import("@/server/storage/mssql-storage").MssqlStorageConnection).rawPool();
      await pool.request().query(`SELECT * INTO ${qStaging} FROM (${querySql}) AS _drv`);
    } else {
      const { pgQuote } = await import("@/server/storage/pg-storage");
      await conn.createSchemaIfNotExists(schema);
      const qStaging = `${pgQuote(schema)}.${pgQuote(staging)}`;
      await conn.execute(`CREATE TABLE ${qStaging} AS SELECT * FROM (${querySql}) AS _drv`);
    }

    const rowCount = Number(await conn.countRows(schema, staging));

    // Guarda de integridade (mesma politica das fontes): 0 linhas ou queda grande contra a versao anterior NAO troca a
    // tabela (a anterior continua no ar) e a derivada fica com status de erro visivel.
    const evaluation = evaluateLoad(
      { kind: "derived", fullState: true, parsedRows: rowCount, prevRows: Number(dt.lastRowCount ?? 0n), scheduled: true },
      await getIntegritySettings(),
    );
    if (evaluation.verdict === "FAILED") throw new IntegrityError(evaluation);

    // Lê colunas da staging para atualizar metadados
    const cols = await conn.listColumns(schema, staging);

    // Troca ATOMICA (uma transacao): leitores nunca veem a tabela ausente e uma queda no meio nao a apaga.
    await swapDerived(conn, schema, staging, dt.sqlName);

    const now = new Date();

    let tableRecord = await prisma.datasetTable.findFirst({
      where: { datasetId: dt.datasetId, sqlName: dt.sqlName },
    });

    if (!tableRecord) {
      tableRecord = await prisma.datasetTable.create({
        data: { datasetId: dt.datasetId, name: dt.name, sqlName: dt.sqlName, rowCount: BigInt(rowCount), lastDataAt: now },
      });
      await prisma.derivedTable.update({ where: { id: derivedTableId }, data: { targetTableId: tableRecord.id } });
    } else {
      await prisma.datasetTable.update({
        where: { id: tableRecord.id },
        data: { rowCount: BigInt(rowCount), lastDataAt: now },
      });
      if (!dt.targetTableId) {
        await prisma.derivedTable.update({ where: { id: derivedTableId }, data: { targetTableId: tableRecord.id } });
      }
    }

    await prisma.datasetColumn.deleteMany({ where: { tableId: tableRecord.id } });
    await prisma.datasetColumn.createMany({
      data: cols.map((c, i) => ({
        tableId: tableRecord!.id,
        ordinal: i + 1,
        originalName: c.name,
        sqlName: c.name,
        sqlType: c.sqlType,
        nullable: true,
      })),
    });

    await prisma.derivedTable.update({
      where: { id: derivedTableId },
      data: {
        lastStatus: "ok",
        lastRowCount: BigInt(rowCount),
        lastError: null,
        lastRefreshedAt: now,
        nextRefreshAt: nextRefreshFromCron(dt.refreshCron),
      },
    });

    console.log("[derived] %s → %d linhas", dt.sqlName, rowCount);
  } catch (e) {
    await conn.dropTableIfExists(schema, staging).catch(() => {});
    // Antes uma falha deixava lastStatus "running" para sempre. A tabela anterior continua no ar.
    await prisma.derivedTable.update({
      where: { id: derivedTableId },
      data: { lastStatus: "failed", lastError: (e instanceof Error ? e.message : String(e)).slice(0, 1000) },
    }).catch(() => {});
    throw e;
  }
}

/** DROP do destino + RENAME da staging na MESMA transacao (Postgres: multi-statement e uma transacao implicita; SQL Server: BEGIN TRAN). */
async function swapDerived(conn: Awaited<ReturnType<typeof getStorageConnection>>, schema: string, staging: string, target: string): Promise<void> {
  if (conn.provider === "sqlserver") {
    const q = (x: string) => x.replace(/'/g, "''");
    const pool = await (conn as import("@/server/storage/mssql-storage").MssqlStorageConnection).rawPool();
    await pool.request().query(
      `SET XACT_ABORT ON; BEGIN TRAN;
       IF OBJECT_ID(N'[${q(schema)}].[${q(target)}]', N'U') IS NOT NULL DROP TABLE [${q(schema)}].[${q(target)}];
       EXEC sp_rename N'${q(schema)}.${q(staging)}', N'${q(target)}';
       COMMIT;`,
    );
    return;
  }
  const { pgQuote } = await import("@/server/storage/pg-storage");
  await conn.execute(`DROP TABLE IF EXISTS ${pgQuote(schema)}.${pgQuote(target)}; ALTER TABLE ${pgQuote(schema)}.${pgQuote(staging)} RENAME TO ${pgQuote(target)}`);
}
