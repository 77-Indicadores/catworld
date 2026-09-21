# ENT-05 — patch para `src/app/api/v1/tables/[id]/rows/route.ts` (arquivo do dono; NAO aplicado)

Pre-requisito: o commit `fix(entrega): protocolo since ...` da branch `worktree-agent-aaa0ddc70a5cd4102` (traz `src/server/tables/since.ts` novo:
`parseSince`, `finalizeNextSince`, `rowStampsOf`, `safetyWindowMs`, `PG_NOW_TXT_SQL`, `BASELINE_SINCE_TXT`). A biblioteca continua
compativel com a rota antiga (compila e funciona), mas SO ganha o efeito completo com este patch. Enquanto a rota nao for
alterada, `pgRemovedSql` devolve `d` como TEXTO (a rota antiga faz `new Date(String(r.d))`, ou seja hora local: aplicar o patch).

Referencia de linhas: versao da rota no checkout principal (com o trabalho nao commitado do dono; as linhas ~84-140 e ~196-212).

## 1. Imports

```ts
import {
  BASELINE_SINCE_TXT, decodeCursor, finalizeNextSince, normTs, parseSince, PG_NOW_TXT_SQL, pgRemovedSql, pgRowsPageSql,
  REMOVED_CAP, rowStampsOf, safetyWindowMs, settleFirstPage, shapeRowsPage, TIE_CAP,
  type Cursor, type PageRow, type ParsedSince,
} from "@/server/tables/since";
```

Remova `sqlDateLiteral` SO se o MSSQL nao a usar (o ramo MSSQL abaixo ainda usa; mantenha-a).

## 2. Parse de `since` / `cursor` (substitui o bloco `let since: Date | null ...` e o do cursor)

```ts
    const wantStamps = request.nextUrl.searchParams.get("stamps") === "1";
    let parsedSince: ParsedSince | null = null;
    if (sinceRaw) {
      parsedSince = parseSince(sinceRaw); // UTC (sem fuso = UTC), microssegundos; nunca usa o fuso do Node
      if (!parsedSince) throw new ApiError(400, "INVALID_SINCE", "\"since\" precisa ser uma data ISO valida (ex.: 2026-09-19T10:00:00.123456Z)");
    }
    // so o ramo MSSQL (legado) ainda usa Date (ms)
    const since: Date | null = parsedSince ? new Date(parsedSince.iso.replace(/(\.\d{3})\d{3}Z$/, "$1Z")) : null;
    let cursor: Cursor | null = null;
    if (cursorRaw) {
      // o cursor carrega o estado inteiro: tambem pagina o BASELINE (sem `since`)
      cursor = decodeCursor(cursorRaw);
      if (!cursor) throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" invalido");
    }
```

E o bloco "live" `if (sinceRaw && table.source?.mode === "live")` continua igual.

## 3. Ramo Postgres (substitui `if (since) { ... if (conn.provider === "postgres") { ... } ... }` no que toca o PG)

Estruture assim: o ramo PG passa a valer TAMBEM sem `since` (baseline paginado). Antes de `if (since) {`:

```ts
    if (conn.provider === "postgres") {   // "live" ja retornou acima
```
com o corpo:

```ts
      const qSyncedAt = conn.q("cw_synced_at");
      const qDeletedAt = conn.q("cw_deleted_at");
      const isBaseline = !parsedSince;
      const sinceTxt = parsedSince?.txt ?? BASELINE_SINCE_TXT;
      const sinceLit = `'${sinceTxt}'`;
      const qKey = keyColumn ? conn.q(keyColumn) : null;
      const keySqlType = table.columns.find((c) => c.sqlName === keyColumn)?.sqlType ?? "NVARCHAR(MAX)";
      if (cursor && !qKey) throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" exige tabela com chave (upsert)");
      const mkSql = (lim: number, cur: Cursor | null) =>
        pgRowsPageSql({ qTarget, colList, qSynced: qSyncedAt, qDeleted: qDeletedAt, qKey, keySqlType, sinceLit, cursor: cur, limit: lim });
      let pageSql: string;
      try { pageSql = mkSql(limit, cursor); } catch { throw new ApiError(400, "INVALID_CURSOR", "\"cursor\" invalido"); }
      const raw = await conn.query<PageRow>(pageSql);
      const shaped = cursor
        ? shapeRowsPage(raw, limit, sinceTxt)
        : await settleFirstPage(raw, limit, sinceTxt, () => conn.query<PageRow>(mkSql(TIE_CAP, null)));
      const stamps = wantStamps ? rowStampsOf(shaped.page) : null;
      const rows = shaped.page.map((r) => {
        const { __cw_synced_at, __cw_synced_txt, __cw_key, ...rest } = r;
        void __cw_synced_at; void __cw_synced_txt; void __cw_key;
        return rest;
      });

      // Exclusoes: so na 1a pagina de um `since` (baseline nao lista excluidas; paginas de cursor ja as entregaram).
      let removedKeys: unknown[] | null = null;
      let removedMaxTxt: string | null = null;
      let removedTruncated = false;
      if (qKey && !isBaseline) {
        removedKeys = [];
        if (!cursor) {
          const removed = await conn.query<{ k: unknown; d: unknown }>(pgRemovedSql({ qTarget, qDeleted: qDeletedAt, qKey, sinceLit }));
          removedTruncated = removed.length > REMOVED_CAP;
          for (const r of removed.slice(0, REMOVED_CAP)) {
            removedKeys.push(r.k);
            const d = normTs(String(r.d)); // TEXTO do banco: sem Date, sem fuso do Node
            if (d && (!removedMaxTxt || d > removedMaxTxt)) removedMaxTxt = d;
          }
        }
      }
      const nowTxt = (await conn.query<{ n: string }>(PG_NOW_TXT_SQL))[0]?.n ?? "";
      const nextSince = finalizeNextSince({ settled: shaped, since: sinceTxt, removedMaxTxt, removedTruncated, nowTxt, windowMs: safetyWindowMs() });

      return ok(rows, {
        columns: colNames.length ? colNames : (rows.length ? Object.keys(rows[0]!) : []),
        rowCount: rows.length,
        removedKeys,
        nextSince,                       // ISO UTC com 6 casas: guarde como TEXTO
        hasMore: shaped.hasMore,
        ...(shaped.nextCursor ? { nextCursor: shaped.nextCursor } : {}),
        ...(stamps ? { rowStamps: stamps } : {}),        // dedupe no cliente (janela de seguranca)
        ...(removedTruncated ? { removedTruncated: true } : {}),
        ...(shaped.tieGroupTruncated ? { tieGroupTruncated: true } : {}),
        safetyWindowSec: Math.round(safetyWindowMs() / 1000),
      });
    }
```

Notas:
* O `if (since) {` externo deve envolver so o ramo MSSQL (o ramo PG acima ja trata since e baseline). O ramo MSSQL
  continua como esta (nao verificado: sem instancia) e usa `sinceLit = \`'${sqlDateLiteral(since)}'\`` com `since` (Date).
* Baseline PG SEM chave (`keyColumn` nulo) com grupo empatado > TIE_CAP (50.000 linhas com o mesmo carimbo, tipico de
  full swap): sem cursor nao ha como continuar; a resposta traz `tieGroupTruncated: true` + `hasMore: true`. O SDK deve
  avisar; a saida e usar `POST /queries` com `"stream": true`. Decisao do dono: exigir chave para baseline > 50k.
* Remova o calculo antigo do baseline (`SELECT MAX(cw_synced_at)`, linhas ~196-212) apenas para PG: o ramo acima ja
  devolve `nextSince`. Para MSSQL, mantenha; mas troque `new Date(String(v)).toISOString()` por leitura de
  `CAST(MAX(cw_synced_at) AS varchar(30))` (o `Date` do driver ja depende de fuso).
* `safetyWindowSec` informa ao cliente a janela em vigor (config: `CW_SINCE_SAFETY_WINDOW_SEC`, padrao 300).

## 4. Teste sugerido de rota (integracao)

Copie o cenario de `src/server/tables/since.pg.test.ts` ("ENT-05: microssegundos"): 2 chamadas em serie seguindo
`nextSince` com `windowMs=0` nao repetem linhas; com janela > 0 as linhas recentes voltam e o SDK as remove por
`rowStamps` (`sdk/python/tests/test_changes_protocol.py`).
