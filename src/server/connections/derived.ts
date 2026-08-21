import { randomUUID } from "crypto";
import { prisma } from "@/server/db";
import { getStoragePool } from "@/server/storage/pool";
import { getStorageConnection } from "@/server/storage/connection";
import { nextRefreshFromCron } from "./sources";

function advisoryLockKey(id: string): bigint {
  return BigInt("0x" + id.replace(/-/g, "").slice(0, 15));
}

function stagingName(sqlName: string) {
  const safe = sqlName.slice(0, 28).replace(/[^a-z0-9_]/g, "_");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `__drv_${safe}_${suffix}`;
}

export async function queueDerivedRefresh(derivedTableId: string) {
  const lockKey = advisoryLockKey(derivedTableId);
  await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock(${lockKey})`);
  try {
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
        data: { type: "DERIVED_REFRESH", payloadJson: JSON.stringify({ derivedTableId }), maxAttempts: 2, weight: 2 },
      }),
      prisma.derivedTable.update({ where: { id: derivedTableId }, data: { lastStatus: "queued", lastError: null } }),
    ]);
    return job;
  } finally {
    await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock(${lockKey})`).catch(() => {});
  }
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
    // Cria tabela staging como resultado do querySql (sintaxe depende do provider)
    if (conn.provider === "sqlserver") {
      const qSchema = `[${schema}]`;
      const qStaging = `${qSchema}.[${staging}]`;
      const pool = await (conn as import("@/server/storage/mssql-storage").MssqlStorageConnection).rawPool();
      await pool.request().query(`SELECT * INTO ${qStaging} FROM (${dt.querySql}) AS _drv`);
    } else {
      const { pgQuote } = await import("@/server/storage/pg-storage");
      await conn.createSchemaIfNotExists(schema);
      const qStaging = `${pgQuote(schema)}.${pgQuote(staging)}`;
      await conn.execute(`CREATE TABLE ${qStaging} AS SELECT * FROM (${dt.querySql}) AS _drv`);
    }

    const rowCount = Number(await conn.countRows(schema, staging));

    // Lê colunas da staging para atualizar metadados
    const cols = await conn.listColumns(schema, staging);

    // Substitui target pela staging atomicamente
    await conn.dropTableIfExists(schema, dt.sqlName);
    await conn.renameTable(schema, staging, dt.sqlName);

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
    throw e;
  }
}
