# FON-09 (deferred patch): derived tables materialise soft-deleted rows

Files involved (NOT touched by the sources engineer, owned elsewhere):
`src/server/connections/derived.ts`, `src/server/sql-contract/hide-deleted-run.ts`, `src/server/sql-contract/hide-deleted.ts`.

## Why

`refreshDerivedTable` runs `CREATE TABLE ... AS SELECT * FROM (<querySql>)` (Postgres) or `SELECT * INTO` (SQL Server)
**as the storage owner**. The RLS policy `cw_hide_deleted` (pg-storage.ts:17-18) does not apply to the owner/superuser,
so rows with `cw_deleted_at IS NOT NULL` (deleted at the source, kept as tombstones) are copied into the derived table
and live there for good: the derived table now contains rows that do not exist at the source. `hideDeletedForStorage`
(`hide-deleted-run.ts`) is not called on this path, and even where it is called it is **fail-open** (any failure returns the
original SQL).

Three defects in `refreshDerivedTable`:

1. Soft-deleted rows are materialised (FON-09).
2. The swap is `dropTableIfExists(target)` then `renameTable(staging, target)`: between the two statements the derived
   table does not exist (readers get "relation does not exist"), and if the process dies between them the table is gone until the next
   refresh. It is not atomic.
3. No integrity guard: a query that returns 0 rows (RLS on the source side, bad predicate, empty upstream) replaces a
   full table with an empty one and reports `ok`.

## Patch 1: fail-closed hide-deleted (new strict entry point in hide-deleted-run.ts)

```diff
--- a/src/server/sql-contract/hide-deleted-run.ts
+++ b/src/server/sql-contract/hide-deleted-run.ts
@@
 export async function hideDeletedForStorage(conn: StorageConnection, sql: string, schemas: string[], path: string): Promise<string> {
   ...
 }
+
+/**
+ * Igual a hideDeletedForStorage, mas FALHA FECHADO: se a consulta referencia tabela com cw_deleted_at e o filtro nao
+ * puder ser garantido (analise falhou, construcao nao suportada, onSkip disparou), lanca em vez de devolver o SQL original.
+ * Uso: caminhos que MATERIALIZAM dados (tabelas derivadas), onde um filtro pulado grava as linhas excluidas para sempre.
+ */
+export async function hideDeletedForStorageStrict(conn: StorageConnection, sql: string, schemas: string[], path: string): Promise<string> {
+  const v = validateReadOnlySql(sql);
+  if (!v.safe) throw new Error(v.reason);
+  let skipped: string | null = null;
+  const r = await hideDeletedRows(v.statement, {
+    schemas,
+    lookup: (s, t) => tableState(conn, s, t),
+    onSkip: (reason) => { skipped = reason; logContractEvent("hide-deleted-skip", path, sql, reason); },
+  });
+  if (skipped) {
+    throw new Error(`[hide-deleted] nao foi possivel garantir que linhas excluidas na origem fiquem de fora desta tabela derivada (${skipped}). Reescreva a consulta (evite a construcao indicada) ou filtre "cw_deleted_at IS NULL" explicitamente.`);
+  }
+  return r.rewritten > 0 ? r.sql : sql;
+}
```

(If `hideDeletedRows` does not surface every skip through `onSkip`, make it throw on the unsupported constructs when a
`strict: true` option is passed; the contract is: "either every table with `cw_deleted_at` in the query is filtered, or we throw".)

## Patch 2: derived.ts uses it, checks integrity, and swaps atomically

```diff
--- a/src/server/connections/derived.ts
+++ b/src/server/connections/derived.ts
@@
 import { contractTranslate } from "@/server/sql-contract/apply";
+import { hideDeletedForStorageStrict } from "@/server/sql-contract/hide-deleted-run";
+import { evaluateLoad, getIntegritySettings, IntegrityError } from "@/server/integrity/policy";
@@ export async function refreshDerivedTable(derivedTableId: string) {
   try {
-    const querySql = await prepareDerivedSql(dt.querySql, conn.provider);
+    // Fail-closed: a derivada e materializada como dono do storage (sem RLS); sem este filtro as linhas excluidas na origem
+    // entram na tabela para sempre. O filtro roda ANTES da traducao (mesma ordem das consultas normais).
+    const filtered = await hideDeletedForStorageStrict(conn, dt.querySql, [schema], `derived:${dt.sqlName}`);
+    const querySql = await prepareDerivedSql(filtered, conn.provider);
@@
     const rowCount = Number(await conn.countRows(schema, staging));
+
+    // Guarda de integridade (mesma politica das fontes): 0 linhas ou queda grande contra a versao anterior NAO troca a
+    // tabela (a anterior continua no ar) e a derivada fica com status de erro visivel.
+    const evaluation = evaluateLoad(
+      { kind: "derived", fullState: true, parsedRows: rowCount, prevRows: Number(dt.lastRowCount ?? 0n), scheduled: true },
+      await getIntegritySettings(),
+    );
+    if (evaluation.verdict === "FAILED") throw new IntegrityError(evaluation);
@@
-    // Substitui target pela staging atomicamente
-    await conn.dropTableIfExists(schema, dt.sqlName);
-    await conn.renameTable(schema, staging, dt.sqlName);
+    // Troca ATOMICA (uma transacao): leitores nunca veem a tabela ausente. Postgres:
+    //   BEGIN; DROP TABLE IF EXISTS s.t; ALTER TABLE s.staging RENAME TO t; COMMIT;
+    // SQL Server: idem dentro de BEGIN TRAN ... COMMIT. Se o storage ja expoe atomicSwap para "replace sem chave",
+    // usar `conn.atomicSwap(schema, staging, dt.sqlName, cols, { targetExists, keyColumn: null })` (e o que as fontes usam).
+    await conn.atomicSwap(schema, staging, dt.sqlName, cols.map((c) => ({ name: c.name, sqlType: c.sqlType, nullable: true })), {
+      targetExists: await conn.tableExists(schema, dt.sqlName),
+      keyColumn: null,
+    });
```

Notes for the owner of these files:

- `atomicSwap` (no key) also stamps `cw_synced_at` / `cw_deleted_at` on the staging table. For derived tables that is
  desirable (the derived table then also works with `rows?since=` and the RLS policy), but it changes the derived table's
  physical columns (two extra internal columns); confirm this is intended before adopting. If not, use an explicit
  transaction with DROP + RENAME instead.
- `derivedTable.lastRowCount` is used as `prevRows`. It is set on success only, so a failed run never lowers the baseline.
- The `IntegrityError` message is stable (`[integrity] ...`); store it in `lastError` like other failures (the existing
  `catch` rethrows and the worker records it; add `prisma.derivedTable.update({ lastStatus: "failed", lastError })` there:
  today a failed derived refresh leaves `lastStatus: "running"` forever, which is the same stuck-running defect as FON-17).
- Tests to add first (red): derived query over a table with a tombstone row (`cw_deleted_at` set) must not contain it;
  a `SELECT` shape that `hideDeletedRows` skips must make the refresh fail without touching the existing derived table;
  a query returning 0 rows over a 100-row derived table must fail with `EMPTY_REPLACE`.
