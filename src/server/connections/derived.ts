import { randomUUID } from "crypto";
import { prisma } from "@/server/db";
import { getStoragePool } from "@/server/storage/pool";
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

  const pool = await getStoragePool(dt.dataset.storageServerId);
  const schema = dt.dataset.schemaName;
  const qSchema = `[${schema}]`;
  const staging = stagingName(dt.sqlName);
  const qStaging = `${qSchema}.[${staging}]`;
  const qTarget = `${qSchema}.[${dt.sqlName}]`;

  await prisma.derivedTable.update({ where: { id: derivedTableId }, data: { lastStatus: "running" } });

  try {
    await pool.request().query(
      `SELECT * INTO ${qStaging} FROM (${dt.querySql}) AS _drv`,
    );

    const countRes = await pool.request().query<{ n: number }>(
      `SELECT COUNT_BIG(*) AS n FROM ${qStaging}`,
    );
    const rowCount = Number((countRes.recordset[0] as { n: number }).n);

    const colsRes = await pool.request().query<{
      COLUMN_NAME: string;
      DATA_TYPE: string;
      CHARACTER_MAXIMUM_LENGTH: number | null;
    }>(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA=N'${schema}' AND TABLE_NAME=N'${staging}'
       ORDER BY ORDINAL_POSITION`,
    );
    const cols = colsRes.recordset as { COLUMN_NAME: string; DATA_TYPE: string; CHARACTER_MAXIMUM_LENGTH: number | null }[];

    // Drop existing target and rename staging into its place
    await pool.request().query(
      `IF OBJECT_ID(N'${schema}.${dt.sqlName}', N'U') IS NOT NULL DROP TABLE ${qTarget}`,
    );
    await pool.request().query(
      `EXEC sp_rename N'${schema}.${staging}', N'${dt.sqlName}'`,
    );

    const now = new Date();

    // Find or create the cw_tables record
    let tableRecord = await prisma.datasetTable.findFirst({
      where: { datasetId: dt.datasetId, sqlName: dt.sqlName },
    });

    if (!tableRecord) {
      tableRecord = await prisma.datasetTable.create({
        data: {
          datasetId: dt.datasetId,
          name: dt.name,
          sqlName: dt.sqlName,
          rowCount: BigInt(rowCount),
          lastDataAt: now,
        },
      });
      await prisma.derivedTable.update({
        where: { id: derivedTableId },
        data: { targetTableId: tableRecord.id },
      });
    } else {
      await prisma.datasetTable.update({
        where: { id: tableRecord.id },
        data: { rowCount: BigInt(rowCount), lastDataAt: now },
      });
      if (!dt.targetTableId) {
        await prisma.derivedTable.update({
          where: { id: derivedTableId },
          data: { targetTableId: tableRecord.id },
        });
      }
    }

    // Refresh column metadata
    await prisma.datasetColumn.deleteMany({ where: { tableId: tableRecord.id } });
    await prisma.datasetColumn.createMany({
      data: cols.map((c, i) => ({
        tableId: tableRecord!.id,
        ordinal: i + 1,
        originalName: c.COLUMN_NAME,
        sqlName: c.COLUMN_NAME,
        sqlType: c.CHARACTER_MAXIMUM_LENGTH != null && c.CHARACTER_MAXIMUM_LENGTH > 0
          ? `${c.DATA_TYPE}(${c.CHARACTER_MAXIMUM_LENGTH})`
          : c.DATA_TYPE,
        nullable: true,
      })),
    });

    const nextRefreshAt = nextRefreshFromCron(dt.refreshCron);
    await prisma.derivedTable.update({
      where: { id: derivedTableId },
      data: {
        lastStatus: "ok",
        lastRowCount: BigInt(rowCount),
        lastError: null,
        lastRefreshedAt: now,
        nextRefreshAt,
      },
    });

    console.log("[derived] %s → %d linhas", dt.sqlName, rowCount);
  } catch (e) {
    // Clean up orphaned staging table
    await pool.request()
      .query(`IF OBJECT_ID(N'${schema}.${staging}', N'U') IS NOT NULL DROP TABLE ${qStaging}`)
      .catch(() => {});
    throw e;
  }
}
