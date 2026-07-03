/**
 * Testa BULK INSERT do SQL Server lendo diretamente do Azure Blob.
 * Isso elimina o TDS bulk copy — SQL Server lê o arquivo por conta própria.
 *
 * Se funcionar, a importação de CSV pode ser 3-10x mais rápida.
 */
import { readFileSync, existsSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import sql from "mssql";
import { BlobServiceClient, BlobSASPermissions, StorageSharedKeyCredential, generateBlobSASQueryParameters } from "@azure/storage-blob";

const envPath = resolve(".", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("="); if (sep === -1) continue;
    const key = t.slice(0, sep).trim(); let val = t.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}

function parseSqlUrl(url: string): sql.config {
  const without = url.replace(/^sqlserver:\/\//i, "");
  const [hostPort, ...rest] = without.split(";").filter(Boolean);
  const [server, port] = hostPort!.split(":");
  const params = Object.fromEntries(rest.map(p => { const i = p.indexOf("="); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)]; }));
  return {
    server: server!, port: port ? Number(port) : 1433,
    database: params["database"], user: params["user"], password: params["password"],
    options: { encrypt: params["encrypt"] !== "false", trustServerCertificate: params["trustservercertificate"] === "true", packetSize: 16384 },
    requestTimeout: 600_000, connectionTimeout: 30_000,
    pool: { max: 5, min: 1, idleTimeoutMillis: 30_000 }
  };
}

function generateSas(blobName: string, expiryMs = 30 * 60_000): string {
  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i)!;
  const keyMatch = connStr.match(/AccountKey=([^;]+)/i)!;
  const credential = new StorageSharedKeyCredential(accountMatch[1]!, keyMatch[1]!);
  const expiresOn = new Date(Date.now() + expiryMs);
  return generateBlobSASQueryParameters(
    { containerName: container, blobName, permissions: BlobSASPermissions.parse("r"), expiresOn },
    credential
  ).toString();
}

async function main() {
  const connStr = process.env["CATWORLD_AZURE_BLOB_CONNECTION_STRING"]!;
  const container = process.env["CATWORLD_AZURE_BLOB_CONTAINER"]!;
  const accountMatch = connStr.match(/AccountName=([^;]+)/i)![1]!;

  console.log("\n═══════════════════════════════════════════════");
  console.log("  Teste: BULK INSERT do Azure Blob → Azure SQL");
  console.log("═══════════════════════════════════════════════\n");

  // 1. Cria CSV de teste com 10.000 linhas
  const blobName = `tmp/bulk-test-${Date.now()}.tsv`;
  const testRows = 10_000;
  console.log(`[1/6] Gerando TSV de teste (${testRows.toLocaleString()} linhas)...`);
  const lines: string[] = [];
  for (let i = 0; i < testRows; i++) {
    lines.push([
      i + 1,
      `Nome Teste ${i}`,
      (Math.random() * 99999).toFixed(2),
      new Date(2020, 0, 1 + (i % 365)).toISOString().slice(0, 10),
    ].join("\t"));
  }
  const tsv = lines.join("\n") + "\n";
  console.log(`  ✓ ${(Buffer.byteLength(tsv) / 1024).toFixed(0)} KB gerados`);

  // 2. Upload TSV para blob
  console.log(`[2/6] Upload TSV para blob (${blobName})...`);
  const service = BlobServiceClient.fromConnectionString(connStr);
  const cc = service.getContainerClient(container);
  const blockClient = cc.getBlockBlobClient(blobName);
  const t2 = Date.now();
  await blockClient.upload(tsv, Buffer.byteLength(tsv), { blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" } });
  console.log(`  ✓ Upload em ${Date.now() - t2}ms`);

  // 3. Gera SAS
  console.log(`[3/6] Gerando SAS token (30 min)...`);
  const sasToken = generateSas(blobName, 30 * 60_000);
  console.log(`  ✓ SAS gerado`);

  // 4. Conecta ao SQL e cria tabela de teste
  console.log(`[4/6] Conectando ao Azure SQL...`);
  const pool = await new sql.ConnectionPool(parseSqlUrl(process.env["CATWORLD_DATABASE_URL"]!)).connect();
  const TABLE = `bulk_blob_test_${Date.now()}`;
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.${TABLE}', N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}];
    CREATE TABLE dbo.[${TABLE}] (
      id BIGINT NULL,
      nome NVARCHAR(200) NULL,
      valor DECIMAL(18,2) NULL,
      data DATE NULL
    )
  `);
  console.log(`  ✓ Tabela dbo.${TABLE} criada`);

  // 5. Setup credential e data source, então BULK INSERT
  console.log(`[5/6] Executando BULK INSERT do blob...`);
  const credName = `CatworldBlobCred_${Date.now()}`;
  const dsName = `CatworldBlobDS_${Date.now()}`;
  const blobEndpoint = `https://${accountMatch}.blob.core.windows.net`;

  try {
    await pool.request().query(`
      CREATE DATABASE SCOPED CREDENTIAL [${credName}]
      WITH IDENTITY = 'SHARED ACCESS SIGNATURE', SECRET = '${sasToken}'
    `);
    console.log(`  ✓ Credential criada`);

    await pool.request().query(`
      CREATE EXTERNAL DATA SOURCE [${dsName}]
      WITH (TYPE = BLOB_STORAGE, LOCATION = '${blobEndpoint}', CREDENTIAL = [${credName}])
    `);
    console.log(`  ✓ Data source criada`);

    const t5 = Date.now();
    await pool.request().query(`
      BULK INSERT dbo.[${TABLE}]
      FROM '${container}/${blobName}'
      WITH (
        DATA_SOURCE = '${dsName}',
        FORMAT = 'CSV',
        FIELDTERMINATOR = '\t',
        ROWTERMINATOR = '0x0a',
        FIRSTROW = 1,
        TABLOCK,
        CODEPAGE = '65001'
      )
    `);
    const bulkMs = Date.now() - t5;

    const countResult = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.[${TABLE}]`);
    const n = (countResult.recordset[0] as { n: number }).n;
    const rowsPerSec = Math.round(n / (bulkMs / 1000));
    console.log(`  ✓ BULK INSERT: ${n.toLocaleString()} linhas em ${bulkMs}ms (${rowsPerSec.toLocaleString()} rows/s)`);

    if (n !== testRows) console.error(`  ⚠ Esperava ${testRows}, recebeu ${n}`);
    else console.log(`  ✓ Contagem correta!`);

    // Resultado chave
    console.log(`\n┌─────────────────────────────────────────────────────┐`);
    console.log(`│  RESULTADO BULK INSERT FROM BLOB                    │`);
    console.log(`│                                                     │`);
    console.log(`│  Linhas:     ${String(n.toLocaleString()).padEnd(38)}│`);
    console.log(`│  Tempo:      ${String(bulkMs + "ms").padEnd(38)}│`);
    console.log(`│  Throughput: ${String(rowsPerSec.toLocaleString() + " rows/s").padEnd(38)}│`);
    console.log(`│                                                     │`);
    console.log(`│  vs TDS (benchmark anterior): ~766 rows/s           │`);
    console.log(`│  Speedup estimado: ${String("~" + (rowsPerSec / 766).toFixed(1) + "x").padEnd(32)}│`);
    console.log(`└─────────────────────────────────────────────────────┘\n`);

  } finally {
    // 6. Cleanup
    console.log(`[6/6] Limpando...`);
    await pool.request().query(`IF OBJECT_ID(N'${dsName}') IS NOT NULL DROP EXTERNAL DATA SOURCE [${dsName}]`).catch(() => {});
    await pool.request().query(`IF EXISTS (SELECT * FROM sys.database_scoped_credentials WHERE name = '${credName}') DROP DATABASE SCOPED CREDENTIAL [${credName}]`).catch(() => {});
    await pool.request().query(`IF OBJECT_ID(N'dbo.${TABLE}', N'U') IS NOT NULL DROP TABLE dbo.[${TABLE}]`).catch(() => {});
    await blockClient.delete().catch(() => {});
    await pool.close();
    console.log(`  ✓ Limpeza concluída\n`);
  }
}

void main().catch(e => { console.error("\n❌ Erro:", e.message ?? e); process.exit(1); });
