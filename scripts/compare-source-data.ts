import fs from "node:fs";
import { createDecipheriv } from "node:crypto";
import pg from "pg";
import { PrismaClient } from "@prisma/client";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2]!;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]!] = v;
}

const prisma = new PrismaClient();

function decryptSecret(value: string) {
  const [ivRaw, tagRaw, dataRaw] = value.split(".");
  const key = Buffer.from(process.env.CATWORLD_ENCRYPTION_KEY!, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw!, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw!, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw!, "base64url")), decipher.final()]).toString("utf8");
}

function quotePg(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteMssql(value: string) {
  return `[${value.replaceAll("]", "]]")}]`;
}

function sourceExpr(column: { originalName: string; sqlName: string; sqlType: string }) {
  const col = quotePg(column.originalName);
  if (column.sqlType === "DATE" || column.sqlType === "DATETIME2") {
    return `CASE WHEN ${col} IS NULL OR EXTRACT(YEAR FROM ${col}) < 1753 OR EXTRACT(YEAR FROM ${col}) > 9999 THEN '' ELSE ${col}::text END`;
  }
  if (column.sqlType === "BIGINT") {
    return `CASE WHEN ${col} IS NULL OR ${col} < -9223372036854775808::numeric OR ${col} > 9223372036854775807::numeric THEN '' ELSE ${col}::text END`;
  }
  if (column.sqlType.startsWith("DECIMAL")) {
    return `CASE WHEN ${col} IS NULL OR abs(${col}) >= 1e14 THEN '' ELSE round(${col}::numeric, 4)::text END`;
  }
  return `COALESCE(${col}::text, '')`;
}

function targetExpr(column: { sqlName: string; sqlType: string }) {
  const col = quoteMssql(column.sqlName);
  if (column.sqlType === "DATE") return `COALESCE(CONVERT(nvarchar(max), ${col}, 23), N'')`;
  if (column.sqlType === "DATETIME2") return `COALESCE(CONVERT(nvarchar(max), ${col}, 127), N'')`;
  if (column.sqlType === "TIME") return `COALESCE(CONVERT(nvarchar(max), ${col}, 114), N'')`;
  if (column.sqlType.startsWith("DECIMAL")) return `COALESCE(CONVERT(nvarchar(max), CONVERT(decimal(18,4), ${col})), N'')`;
  return `COALESCE(CONVERT(nvarchar(max), ${col}), N'')`;
}

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) {
    console.error("Usage: tsx scripts/compare-source-data.ts <sourceId> [sourceId...]");
    process.exit(1);
  }

  for (const id of ids) {
    const source = await prisma.datasetSource.findUnique({
      where: { id },
      include: { connection: true, targetTable: { include: { dataset: true, columns: { orderBy: { ordinal: "asc" } } } } },
    });
    if (!source?.targetTable || source.connection.provider !== "postgres") {
      console.log(JSON.stringify({ id, status: "skipped", reason: "only postgres table sources supported" }));
      continue;
    }

    const columns = source.targetTable.columns;
    const sourceConcat = columns.map(c => sourceExpr(c)).join(` || '|' || `);
    const targetConcat = columns.map(c => targetExpr(c)).join(` + N'|' + `);
    const { password } = JSON.parse(decryptSecret(source.connection.encryptedCredentials)) as { password: string };
    const client = new pg.Client({
      host: source.connection.server,
      port: source.connection.port ?? 5432,
      database: source.connection.databaseName,
      user: source.connection.username,
      password,
      ssl: source.connection.sslMode === "disable" ? false : { rejectUnauthorized: source.connection.sslMode === "verify-full" },
      connectionTimeoutMillis: 10000,
      statement_timeout: 120000,
    });
    await client.connect();
    try {
      const src = await client.query(
        `SELECT COUNT(*)::text AS n, md5(string_agg(md5(${sourceConcat}), '' ORDER BY md5(${sourceConcat}))) AS hash FROM ${quotePg(source.sourceSchema!)}.${quotePg(source.sourceTable!)}`,
      );
      const tgt = await prisma.$queryRawUnsafe<{ n: bigint; hash: string | null }[]>(
        `SELECT COUNT_BIG(*) n, CONVERT(varchar(32), HASHBYTES('MD5', STRING_AGG(CONVERT(varchar(max), HASHBYTES('MD5', ${targetConcat}), 2), '') WITHIN GROUP (ORDER BY CONVERT(varchar(max), HASHBYTES('MD5', ${targetConcat}), 2))), 2) hash FROM ${quoteMssql(source.targetTable.dataset.schemaName)}.${quoteMssql(source.targetTable.sqlName)}`,
      );
      console.log(JSON.stringify({
        id,
        name: source.name,
        source: `${source.connection.name}.${source.sourceSchema}.${source.sourceTable}`,
        sourceCount: src.rows[0]?.n,
        targetCount: tgt[0]?.n.toString(),
        sourceHash: src.rows[0]?.hash,
        targetHash: tgt[0]?.hash?.toLowerCase() ?? null,
        equal: src.rows[0]?.n === tgt[0]?.n.toString() && src.rows[0]?.hash === tgt[0]?.hash?.toLowerCase(),
      }));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
