# Protocolo `since` (mudancas incrementais de uma tabela)

`GET /api/v1/tables/:id/rows?since=<ISO>&limit=N[&cursor=C][&stamps=1]` — so tabelas extract.

* **Relogio.** `since`/`nextSince` sao instantes do relogio do servidor de storage (coluna `cw_synced_at`), sempre UTC (`...Z`)
  com microssegundos (`2026-09-19T10:00:00.123456Z`). `since` sem fuso e UTC; com offset e convertido. O fuso do processo
  do servidor ou do cliente nunca entra na conta. Guarde `nextSince` como texto.
* **Sem repeticao.** O proximo `since` sai do texto `cw_synced_at::text` (nao de um `Date` em ms), logo uma linha entregue
  nao volta enquanto o carimbo estiver fora da janela de seguranca.
* **Janela de seguranca.** `now()` e o inicio da transacao do escritor; uma carga longa pode commitar depois de uma carga
  mais nova. Por isso `nextSince = min(maior carimbo lido, agora_do_storage - janela)` (nunca abaixo do `since` recebido).
  Padrao 300 s (`CW_SINCE_SAFETY_WINDOW_SEC`). Linhas dentro da janela **podem voltar**; com `stamps=1` a resposta traz
  `meta.rowStamps` (carimbo de cada linha) e o SDK deduplica por (carimbo + conteudo). Clientes que nao deduplicam devem
  tratar a entrega como *pelo menos uma vez* e fazer upsert pela chave.
* **Baseline.** Sem `since` a resposta e paginada: `meta.hasMore` + `meta.nextCursor` (`?cursor=` sem `since`). O SDK
  (`changes(follow=True)`) segue ate esgotar. Limite: tabela sem chave com >50.000 linhas de mesmo carimbo devolve
  `tieGroupTruncated: true` — use `POST /queries` com `stream: true`.
* **Exclusoes.** `meta.removedKeys` (idempotente) so na 1a pagina de um `since`; o baseline nao lista excluidas.
* **Ordem.** Paginas ordenadas por (carimbo, chave); com `cursor`, paginas estritas de `limit` linhas.
