from __future__ import annotations

import hashlib as _hashlib
import json as _json
import logging
import re
import zlib as _zlib
import datetime as _datetime
from pathlib import Path
from typing import Any, Iterator

import httpx

from .exceptions import (
    ConnectionError,
    QueryTimeoutError,
    ValidationError,
    from_api_error,
)

logger = logging.getLogger("catworld")
logger.addHandler(logging.NullHandler())

_PAGE_SIZE = 10_000
_TIME_RE = re.compile(r"^1970-01-01T(\d{2}:\d{2}:\d{2})")


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
            for page in self._iter_live_query(source_id, sql=sql, timeout=timeout):
                if not columns and page.columns:
                    columns = page.columns
                all_rows.extend(page.rows)
            return QueryResult({"rows": all_rows, "columns": columns, "rowCount": len(all_rows)})

        payload: dict[str, Any] = {"timeout": timeout, "limit": limit}
        if sql is not None:
            payload["sql"] = sql
        return QueryResult(self._request("POST", f"/api/v1/dataset-sources/{source_id}/query", json=payload, timeout=None))

    def iter_live_query(
        self,
        source_id: str,
        sql: str | None = None,
        timeout: int = 30,
    ) -> Iterator[QueryResult]:
        """Itera sobre os resultados de uma fonte live página a página (10.000 linhas por página).

        Útil para processar grandes volumes sem carregar tudo na memória.
        """
        yield from self._iter_live_query(source_id, sql=sql, timeout=timeout)

    def _iter_live_query(
        self,
        source_id: str,
        sql: str | None = None,
        timeout: int = 30,
    ) -> Iterator[QueryResult]:
        offset = 0
        while True:
            payload: dict[str, Any] = {"timeout": timeout, "limit": _PAGE_SIZE, "offset": offset}
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
    ) -> QueryResult:
        """Executa uma query SQL no dataset.

        Args:
            sql: SQL a executar (somente leitura).
            timeout: Timeout em segundos (máx 300). Padrão 60s.
            limit: Número máximo de linhas. ``None`` (padrão) retorna todas as linhas
                   via streaming (1 request, sem paginação).
            dataset_id: Restringe ao schema do dataset informado.
            project_id: Restringe aos schemas do projeto informado.
        """
        if limit is None:
            live_source_id = self._resolve_live_source_for_query(sql, dataset_id, project_id)
            if live_source_id:
                all_rows: list[dict[str, Any]] = []
                columns: list[str] = []
                for page in self._iter_live_query(live_source_id, sql=sql, timeout=timeout):
                    if not columns and page.columns:
                        columns = page.columns
                    all_rows.extend(page.rows)
                return QueryResult({"rows": all_rows, "columns": columns, "rowCount": len(all_rows)})
            return self._query_all_stream(sql, timeout=timeout, dataset_id=dataset_id, project_id=project_id)

        live_source_id = self._resolve_live_source_for_query(sql, dataset_id, project_id)
        if live_source_id:
            return self.live_query(live_source_id, sql=sql, timeout=timeout, limit=limit)

        return self._query_page(sql, timeout=timeout, limit=limit, offset=0, dataset_id=dataset_id, project_id=project_id)

    def _query_all_stream(
        self,
        sql: str,
        timeout: int = 60,
        dataset_id: str | None = None,
        project_id: str | None = None,
    ) -> QueryResult:
        """Busca todos os dados via NDJSON streaming (1 request, sem paginação)."""
        payload: dict[str, Any] = {"sql": sql, "stream": True}  # timeout fixo em 300s no servidor (modo stream)
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
                    raise from_api_error(None, obj.get("message", "Erro desconhecido no stream"))
                else:
                    rows.append(obj)

        return QueryResult({"rows": rows, "columns": columns, "rowCount": len(rows), "executionTimeMs": execution_time_ms})

    def iter_query(
        self,
        sql: str,
        timeout: int = 30,
        dataset_id: str | None = None,
        project_id: str | None = None,
    ) -> Iterator[QueryResult]:
        """Itera sobre os resultados de uma query página a página (10.000 linhas por página).

        Útil para processar grandes volumes sem carregar tudo na memória.
        """
        yield from self._iter_query(sql, timeout=timeout, dataset_id=dataset_id, project_id=project_id)

    def _iter_query(
        self,
        sql: str,
        timeout: int = 30,
        dataset_id: str | None = None,
        project_id: str | None = None,
    ) -> Iterator[QueryResult]:
        live_source_id = self._resolve_live_source_for_query(sql, dataset_id, project_id)
        if live_source_id:
            yield from self._iter_live_query(live_source_id, sql=sql, timeout=timeout)
            return

        context = f"dataset={dataset_id}" if dataset_id else f"project={project_id}" if project_id else "sem contexto"
        offset = 0
        while True:
            logger.info("Executando query [%s, timeout=%ss, offset=%s]", context, timeout, offset)
            page = self._query_page(sql, timeout=timeout, limit=_PAGE_SIZE, offset=offset, dataset_id=dataset_id, project_id=project_id)
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
    ) -> QueryResult:
        payload: dict[str, Any] = {"sql": sql, "timeout": timeout, "limit": limit, "offset": offset}
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
        internal = [table for table in matched if (table.get("source") or {}).get("mode") != "live"]
        if internal or len(live_source_ids) > 1:
            raise ValidationError(
                "Query mistura tabelas live com outras origens. Materialize a fonte como extract ou consulte uma fonte live por vez.",
                code="MIXED_QUERY_ENGINES",
            )
        return next(iter(live_source_ids))

    def upload(
        self,
        path: str | Path,
        dataset_id: str,
        mode: str = "replace",
        key_column: str | None = None,
        table_id: str | None = None,
    ):
        file = Path(path)
        if not file.exists():
            raise FileNotFoundError(f"Arquivo não encontrado: {file}")
        size = file.stat().st_size

        logger.info(
            "Iniciando upload: %s (%s) → dataset=%s [modo=%s]",
            file.name, _fmt_bytes(size), dataset_id, mode,
        )

        file_hash = self._stream_md5(file)
        logger.debug("Hash MD5: %s", file_hash)

        body: dict = {"filename": file.name, "sizeBytes": size, "fileHash": file_hash, "datasetId": dataset_id, "mode": mode}
        if table_id:
            body["tableId"] = table_id
        if key_column:
            body["keyColumn"] = key_column
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
        logger.info("Arquivo enviado. Processamento ocorre em background (upload_id=%s)", upload_id)
        return created["upload"]

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
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise QueryTimeoutError(f"Tempo limite excedido ao conectar com o servidor: {exc}") from exc
        except httpx.HTTPError as exc:
            raise ConnectionError(f"Falha de conexão com o servidor: {exc}") from exc

        if response.is_success:
            return response.json()["data"]

        try:
            body = response.json()
        except Exception:
            body = {}

        error = body.get("error", {})
        code = error.get("code")
        message = error.get("message") or response.text or f"HTTP {response.status_code}"

        logger.debug("Erro da API: [%s] %s", code, message)
        raise from_api_error(code, message)
