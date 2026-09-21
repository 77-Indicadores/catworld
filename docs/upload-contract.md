# Contrato de uploads

- Upload nao tem dono no banco: o escopo vem do **dataset**.
- Criar (`POST /uploads`) com `datasetId`: exige WRITE nesse dataset (403 `FORBIDDEN`). Sem `datasetId`: basta WRITE em algum lugar (como antes).
- Enviar arquivo (`PUT /uploads/:id` e `/file`), `?action=uploaded|retry|cancel` e `/uploaded`: exigem WRITE no dataset do upload.
- `?action=confirm` e `/confirm`: validam WRITE no dataset de destino; `tableId` precisa pertencer ao dataset (404 `TABLE_NOT_FOUND`; `tableId` sem `datasetId` = 400 `VALIDATION_ERROR`).
- Transicoes de estado: `uploaded` e o envio de arquivo (`PUT`) so valem em `PENDING_UPLOAD` ou `FAILED`; `confirm` em `PENDING_UPLOAD`, `AWAITING_CONFIRMATION` ou `FAILED`; `retry` so em `FAILED` (`NOT_RETRYABLE`). Fora disso: 409 `INVALID_UPLOAD_STATE`. Enfileirar troca o status e cria o job na mesma transacao.
- `retry-failed` nao reenfileira uploads cancelados pelo usuario nem uploads sem arquivo enviado (sem job).
- O limite de tamanho e contado durante o stream (depois do gunzip) e aborta com 413, apagando o arquivo parcial.
- Leitura (`GET /uploads`, `GET /uploads/:id`): so uploads de datasets visiveis ao ator (ADMIN/DATA_MANAGER e grants GLOBAL veem todos); uploads ainda sem dataset so aparecem para quem escreve em algum lugar.
- Rotas em massa (`cancel-all`, `retry-failed`, `dismiss-failed`): ADMIN/DATA_MANAGER (inalterado).
- Limites (Configuracoes > Worker, `upload.max_bytes` e `upload.xlsx_max_bytes`; padroes 500 MB e 40 MB): arquivo acima do limite geral = 413 `FILE_TOO_LARGE`; XLSX/XLS acima do limite de Excel = 413 `XLSX_TOO_LARGE`; so csv/xlsx/xls (400).
- Contagem esperada do gate de integridade: so vale a contagem feita pelo SERVIDOR (preview do worker, `previewJson.source = "server"`, ou uma contagem propria do arquivo). O `rowCount`/`previewJson` enviados no `POST /uploads` pelo navegador (upload-flow) sao guardados, mas nao sao prova; a marca `source` do cliente e removida. O SDK Python nao envia `rowCount`. Divergencia cliente x servidor = veredito SUSPECT (`CLIENT_COUNT_MISMATCH`); sem contagem do servidor = SUSPECT (`EXPECTED_UNVERIFIED`).
