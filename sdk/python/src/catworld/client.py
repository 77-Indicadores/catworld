from __future__ import annotations

import csv as _csv
import gzip as _gzip
import hashlib as _hashlib
import io as _io
import json as _json
import logging
import re as _re
import time
from datetime import datetime as _datetime, timezone as _tz
from pathlib import Path
from typing import Any

import httpx

from .exceptions import (
    ConnectionError,
    QueryTimeoutError,
    UploadError,
    ValidationError,
    from_api_error,
)

logger = logging.getLogger("catworld")
logger.addHandler(logging.NullHandler())


def _fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


# ── Phase 2: row hash converters (must match makeCleanConverter in importer-bulk-blob.ts) ──

def _make_hash_converter(sql_type: str):
    """Python equivalent of makeCleanConverter in importer-bulk-blob.ts."""
    if sql_type == "BIGINT":
        return lambda v: "" if (v is None or str(v).strip() == "") else str(v).strip()

    if sql_type.startswith("DECIMAL"):
        def _decimal(v):
            s = str(v).strip() if v is not None else ""
            if not s:
                return ""
            if "," in s:
                s = s.replace(".", "").replace(",", ".")
            try:
                return f"{float(s):.4f}"
            except (ValueError, OverflowError):
                return ""
        return _decimal

    if sql_type == "DATE":
        def _date(v):
            s = str(v).strip() if v is not None else ""
            if not s:
                return ""
            m = _re.match(r"^(\d{2})/(\d{2})/(\d{4})", s)
            if m:
                return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
            return s[:10]
        return _date

    if sql_type == "DATETIME2":
        def _dt2(v):
            s = str(v).strip() if v is not None else ""
            if not s:
                return ""
            m = _re.match(r"^(\d{2})/(\d{2})/(\d{4})(.*)", s)
            iso = f"{m.group(3)}-{m.group(2)}-{m.group(1)}{m.group(4)}" if m else s
            try:
                dt = _datetime.fromisoformat(iso.strip())
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=_tz.utc)
                utc = dt.astimezone(_tz.utc)
                ms = utc.microsecond // 1000
                return utc.strftime("%Y-%m-%d %H:%M:%S.") + f"{ms:03d}"
            except (ValueError, OverflowError):
                return ""
        return _dt2

    if sql_type == "TIME":
        return lambda v: "" if (v is None or str(v).strip() == "") else str(v).strip()

    # NVARCHAR (default): keep original value (not trimmed), wrap in double quotes
    def _nvarchar(v):
        s = str(v) if v is not None else ""
        if s.strip() == "":
            return '""'
        return '"' + s.replace('"', '""') + '"'
    return _nvarchar


def _detect_encoding(raw: bytes) -> str:
    try:
        raw.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        try:
            import chardet
            result = chardet.detect(raw[:8192])
            return result.get("encoding") or "latin-1"
        except ImportError:
            return "latin-1"


def _detect_separator(raw: bytes, encoding: str) -> str:
    sample = raw[:4096].decode(encoding, errors="replace")
    try:
        dialect = _csv.Sniffer().sniff(sample, delimiters=",;\t|")
        return dialect.delimiter
    except _csv.Error:
        return ","


def _compute_csv_delta(
    raw_bytes: bytes,
    encoding: str,
    separator: str,
    mapping: list[dict],
    server_hash_set: set[str],
) -> tuple[bytes, list[str], int, int] | None:
    """
    Parse CSV, compute row hashes using the same logic as the server.
    Returns (to_insert_csv_bytes, to_delete_hashes, total_rows, insert_count) or None on failure.
    The to_insert_csv_bytes is a pipe-delimited clean CSV with _cw_rh appended (ready for BULK INSERT).
    """
    try:
        text = raw_bytes.decode(encoding, errors="replace")
        reader = _csv.reader(_io.StringIO(text), delimiter=separator)
        rows_iter = iter(reader)
        header_row = next(rows_iter, None)
        if header_row is None:
            return None

        header = [h.strip() for h in header_row]
        col_idx: list[int | None] = [
            (header.index(c["originalName"]) if c["originalName"] in header else None)
            for c in mapping
        ]
        if any(idx is None for idx in col_idx):
            missing = [c["originalName"] for c, idx in zip(mapping, col_idx) if idx is None]
            logger.debug("Phase 2: missing columns in file: %s", missing)
            return None

        converters = [_make_hash_converter(c["sqlType"]) for c in mapping]

        out = _io.StringIO()
        new_hash_set: set[str] = set()
        to_insert_count = 0
        total = 0

        for row in rows_iter:
            if not any(cell.strip() for cell in row):
                continue  # skip blank rows
            total += 1
            converted = [
                converters[i](row[idx] if idx < len(row) else None)
                for i, idx in enumerate(col_idx)  # type: ignore[arg-type]
            ]
            csv_line = "|".join(converted)
            rh = _hashlib.md5(csv_line.encode("utf-8")).hexdigest()
            new_hash_set.add(rh)
            if rh not in server_hash_set:
                out.write(csv_line + "|" + rh + "\n")
                to_insert_count += 1

        to_delete = list(server_hash_set - new_hash_set)
        to_insert_bytes = out.getvalue().encode("utf-8")
        return to_insert_bytes, to_delete, total, to_insert_count
    except Exception as exc:
        logger.debug("Phase 2 delta computation failed: %s", exc)
        return None


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

    def rows(self, table_id: str, limit: int = 100):
        return self._request("GET", f"/api/v1/tables/{table_id}/rows", params={"limit": limit})

    def query(
        self,
        sql: str,
        timeout: int = 30,
        limit: int = 10000,
        dataset_id: str | None = None,
        project_id: str | None = None,
    ):
        context = f"dataset={dataset_id}" if dataset_id else f"project={project_id}" if project_id else "sem contexto"
        logger.info("Executando query [%s, timeout=%ss, limit=%s]", context, timeout, limit)

        payload: dict = {"sql": sql, "timeout": timeout, "limit": limit}
        if dataset_id:
            payload["datasetId"] = dataset_id
        if project_id:
            payload["projectId"] = project_id

        result = self._request("POST", "/api/v1/queries", json=payload, timeout=None)
        logger.info(
            "Query concluída: %s linha(s) em %sms",
            result.get("rowCount", "?"),
            result.get("executionTimeMs", "?"),
        )
        return result

    def upload(
        self,
        path: str | Path,
        dataset_id: str,
        mode: str = "replace",
        key_column: str | None = None,
        poll_interval: float = 2,
    ):
        file = Path(path)
        if not file.exists():
            raise FileNotFoundError(f"Arquivo não encontrado: {file}")
        size = file.stat().st_size

        logger.info(
            "Iniciando upload: %s (%s) → dataset=%s [modo=%s]",
            file.name, _fmt_bytes(size), dataset_id, mode,
        )

        # Option 1 — hash skip: compute MD5 before upload so server can detect unchanged files
        raw_bytes = file.read_bytes()
        file_hash = _hashlib.md5(raw_bytes).hexdigest()
        logger.debug("Hash MD5: %s", file_hash)

        created = self._request(
            "POST",
            "/api/v1/uploads",
            json={"filename": file.name, "sizeBytes": size, "fileHash": file_hash, "datasetId": dataset_id},
        )

        if created.get("skip"):
            logger.info("[SKIP] Arquivo inalterado, importação ignorada: %s", file.name)
            return created["upload"]

        upload_id = created["upload"]["id"]

        # Option 3 Phase 2 — client-side delta: only for CSV replace mode
        delta: dict | None = None
        if mode == "replace" and file.suffix.lower() == ".csv":
            delta = self._try_phase2(dataset_id, file.name, raw_bytes)

        if delta:
            upload_bytes = delta["to_insert_bytes"]
            logger.info(
                "[DELTA P2] %d linhas novas, %d removidas (upload: %s → %s)",
                delta["to_insert_count"], len(delta["to_delete"]),
                _fmt_bytes(len(raw_bytes)), _fmt_bytes(len(upload_bytes)),
            )
        else:
            upload_bytes = raw_bytes

        logger.info("Comprimindo e enviando arquivo para storage...")
        compressed = _gzip.compress(upload_bytes, compresslevel=1)
        ratio = len(compressed) / max(len(upload_bytes), 1)
        logger.info(
            "Compressão: %s → %s (%.0f%% do original)",
            _fmt_bytes(len(upload_bytes)), _fmt_bytes(len(compressed)), ratio * 100,
        )
        for attempt in range(3):
            response = self._client.put(
                created["sas"]["url"],
                content=_io.BytesIO(compressed),
                headers={"content-type": "application/octet-stream", "content-encoding": "gzip"},
                timeout=None,
            )
            if response.status_code != 499 or attempt == 2:
                response.raise_for_status()
                break
            logger.warning("Conexão encerrada pelo servidor (499), tentativa %s/3...", attempt + 1)
            time.sleep(1)
        logger.info("Arquivo enviado, aguardando processamento...")

        if delta:
            # Phase 2 uploads a pre-processed pipe CSV without headers, so preview would
            # parse data as a header. Confirm import directly with the server mapping.
            cols = delta["mapping"]
        else:
            self._request("POST", f"/api/v1/uploads/{upload_id}?action=uploaded")
            preview = self._wait_upload(upload_id, "AWAITING_CONFIRMATION", poll_interval)
            mapping = preview["previewJson"]
            if isinstance(mapping, str):
                mapping = _json.loads(mapping)
            cols = mapping.get("columns", [])

        if not cols:
            raise UploadError("Nenhuma coluna detectada no arquivo — verifique se o arquivo possui cabeçalho e dados válidos")
        logger.info("%s coluna(s): %s", len(cols), [c.get("originalName", c.get("sqlName", c)) for c in cols[:5]])
        logger.info("Confirmando importação...")

        confirm_body: dict = {
            "datasetId": dataset_id,
            "mode": mode,
            "keyColumn": key_column,
            "mapping": cols,
        }
        if delta:
            confirm_body["deltaToDelete"] = delta["to_delete"]

        self._request("POST", f"/api/v1/uploads/{upload_id}?action=confirm", json=confirm_body)

        result = self._wait_upload(upload_id, "COMPLETED", poll_interval)
        logger.info("Upload concluído: %s linha(s) importada(s)", result.get("rowCount", "?"))
        return result

    def _try_phase2(self, dataset_id: str, filename: str, raw_bytes: bytes) -> dict | None:
        """
        Attempt Phase 2 client-side delta.
        Downloads current table hashes from server, computes delta locally.
        Returns dict with to_insert_bytes, to_delete, mapping, to_insert_count or None (fall back to full upload).
        """
        try:
            resp = self._client.post(
                f"/api/v1/datasets/{dataset_id}/delta-prep",
                json={"filename": filename},
                timeout=120.0,  # hash streaming may take time for large tables
            )
            if not resp.is_success:
                return None
            if resp.headers.get("X-CW-Capable") != "true":
                logger.debug("Phase 2 não suportado: %s", resp.headers.get("X-CW-Reason", "unknown"))
                return None

            server_mapping: list[dict] = _json.loads(resp.headers.get("X-CW-Mapping", "[]"))
            server_row_count = int(resp.headers.get("X-CW-Row-Count", "0"))

            # Read all server hashes (one per line, no header)
            server_hash_set = {line for line in resp.text.splitlines() if len(line) == 32}
            logger.debug("Phase 2: servidor tem %d hashes (tabela: %d linhas)", len(server_hash_set), server_row_count)

            if not server_hash_set and server_row_count > 0:
                logger.debug("Phase 2: nenhum hash recebido mas tabela não está vazia — abortando")
                return None

            # Detect file encoding and separator for CSV parsing
            encoding = _detect_encoding(raw_bytes)
            separator = _detect_separator(raw_bytes, encoding)

            result = _compute_csv_delta(raw_bytes, encoding, separator, server_mapping, server_hash_set)
            if result is None:
                logger.debug("Phase 2: falha no cálculo do delta — usando upload completo")
                return None

            to_insert_bytes, to_delete, total, to_insert_count = result
            logger.debug(
                "Phase 2 delta: %d/%d linhas novas, %d removidas",
                to_insert_count, total, len(to_delete),
            )

            # Sanity check: if everything changed, Phase 2 has no benefit
            if to_insert_count == total and not to_delete:
                logger.debug("Phase 2: sem delta calculado (novo dataset?) — usando upload completo")
                return None

            return {
                "to_insert_bytes": to_insert_bytes,
                "to_delete": to_delete,
                "mapping": server_mapping,
                "to_insert_count": to_insert_count,
            }
        except Exception as exc:
            logger.warning("Phase 2 falhou, usando upload completo: %s", exc)
            return None

    def _wait_upload(self, upload_id: str, target: str, interval: float):
        last_status = None
        for _ in range(1800):
            upload = self._request("GET", f"/api/v1/uploads/{upload_id}", timeout=None)
            status = upload["status"]
            if status != last_status:
                logger.info("  → %s", status)
                last_status = status
            if status == target:
                return upload
            if status == "FAILED":
                msg = upload.get("errorMessage") or "Falha no processamento do arquivo"
                raise UploadError(msg)
            time.sleep(interval)
        raise QueryTimeoutError("Tempo de processamento do upload excedido")

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
