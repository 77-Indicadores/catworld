# Contrato de uploads

- Upload nao tem dono no banco: o escopo vem do **dataset**.
- Criar (`POST /uploads`) com `datasetId`: exige WRITE nesse dataset (403 `FORBIDDEN`). Sem `datasetId`: basta WRITE em algum lugar (como antes).
- Enviar arquivo (`PUT /uploads/:id` e `/file`), `?action=uploaded|retry|cancel` e `/uploaded`: exigem WRITE no dataset do upload.
- `?action=confirm` e `/confirm`: validam WRITE no dataset de destino (inalterado).
- Leitura (`GET /uploads`, `GET /uploads/:id`): so uploads de datasets visiveis ao ator (ADMIN/DATA_MANAGER e grants GLOBAL veem todos); uploads ainda sem dataset so aparecem para quem escreve em algum lugar.
- Rotas em massa (`cancel-all`, `retry-failed`, `dismiss-failed`): ADMIN/DATA_MANAGER (inalterado).
- Limites (Configuracoes > Worker, `upload.max_bytes` e `upload.xlsx_max_bytes`; padroes 500 MB e 40 MB): arquivo acima do limite geral = 413 `FILE_TOO_LARGE`; XLSX/XLS acima do limite de Excel = 413 `XLSX_TOO_LARGE`; so csv/xlsx/xls (400).
