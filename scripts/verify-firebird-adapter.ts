/**
 * Verificação manual do adapter Firebird (src/server/connections/firebird.ts) contra um servidor real.
 *
 * NÃO é um teste vitest: rodando sob o runner do vitest (qualquer pool/isolamento), o driver `node-firebird`
 * falhou com "Unavailable database" de um jeito que parecia ambiente/bundler — a causa real, isolada depois,
 * era o Git Bash (MSYS) reescrevendo `CW_TEST_FIREBIRD_DATABASE=/caminho/...` para um caminho Windows ANTES do
 * processo receber a env var (ex.: vira `C:/Users/.../Temp/plv-test/...`), então o Firebird (que roda no
 * WSL/Linux) recebia um caminho que não existe. Rode com `MSYS_NO_PATHCONV=1` no Git Bash para a env var chegar
 * intacta (não é bug do adapter nem do vitest — é a shell reescrevendo argumentos que parecem caminho Unix).
 *
 * Uso: MSYS_NO_PATHCONV=1 CW_TEST_FIREBIRD_HOST=... CW_TEST_FIREBIRD_PORT=... CW_TEST_FIREBIRD_DATABASE=/caminho/no/host/do/servidor
 *      CW_TEST_FIREBIRD_PASSWORD=... npx tsx scripts/verify-firebird-adapter.ts
 *
 * Provado nesta sessão (2026-09-22) contra o backup real do TMK (TERMAQ.PLV, extraído do FTP do cliente,
 * servido por um Firebird 5.0.4 descartável no WSL): 795 tabelas, NUMERIC(12,4) exato via numericMode:"string",
 * DOUBLE PRECISION corretamente marcado lossyNumeric, paginação FIRST/SKIP com hasMore honesto.
 */
import {
  executeFirebirdReadOnly, listTablesFirebird, sourceClockFirebird, tableColumnsFirebird, testFirebird,
  type FirebirdEndpoint,
} from "../src/server/connections/firebird";

async function main() {
  const host = process.env.CW_TEST_FIREBIRD_HOST;
  if (!host) throw new Error("defina CW_TEST_FIREBIRD_HOST (e _PORT/_DATABASE/_PASSWORD) antes de rodar este script");
  const endpoint: FirebirdEndpoint = {
    host,
    port: Number(process.env.CW_TEST_FIREBIRD_PORT ?? 3050),
    database: process.env.CW_TEST_FIREBIRD_DATABASE!,
    user: process.env.CW_TEST_FIREBIRD_USER ?? "sysdba",
    password: process.env.CW_TEST_FIREBIRD_PASSWORD!,
  };

  const test = await testFirebird(endpoint);
  console.log("testFirebird:", test);

  const tables = await listTablesFirebird(endpoint);
  console.log(`listTablesFirebird: ${tables.length} tabelas (amostra: ${tables.slice(0, 5).map((t) => t.table).join(", ")})`);
  if (tables.length === 0) throw new Error("nenhuma tabela encontrada — verifique o caminho do banco");

  const probeTable = tables.find((t) => t.table === "FAT_NFE")?.table ?? tables[0]!.table;
  const cols = await tableColumnsFirebird(endpoint, "public", probeTable);
  console.log(`tableColumnsFirebird(${probeTable}): ${cols.length} colunas`);
  for (const c of cols.slice(0, 8)) console.log(`  ${c.originalName}: ${c.sqlType}${c.lossyNumeric ? " (lossyNumeric)" : ""}`);

  const rows = await executeFirebirdReadOnly(endpoint, `SELECT * FROM ${probeTable}`, 30, 3, 0);
  console.log(`executeFirebirdReadOnly: ${rows.rowCount} linhas, truncated=${rows.truncated}`);
  console.log(JSON.stringify(rows.rows[0] ?? {}, null, 2));

  const now = await sourceClockFirebird(endpoint);
  console.log("sourceClockFirebird:", now.toISOString());

  console.log("\nOK — adapter verificado contra Firebird real.");
}

main().catch((e) => { console.error("FALHOU:", e instanceof Error ? e.message : e); process.exit(1); });
