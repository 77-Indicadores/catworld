import fs from "node:fs";
import { createDecipheriv } from "node:crypto";
import pg from "pg";
import sql from "mssql";
import { PrismaClient } from "@prisma/client";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2]!;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]!] = v;
}

type AuditRow = {
  id: string;
  connection: string;
  provider: string;
  source: string;
  target: string;
  sourceCount: string | null;
  materializedCount: string | null;
  catalogCount: string | null;
  status: "ok" | "diff" | "error";
  error?: string;
};

const prisma = new PrismaClient();
const pgClients = new Map<string, pg.Client>();
const mssqlPools = new Map<string, sql.ConnectionPool>();

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

async function postgresCount(connection: SourceConnection, schema: string, table: string) {
  let client = pgClients.get(connection.name);
  if (!client) {
    const { password } = JSON.parse(decryptSecret(connection.encryptedCredentials)) as { password: string };
    client = new pg.Client({
      host: connection.server,
      port: connection.port ?? 5432,
      database: connection.databaseName,
      user: connection.username,
      password,
      ssl: connection.sslMode === "disable" ? false : { rejectUnauthorized: connection.sslMode === "verify-full" },
      connectionTimeoutMillis: 10000,
      statement_timeout: 120000,
    });
    await client.connect();
    pgClients.set(connection.name, client);
  }
  const result = await client.query(`SELECT COUNT(*)::text AS n FROM ${quotePg(schema)}.${quotePg(table)}`);
  return String(result.rows[0]?.n ?? "");
}

async function mssqlCount(connection: SourceConnection, schema: string, table: string) {
  let pool = mssqlPools.get(connection.name);
  if (!pool) {
    const { password } = JSON.parse(decryptSecret(connection.encryptedCredentials)) as { password: string };
    pool = new sql.ConnectionPool({
      server: connection.server,
      port: connection.port ?? 1433,
      database: connection.databaseName,
      user: connection.username,
      password,
      options: {
        encrypt: !connection.sslMode.startsWith("no-"),
        trustServerCertificate: connection.sslMode.includes("trust"),
      },
      connectionTimeout: 10000,
      requestTimeout: 120000,
    });
    await pool.connect();
    mssqlPools.set(connection.name, pool);
  }
  const result = await pool.request().query(`SELECT COUNT_BIG(*) n FROM ${quoteMssql(schema)}.${quoteMssql(table)}`);
  return String(result.recordset[0]?.n ?? "");
}

type SourceConnection = {
  name: string;
  provider: string;
  server: string;
  port: number | null;
  databaseName: string;
  username: string;
  encryptedCredentials: string;
  sslMode: string;
};

async function main() {
  const sources = await prisma.datasetSource.findMany({
    where: { mode: "extract", sourceKind: "table", active: true },
    include: { connection: true, targetTable: { include: { dataset: true } } },
    orderBy: [{ connectionId: "asc" }, { sourceSchema: "asc" }, { sourceTable: "asc" }],
  });

  const rows: AuditRow[] = [];
  for (const source of sources) {
    const target = source.targetTable;
    if (!target || !source.sourceSchema || !source.sourceTable) continue;
    const row: AuditRow = {
      id: source.id,
      connection: source.connection.name,
      provider: source.connection.provider,
      source: `${source.sourceSchema}.${source.sourceTable}`,
      target: `${target.dataset.schemaName}.${target.sqlName}`,
      sourceCount: null,
      materializedCount: null,
      catalogCount: target.rowCount.toString(),
      status: "ok",
    };
    try {
      row.sourceCount = source.connection.provider === "mssql"
        ? await mssqlCount(source.connection, source.sourceSchema, source.sourceTable)
        : await postgresCount(source.connection, source.sourceSchema, source.sourceTable);
      const local = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT_BIG(*) n FROM ${quoteMssql(target.dataset.schemaName)}.${quoteMssql(target.sqlName)}`,
      );
      row.materializedCount = local[0]?.n.toString() ?? null;
      if (row.sourceCount !== row.materializedCount || row.catalogCount !== row.materializedCount) row.status = "diff";
    } catch (e) {
      row.status = "error";
      row.error = e instanceof Error ? e.message : String(e);
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const summary = {
    total: rows.length,
    ok: rows.filter(r => r.status === "ok").length,
    diff: rows.filter(r => r.status === "diff").length,
    error: rows.filter(r => r.status === "error").length,
    diffs: rows.filter(r => r.status === "diff"),
    errors: rows.filter(r => r.status === "error"),
  };
  console.error(JSON.stringify(summary, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([...pgClients.values()].map(client => client.end().catch(() => undefined)));
    await Promise.all([...mssqlPools.values()].map(pool => pool.close().catch(() => undefined)));
    await prisma.$disconnect();
  });
