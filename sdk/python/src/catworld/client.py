from __future__ import annotations

import hashlib as _hashlib
import json as _json
import logging
import re
import time as _time
import unicodedata as _unicodedata
import warnings
import zlib as _zlib
import datetime as _datetime
from pathlib import Path
from typing import Any, Iterator

import httpx

from .exceptions import (
    CatworldError,
    ConnectionError,
    QueryTimeoutError,
    UploadError,
    ValidationError,
    from_api_error,
)

logger = logging.getLogger("catworld")
logger.addHandler(logging.NullHandler())

_PAGE_SIZE = 10_000
_TIME_RE = re.compile(r"^1970-01-01T(\d{2}:\d{2}:\d{2})")
_UPLOAD_TERMINAL_STATUSES = {"COMPLETED", "FAILED"}

# Colunas geradas internamente pelo catworld — nunca fazem parte do arquivo
# do usuário, então nunca entram na comparação de compatibilidade de schema.
_INTERNAL_COLUMNS = {"_cw_rh"}


def _sql_identifier(value: str, max_len: int = 128) -> str:
    """Replica server/security/naming.ts:sqlIdentifier — normaliza um cabeçalho
    de coluna pro mesmo nome físico que o servidor vai usar (minúsculas, sem
    acento, não-alfanumérico vira "_"). Usado por check_append_compat para
    comparar cabeçalhos crus do arquivo com as colunas já existentes na tabela.

    Não replica o fallback de hash do servidor para nomes > max_len (raro);
    nesse caso apenas trunca.
    """
    normalized = _unicodedata.normalize("NFD", value)
    normalized = "".join(c for c in normalized if _unicodedata.category(c) != "Mn")
    normalized = normalized.lower()
    normalized = re.sub(r"[^a-z0-9_]+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized)
    normalized = normalized.strip("_")
    if not normalized:
        normalized = "campo"
    if normalized[0].isdigit():
        normalized = f"col_{normalized}"
    return normalized[:max_len]


def _fix_rows(rows: list) -> list:
    """Convert mssql TIME-as-epoch strings (1970-01-01THH:MM:SS.000Z) to plain HH:MM:SS."""
    if not rows:
        return rows
    out = []
    for row in rows:
        fixed = {}
        for k, v in row.items():
            if isinstance(v, str):
                m = _TIME_RE.match(v)
                fixed[k] = m.group(1) if m else v
            else:
                fixed[k] = v
        out.append(fixed)
    return out


def _fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _table_refs(sql: str) -> list[str]:
    refs: list[str] = []
    for match in re.finditer(r'\b(?:from|join)\s+((?:"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*))?)', sql, re.IGNORECASE):
        ref = match.group(1).strip()
        parts = [p.strip() for p in ref.split(".")]
        name = parts[-1].strip('"[]')
        if name and name.lower() not in {"select"}:
            refs.append(name)
    return refs


class QueryResult(dict):
    @property
    def rows(self) -> list[dict[str, Any]]:
        return _fix_rows(self.get("rows", []))

    @property
    def columns(self) -> list[str]:
        return self.get("columns", [])

    @property
    def dataframe(self):
        try:
            import pandas as pd
        except ImportError as exc:
            raise ImportError("Instale pandas para usar result.dataframe: pip install 'catworld-sdk[dataframe]'") from exc
        return pd.DataFrame(self.rows, columns=self.columns or None)


class CatworldClient:
    def __init__(self, base_url: str, token: str, timeout: float = 30):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )
        logger.debug("Conectado a %s", base_url)

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def projects(self):
        return self._request("GET", "/api/v1/projects")

    def datasets(self):
        return self._request("GET", "/api/v1/datasets")

    def tables(self, dataset_id: str):
        return self._request("GET", f"/api/v1/datasets/{dataset_id}/tables")

    def sources(self, dataset_id: str):
        return self._request("GET", f"/api/v1/datasets/{dataset_id}/sources")

    def rows(self, table_id: str, limit: int = 100):
        return self._request("GET", f"/api/v1/tables/{table_id}/rows", params={"limit": limit})

    def changes(self, table_id: str, since: str | _datetime.datetime | None = None, limit: int = 1000) -> dict:
        """Puxa só o que mudou numa tabela extract desde `since` (ISO string ou datetime).

        Retorna {"rows": [...], "removedKeys": [...] | None, "nextSince": str}.
        `removedKeys` é None se a fonte nunca teve upsert habilitado (sem keyColumn,
        sem como saber o que foi excluído). Guarde `nextSince` e passe como `since` na
        próxima chamada para continuar de onde parou — se nada mudou, `nextSince` volta
        igual ao `since` recebido, então é seguro chamar em loop (polling).

        `since=None` na primeira chamada busca a tabela inteira como baseline (ainda
        sujeita a `limit`); use o `nextSince` retornado para as chamadas seguintes.
        """
        params: dict[str, Any] = {"limit": limit}
        if since is not None:
            params["since"] = since.isoformat() if isinstance(since, _datetime.datetime) else since
        body = self._request_full("GET", f"/api/v1/tables/{table_id}/rows", params=params)
        meta = body.get("meta") or {}
        return {
            "rows": body.get("data") or [],
            "removedKeys": meta.get("removedKeys"),
            "nextSince": meta.get("nextSince"),
        }

    def source_info(self, source_id: str):
        """Retorna metadados de uma fonte: lastRefreshedAt, nextRefreshAt, lastRowCount, lastStatus, refreshPolicy, mode."""
        return self._request("GET", f"/api/v1/dataset-sources/{source_id}")

    def refresh_source(self, source_id: str):
        return self._request("POST", f"/api/v1/dataset-sources/{source_id}/refresh")

    def live_query(
        self,
        source_id: str,
        sql: str | None = None,
        timeout: int = 30,
        limit: int | None = None,
        normalize: bool = False,
    ) -> QueryResult:
        """Executa uma query em uma fonte live (Postgres direto).

        Args:
            source_id: ID da fonte live.
            sql: SQL opcional. Se omitido, retorna todos os dados da fonte.
            timeout: Timeout em segundos (máx 120).
            limit: Número máximo de linhas. ``None`` (padrão) retorna todas as linhas
                   paginando automaticamente em blocos de 10.000.
        """
        if limit is None:
            all_rows: list[dict[str, Any]] = []
            columns: list[str] = []
            for page in self._iter_live_query(source_id, sql=sql, timeout=timeout, normalize=normalize):
                if not columns and page.columns:
                    columns = page.columns
                all_rows.extend(page.rows)
            return QueryResult({"rows": all_rows, "columns": columns, "rowCount": len(all_rows)})

        payload: dict[str, Any] = {"timeout": timeout, "limit": limit}
        if normalize:
            payload["normalize"] = True
        if sql is not None:
            payload["sql"] = sql
        return QueryResult(self._request("POST", f"/api/v1/dataset-sources/{source_id}/query", json=payload, timeout=None))

    def iter_live_query(
        self,
        source_id: str,
        sql: str | None = None,
        timeout: int = 30,
        normalize: bool = False,
    ) -> Iterator[QueryResult]:
        """Itera sobre os resultados de uma fonte live página a página (10.000 linhas por página).

        Útil para processar grandes volumes sem carregar tudo na memória.
        """
        yield from self._iter_live_query(source_id, sql=sql, timeout=timeout, normalize=normalize)

    def _iter_live_query(
        self,
        source_id: str,
        sql: str | None = None,
        timeout: int = 30,
        normalize: bool = False,
    ) -> Iterator[QueryResult]:
        offset = 0
        while True:
            payload: dict[str, Any] = {"timeout": timeout, "limit": _PAGE_SIZE, "offset": offset}
            if normalize:
                payload["normalize"] = True
            if sql is not None:
                payload["sql"] = sql
            page = QueryResult(self._request("POST", f"/api/v1/dataset-sources/{source_id}/query", json=payload, timeout=None))
            yield page
            if len(page.rows) < _PAGE_SIZE:
                break
            offset += _PAGE_SIZE

    def query(
        self,
        sql: str,
        timeout: int = 60,
        limit: int | None = None,
        dataset_id: str | None = None,
        project_id: str | None = None,
        normalize: bool = False,
    ) -> QueryResult:
        """Executa uma query SQL no dataset.

        Args:
            sql: SQL a executar (somente leitura).
            timeout: Timeout em segundos (máx 300). Padrão 60s.
            limit: Número máximo de linhas. ``None`` (padrão) retorna todas as linhas
                   via streaming (1 request, sem paginação).
            dataset_id: Restringe ao schema do dataset informado.
            project_id: Restringe aos schemas do projeto informado.
            normalize: ``True`` pede o formato de resultado normalizado do contrato de SQL
                   (datas ``YYYY-MM-DD``/ISO-8601, bigint e decimal como string).
                   Padrão ``False``: formato inalterado.
        """
        if limit is None:
            live_source_id = self._resolve_live_source_for_query(sql, dataset_id, project_id)
            if live_source_id:
                all_rows: list[dict[str, Any]] = []
                columns: list[str] = []
                for page in self._iter_live_query(live_source_id, sql=sql, timeout=timeout, normalize=normalize):
                    if not columns and page.columns:
                        columns = page.columns
                    all_rows.extend(page.rows)
                return QueryResult({"rows": all_rows, "columns": columns, "rowCount": len(all_rows)})
            return self._query_all_stream(sql, timeout=timeout, dataset_id=dataset_id, project_id=project_id, normalize=normalize)

        live_source_id = self._resolve_live_source_for_query(sql, dataset_id, project_id)
        if live_source_id:
            return self.live_query(live_source_id, sql=sql, timeout=timeout, limit=limit, normalize=normalize)

        return self._query_page(sql, timeout=timeout, limit=limit, offset=0, dataset_id=dataset_id, project_id=project_id, normalize=normalize)

    def _query_all_stream(
        self,
        sql: str,
        timeout: int = 60,
        dataset_id: str | None = None,
        project_id: str | None = None,
        normalize: bool = False,
    ) -> QueryResult:
        """Busca todos os dados via NDJSON streaming (1 request, sem paginação)."""
        payload: dict[str, Any] = {"sql": sql, "stream": True}  # timeout fixo em 300s no servidor (modo stream)
        if normalize:
            payload["normalize"] = True
        if dataset_id:
            payload["datasetId"] = dataset_id
        if project_id:
            payload["projectId"] = project_id

        context = f"dataset={dataset_id}" if dataset_id else f"project={project_id}" if project_id else "sem contexto"
        logger.info("Executando query em modo streaming [%s, timeout=%ss]", context, timeout)

        columns: list[str] = []
        rows: list[dict[str, Any]] = []
        execution_time_ms: int = 0

        with self._client.stream("POST", "/api/v1/queries", json=payload, timeout=None) as response:
            if not response.is_success:
                # Lê o corpo de erro normalmente
                body = response.read()
                try:
                    error = _json.loads(body).get("error", {})
                    code = error.get("code")
                    message = error.get("message") or f"HTTP {response.status_code}"
                except Exception:
                    code = None
                    message = body.decode(errors="replace") or f"HTTP {response.status_code}"
                from .exceptions import from_api_error
                raise from_api_error(code, message)

            for raw_line in response.iter_lines():
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    obj = _json.loads(line)
                except _json.JSONDecodeError:
                    continue

                if "__columns__" in obj:
                    columns = obj["__columns__"]
                elif "__done__" in obj:
                    execution_time_ms = obj.get("executionTimeMs", 0)
                    logger.info("Stream concluído: %s linha(s) em %sms", obj.get("rowCount", "?"), execution_time_ms)
                    break
                elif "__error__" in obj:
                    from .exceptions import from_api_error
                    raise from_api_error(obj.get("code"), obj.get("message", "Erro desconhecido no stream"))
                else:
                    rows.append(obj)

        return QueryResult({"rows": rows, "columns": columns, "rowCount": len(rows), "executionTimeMs": execution_time_ms})

    def iter_query(
        self,
        sql: str,
        timeout: int = 30,
        dataset_id: str | None = None,
        project_id: str | None = None,
        normalize: bool = False,
    ) -> Iterator[QueryResult]:
        """Itera sobre os resultados de uma query página a página (10.000 linhas por página).

        Útil para processar grandes volumes sem carregar tudo na memória.
        """
        yield from self._iter_query(sql, timeout=timeout, dataset_id=dataset_id, project_id=project_id, normalize=normalize)

    def _iter_query(
        self,
        sql: str,
        timeout: int = 30,
        dataset_id: str | None = None,
        project_id: str | None = None,
        normalize: bool = False,
    ) -> Iterator[QueryResult]:
        live_source_id = self._resolve_live_source_for_query(sql, dataset_id, project_id)
        if live_source_id:
            yield from self._iter_live_query(live_source_id, sql=sql, timeout=timeout, normalize=normalize)
            return

        context = f"dataset={dataset_id}" if dataset_id else f"project={project_id}" if project_id else "sem contexto"
        offset = 0
        while True:
            logger.info("Executando query [%s, timeout=%ss, offset=%s]", context, timeout, offset)
            page = self._query_page(sql, timeout=timeout, limit=_PAGE_SIZE, offset=offset, dataset_id=dataset_id, project_id=project_id, normalize=normalize)
            logger.info("Página: %s linha(s) em %sms", page.get("rowCount", "?"), page.get("executionTimeMs", "?"))
            yield page
            if len(page.rows) < _PAGE_SIZE:
                break
            offset += _PAGE_SIZE

    def _query_page(
        self,
        sql: str,
        timeout: int,
        limit: int,
        offset: int,
        dataset_id: str | None,
        project_id: str | None,
        normalize: bool = False,
    ) -> QueryResult:
        payload: dict[str, Any] = {"sql": sql, "timeout": timeout, "limit": limit, "offset": offset}
        if normalize:
            payload["normalize"] = True
        if dataset_id:
            payload["datasetId"] = dataset_id
        if project_id:
            payload["projectId"] = project_id
        return QueryResult(self._request("POST", "/api/v1/queries", json=payload, timeout=None))

    def _resolve_live_source_for_query(
        self,
        sql: str,
        dataset_id: str | None,
        project_id: str | None,
    ) -> str | None:
        if not dataset_id or project_id:
            return None

        refs = _table_refs(sql)
        if not refs:
            return None

        tables = self.tables(dataset_id)
        by_name: dict[str, dict] = {}
        for table in tables:
            names = {
                str(table.get("name") or "").lower(),
                str(table.get("sqlName") or "").lower(),
            }
            source = table.get("source") or {}
            if source.get("sourceTable"):
                names.add(str(source["sourceTable"]).lower())
            for name in names:
                if name:
                    by_name[name] = table

        matched = [by_name[ref.lower()] for ref in refs if ref.lower() in by_name]
        live = [table for table in matched if (table.get("source") or {}).get("mode") == "live"]
        if not live:
            return None

        live_source_ids = {table["source"]["id"] for table in live}
        live_conn_ids = {
            (table.get("source") or {}).get("connectionId")
            or ((table.get("source") or {}).get("connection") or {}).get("id")
            for table in live
        }
        internal = [table for table in matched if (table.get("source") or {}).get("mode") != "live"]
        if internal or len(live_conn_ids - {None}) > 1:
            raise ValidationError(
                "Query mistura tabelas live com outras origens. Materialize a fonte como extract ou consulte uma fonte live por vez.",
                code="MIXED_QUERY_ENGINES",
            )
        if len(live_source_ids) > 1:
            # Nao bloqueia (compatibilidade), mas o servidor so reescreve as referencias da
            # fonte escolhida: as tabelas das outras fontes live ficam sem resolver.
            warnings.warn(
                "Query referencia tabelas de mais de uma fonte live; apenas uma sera resolvida. "
                "Consulte uma fonte live por vez (live_query) ou materialize como extract.",
                RuntimeWarning,
                stacklevel=3,
            )
        return sorted(live_source_ids)[0]

    def upload(
        self,
        path: str | Path,
        dataset_id: str,
        mode: str = "replace",
        key_column: str | None = None,
        table_id: str | None = None,
        column_types: dict[str, str] | None = None,
        wait: bool = False,
        poll_interval: float = 2.0,
        timeout: float | None = None,
        skip_preflight: bool = False,
        full_snapshot: bool = False,
    ):
        """Envia um arquivo para importação.

        Por padrão (``wait=False``), este método retorna assim que o arquivo é
        enfileirado para processamento (preview/import rodam em background) —
        NÃO informa se a importação teve sucesso. Use ``get_upload(upload_id)``
        para checar o resultado depois, ou passe ``wait=True``.

        Com ``wait=True``, o método SÓ RETORNA depois que o preview + import
        terminarem de rodar no servidor (poll em ``GET /api/v1/uploads/{id}``
        a cada ``poll_interval`` segundos) e levanta ``UploadError`` se o
        processamento falhar — com a mensagem de erro real do servidor (ex:
        "Schema incompatível. Esperado: ..."). **Recomendado** sempre que o
        chamador precisa saber se a importação realmente deu certo — sem
        isso, uma falha (ex: schema incompatível) pode passar batido
        silenciosamente por semanas, só visível olhando o painel ou o banco.

        Args:
            path: Caminho do arquivo (CSV, XLSX ou XLS).
            dataset_id: Dataset de destino.
            mode: "replace" (padrão), "append" ou "upsert".
            key_column: Obrigatório para mode="upsert" — coluna usada como chave.
            table_id: Tabela de destino. Se omitido, o nome da tabela é derivado
                do nome do arquivo — use table_id sempre que o nome do arquivo
                puder variar entre execuções (ex: tem data no nome).
            column_types: Sobrepõe o tipo SQL auto-detectado para colunas específicas.
                Chave = nome da coluna (cabeçalho original ou já normalizado), valor =
                um destes tipos: "BIGINT", "DECIMAL(p,s)" (ex: "DECIMAL(10,2)"), "DATE",
                "DATETIME2", "TIME", "NVARCHAR(MAX)". Útil quando a amostra do arquivo
                engana a heurística (ex: coluna maiormente vazia detectada como texto
                quando deveria ser DATE) ou quando dois arquivos do "mesmo" formato
                divergem de inferência entre execuções, quebrando append/upsert com
                "Schema incompatível" mesmo sem mudança real de dado. Overrides com
                nome ou tipo desconhecido são ignorados silenciosamente pelo servidor
                (não derrubam o upload) — confira os logs do worker se um override
                não parecer ter sido aplicado.
            wait: Se True, bloqueia até o import terminar e levanta exceção se
                falhar. Se False (padrão), retorna imediatamente.
            poll_interval: Segundos entre verificações de status (só com wait=True).
            timeout: Segundos máximos de espera (só com wait=True). None = sem limite
                (o próprio job tem retry/timeout interno no servidor).
            skip_preflight: Se True, pula as checagens locais abaixo (schema/coluna-chave)
                e vai direto pro upload. Use se as checagens estiverem dando falso positivo.
            full_snapshot: Só relevante com mode="upsert". True indica que o arquivo é
                100% do estado atual da origem (não um lote parcial) — o Catworld passa
                a marcar como excluídas (e reportar em ``changes()``/``rows(since=...)``)
                as linhas que existiam antes e não aparecem mais no arquivo. Default
                False preserva o comportamento atual (upsert parcial, sem inferir
                exclusão) — só ative se o arquivo enviado representar mesmo 100% dos
                registros vivos na origem a cada envio.

        Uma pré-checagem roda automaticamente antes de qualquer byte subir, sempre que
        ``table_id`` é informado e ``mode`` é "append" ou "upsert" (pulável com
        ``skip_preflight=True``):
          - ``mode="upsert"`` sem ``key_column`` falha imediatamente, sem gastar banda.
          - Nomes/ordem de coluna são comparados com a tabela física (mesma checagem de
            ``check_append_compat``) — só funciona pra CSV; XLSX não é lido localmente
            aqui, então essa parte é pulada nesse caso (chame ``check_append_compat`` você
            mesmo com os headers da planilha, se quiser essa cobertura pra XLSX).
          - Em ``mode="upsert"``, também confere que ``key_column`` existe e ainda é
            única na tabela de destino hoje (``check_upsert_ready``) — evita perpetuar
            chave duplicada silenciosamente num merge futuro.

        Raises:
            ValidationError: falha de pré-checagem (ver acima) — nenhum byte é enviado.
            UploadError: se wait=True e o processamento terminar em FAILED. A mensagem
                inclui, para upsert, uma amostra das chaves duplicadas encontradas.
            QueryTimeoutError: se wait=True, timeout for passado e for excedido.
            ConnectionError: se wait=True e houver falha de rede ao verificar o status.
        """
        file = Path(path)
        if not file.exists():
            raise FileNotFoundError(f"Arquivo não encontrado: {file}")
        size = file.stat().st_size

        if mode == "upsert" and not key_column:
            raise ValidationError('mode="upsert" exige key_column — nenhum byte foi enviado.', code="KEY_COLUMN_REQUIRED")

        logger.info(
            "Iniciando upload: %s (%s) → dataset=%s [modo=%s]",
            file.name, _fmt_bytes(size), dataset_id, mode,
        )

        if not skip_preflight and table_id and mode in ("append", "upsert"):
            self._upload_preflight(file, dataset_id, table_id, mode, key_column)

        file_hash = self._stream_md5(file)
        logger.debug("Hash MD5: %s", file_hash)

        body: dict = {"filename": file.name, "sizeBytes": size, "fileHash": file_hash, "datasetId": dataset_id, "mode": mode}
        if table_id:
            body["tableId"] = table_id
        if key_column:
            body["keyColumn"] = key_column
        if full_snapshot:
            body["fullSnapshot"] = full_snapshot
        if column_types:
            body["typeOverrides"] = column_types
        created = self._request("POST", "/api/v1/uploads", json=body)

        if created.get("skip"):
            logger.info("[SKIP] Arquivo inalterado, importação ignorada: %s", file.name)
            return created["upload"]

        upload_id = created["upload"]["id"]

        logger.info("Comprimindo e enviando arquivo para storage...")

        for attempt in range(3):
            response = self._client.put(
                created["sas"]["url"],
                content=self._gzip_stream(file),
                headers={"content-type": "application/octet-stream", "content-encoding": "gzip"},
                timeout=None,
            )
            if response.status_code != 499 or attempt == 2:
                response.raise_for_status()
                break
            logger.warning("Conexão encerrada pelo servidor (499), tentativa %s/3...", attempt + 1)

        self._request("POST", f"/api/v1/uploads/{upload_id}?action=uploaded")

        if not wait:
            logger.info("Arquivo enviado. Processamento ocorre em background (upload_id=%s)", upload_id)
            return created["upload"]

        logger.info("Arquivo enviado. Aguardando preview + import concluírem (upload_id=%s)...", upload_id)
        return self._wait_for_upload(upload_id, poll_interval=poll_interval, timeout=timeout)

    def get_upload(self, upload_id: str) -> dict:
        """Retorna o registro completo do upload (status, errorMessage, rowCount, etc.)."""
        return self._request("GET", f"/api/v1/uploads/{upload_id}")

    def _wait_for_upload(self, upload_id: str, poll_interval: float, timeout: float | None) -> dict:
        started = _time.monotonic()
        while True:
            try:
                upload = self.get_upload(upload_id)
            except CatworldError as exc:
                # Falha ao CONSULTAR o status não significa que o upload falhou —
                # não reembala como UploadError, senão fica indistinguível de uma
                # falha real de importação.
                raise ConnectionError(f"Falha ao verificar status do upload {upload_id}: {exc}") from exc

            status = upload.get("status")
            if status == "COMPLETED":
                logger.info("Upload %s concluído (%s linha(s))", upload_id, upload.get("rowCount", "?"))
                return upload
            if status == "FAILED":
                raise UploadError(
                    upload.get("errorMessage") or "Falha desconhecida no processamento do upload",
                    code="UPLOAD_FAILED",
                )

            if timeout is not None and (_time.monotonic() - started) >= timeout:
                raise QueryTimeoutError(
                    f"Upload {upload_id} não concluiu em {timeout}s (status atual: {status})"
                )

            if poll_interval > 0:
                _time.sleep(poll_interval)

    def check_append_compat(self, dataset_id: str, table_id: str, headers: list[str]) -> None:
        """Confere ANTES de subir o arquivo se os nomes/ordem de coluna batem com
        a tabela física — pega o erro mais comum de append/upsert (schema
        incompatível) sem gastar tempo/banda enviando o arquivo primeiro.

        Compara só nomes e ordem de coluna (normalizados do mesmo jeito que o
        servidor normaliza: minúsculas, sem acento, não-alfanumérico vira "_").
        NÃO valida tipo de dado — isso só o servidor descobre lendo o arquivo de
        verdade, então uma incompatibilidade de tipo ainda pode aparecer só na
        hora do import mesmo depois deste check passar.

        Args:
            dataset_id: Dataset onde a tabela está.
            table_id: Tabela de destino do upload.
            headers: Cabeçalhos das colunas do arquivo, na ordem em que aparecem
                (nomes crus, sem precisar normalizar — isso é feito aqui).

        Raises:
            ValidationError: se a tabela já existe e os nomes/ordem não baterem
                (mesmo formato de mensagem do erro real do servidor).
        """
        tables = self.tables(dataset_id)
        table = next((t for t in tables if t.get("id") == table_id), None)
        if table is None:
            logger.debug("Tabela %s não encontrada em datasets(%s) — tratando como tabela nova, nada a comparar.", table_id, dataset_id)
            return

        existing = [c["sqlName"] for c in (table.get("columns") or []) if c.get("sqlName") not in _INTERNAL_COLUMNS]
        if not existing:
            return  # tabela ainda sem colunas registradas (nunca importada) — nada a comparar

        expected = [_sql_identifier(h) for h in headers]
        if expected != existing:
            raise ValidationError(
                f"Schema incompatível. Esperado: {', '.join(expected)}; atual: {', '.join(existing)}",
                code="SCHEMA_INCOMPATIBLE",
            )

    def check_upsert_ready(self, dataset_id: str, table_id: str, key_column: str) -> None:
        """Confere ANTES de subir o arquivo se ``key_column`` está pronta para upsert:
        existe na tabela física, e a tabela ainda não tem valores duplicados nela.

        Sem essa checagem, um upsert com uma chave que já não é única na tabela de
        destino (ex: populada antes por um append) mescla silenciosamente essas
        duplicatas pra sempre — o servidor só valida chave duplicada no arquivo novo,
        nunca na tabela existente.

        Args:
            dataset_id: Dataset onde a tabela está.
            table_id: Tabela de destino do upload.
            key_column: Nome da coluna-chave (cabeçalho original ou já normalizado).

        Raises:
            ValidationError: se a coluna não existe na tabela, ou se já há valores
                duplicados nela hoje (a mensagem traz uma amostra das chaves).
        """
        tables = self.tables(dataset_id)
        table = next((t for t in tables if t.get("id") == table_id), None)
        if table is None:
            logger.debug("Tabela %s não encontrada em datasets(%s) — tratando como tabela nova, nada a checar.", table_id, dataset_id)
            return

        columns = [c["sqlName"] for c in (table.get("columns") or []) if c.get("sqlName") not in _INTERNAL_COLUMNS]
        if not columns:
            return  # tabela ainda sem colunas registradas (nunca importada) — nada a checar

        key_norm = _sql_identifier(key_column)
        if key_norm not in columns:
            raise ValidationError(
                f"Coluna-chave '{key_column}' não existe na tabela de destino. Colunas disponíveis: {', '.join(columns)}",
                code="KEY_COLUMN_NOT_FOUND",
            )

        table_name = table.get("sqlName") or table.get("name")
        try:
            result = self.query(
                f'SELECT "{key_norm}" AS k, COUNT(*) AS n FROM "{table_name}" GROUP BY "{key_norm}" HAVING COUNT(*) > 1',
                dataset_id=dataset_id,
                limit=5,
            )
        except ValidationError:
            raise
        except CatworldError as exc:
            # Não bloqueia o upload por uma falha inesperada nessa checagem best-effort
            # (ex: dialeto SQL do storage não aceitou a query) — só avisa e segue.
            logger.warning("check_upsert_ready: não foi possível verificar unicidade de '%s' em '%s': %s", key_column, table_name, exc)
            return

        if result.rows:
            sample = ", ".join(f"{r.get('k')!r} (x{r.get('n')})" for r in result.rows)
            raise ValidationError(
                f"Coluna-chave '{key_column}' já não é única na tabela de destino — um upsert manteria essas "
                f"duplicatas para sempre: {sample}. Corrija os dados existentes antes de usar mode=\"upsert\".",
                code="KEY_COLUMN_NOT_UNIQUE",
            )

    def _upload_preflight(
        self,
        file: Path,
        dataset_id: str,
        table_id: str,
        mode: str,
        key_column: str | None,
    ) -> None:
        """Roda as checagens locais de `upload()` antes de qualquer byte subir."""
        if file.suffix.lower() == ".csv":
            headers = self._csv_headers(file)
            if headers:
                self.check_append_compat(dataset_id, table_id, headers)
        else:
            logger.debug("Pré-checagem de schema pulada para %s (só suportada para CSV) — arquivo: %s", file.suffix, file.name)

        if mode == "upsert" and key_column:
            self.check_upsert_ready(dataset_id, table_id, key_column)

    @staticmethod
    def _csv_headers(file: Path) -> list[str] | None:
        """Lê só a primeira linha do CSV pra extrair os cabeçalhos, sem depender
        de nenhuma lib de parsing pesada. Detecta o separador (`,`/`;`/tab) pela
        própria linha de cabeçalho — heurística simples, suficiente pra esse fim
        (a detecção completa/real acontece no servidor, ver server/uploads/parser.ts).
        """
        import csv as _csv

        try:
            with file.open("r", encoding="utf-8-sig", newline="") as f:
                first_line = f.readline()
                if not first_line.strip():
                    return None
                separator = max((";", ",", "\t"), key=first_line.count)
                return next(_csv.reader([first_line], delimiter=separator))
        except (OSError, UnicodeDecodeError, StopIteration) as exc:
            logger.debug("Não foi possível ler cabeçalhos de %s para pré-checagem: %s", file.name, exc)
            return None

    @staticmethod
    def _stream_md5(file: Path, chunk_size: int = 1024 * 1024) -> str:
        hasher = _hashlib.md5()
        with file.open("rb") as f:
            while chunk := f.read(chunk_size):
                hasher.update(chunk)
        return hasher.hexdigest()

    @staticmethod
    def _gzip_stream(file: Path, chunk_size: int = 1024 * 1024) -> Iterator[bytes]:
        """Yield gzip-compressed chunks without loading the full file into RAM."""
        compressor = _zlib.compressobj(level=1, wbits=31)  # wbits=31 → gzip format
        with file.open("rb") as f:
            while chunk := f.read(chunk_size):
                compressed = compressor.compress(chunk)
                if compressed:
                    yield compressed
        tail = compressor.flush()
        if tail:
            yield tail

    def _request(self, method: str, path: str, **kwargs) -> Any:
        return self._request_full(method, path, **kwargs)["data"]

    def _request_full(self, method: str, path: str, **kwargs) -> dict:
        """Como _request, mas devolve o corpo completo {"data", "meta", "error"} —
        usado quando o chamador precisa do `meta` (ex: changes(), que lê removedKeys/
        nextSince de lá)."""
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise QueryTimeoutError(f"Tempo limite excedido ao conectar com o servidor: {exc}") from exc
        except httpx.HTTPError as exc:
            raise ConnectionError(f"Falha de conexão com o servidor: {exc}") from exc

        if response.is_success:
            return response.json()

        try:
            body = response.json()
        except Exception:
            body = {}

        error = body.get("error", {})
        code = error.get("code")
        message = error.get("message") or response.text or f"HTTP {response.status_code}"

        logger.debug("Erro da API: [%s] %s", code, message)
        raise from_api_error(code, message)
