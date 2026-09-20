# Arquivos originais dos uploads (histórico de versões)

Cada carga por upload que **mudou os dados** de uma tabela gera uma *versão* (`cw_dataset_versions`). O Catworld guarda o
**arquivo original** dessa carga em disco por um tempo, para baixá-lo pelo histórico da tabela (Detalhe da tabela > Histórico >
*Baixar arquivo original*). Versões de sincronização de fonte não têm arquivo.

## Quanto tempo o arquivo fica

Configurações > Retenção:

| Configuração | Padrão | Efeito |
|---|---|---|
| `retention.upload_files_days` ("Arquivos originais dos uploads") | 30 | Dias que o arquivo de um import **concluído** fica guardado. `0` = apagar assim que o import termina (comportamento antigo). |
| `retention.dataset_versions_keep` | 10 | Só as últimas N versões por tabela; o arquivo de uma versão podada é apagado. |
| `retention.uploads_days` | 30 | O registro do upload (nome, autor, contagens) e qualquer arquivo restante somem juntos nesse prazo. |

O arquivo é apagado quando passa de **qualquer** um dos limites. O `METADATA_CLEANUP` faz isso (depois de podar as versões); a
contagem de `files` no log inclui esses arquivos. Uploads que falharam mantêm o arquivo como antes (até `uploads_days`).

## Baixar

`GET /api/v1/tables/:id/versions/:versionId/file`: exige **WRITE** no dataset (o arquivo pode ter colunas que não foram
importadas, então não é o mesmo que ler a tabela). A versão precisa ser da tabela do caminho (senão 404). Arquivo já removido
pela retenção = **410** `FILE_GONE`; versão de sincronização = 404 `NO_FILE`. Auditado como `UPLOAD_FILE_DOWNLOADED`.

## Disco

Arquivos grandes ficam em `CATWORLD_UPLOAD_DIR` pelo prazo configurado: dimensione o volume ou reduza `upload_files_days`.
Sem versão na tabela (import que não mudou dados) o arquivo não é guardado.

Código: `src/server/uploads/file-retention.ts`, `src/worker/index.ts` (`runMetadataCleanup`, fim do import),
`src/app/api/v1/tables/[id]/versions/[versionId]/file/route.ts`.
