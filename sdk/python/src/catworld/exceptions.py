from __future__ import annotations


class CatworldError(Exception):
    """Erro base do SDK Catworld."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code

    def __str__(self) -> str:
        if self.code:
            return f"[{self.code}] {self.args[0]}"
        return self.args[0]


class AuthenticationError(CatworldError):
    """Token inválido, expirado ou revogado."""


class PermissionDeniedError(CatworldError):
    """Token sem permissão para esta operação."""


class NotFoundError(CatworldError):
    """Recurso não encontrado (dataset, projeto, tabela, etc.)."""


class TableNotFoundError(NotFoundError):
    """Tabela não encontrada no contexto (dataset_id ou project_id) informado."""


class AmbiguousTableError(CatworldError):
    """Tabela existe em múltiplos datasets do contexto — qualifique com schema.tabela."""


class ValidationError(CatworldError):
    """Dados inválidos ou SQL não permitido."""


class UnsafeSqlError(ValidationError):
    """SQL contém comandos não permitidos (apenas SELECT/WITH são aceitos)."""


class QueryTimeoutError(CatworldError):
    """Query ou importação excedeu o tempo limite."""


class UploadError(CatworldError):
    """Erro durante o processamento do upload."""


class ConnectionError(CatworldError):
    """Falha de rede ou erro inesperado do servidor."""


# Mapeamento de códigos de erro da API para exceções
_CODE_MAP: dict[str, type[CatworldError]] = {
    "INVALID_TOKEN": AuthenticationError,
    "UNAUTHENTICATED": AuthenticationError,
    "FORBIDDEN": PermissionDeniedError,
    "CONNECTION_FORBIDDEN": PermissionDeniedError,
    "SCHEMA_FORBIDDEN": PermissionDeniedError,
    "NOT_FOUND": NotFoundError,
    "DATASET_NOT_FOUND": NotFoundError,
    "VALIDATION_ERROR": ValidationError,
    "INVALID_JSON": ValidationError,
    "BAD_REQUEST": ValidationError,
    "TABLE_NOT_FOUND": TableNotFoundError,
    "AMBIGUOUS_TABLE": AmbiguousTableError,
    "UNSAFE_SQL": UnsafeSqlError,
    "QUERY_TIMEOUT": QueryTimeoutError,
    "INTERNAL_ERROR": ConnectionError,
}


def from_api_error(code: str | None, message: str) -> CatworldError:
    """Cria a exceção correta a partir do código de erro da API."""
    cls = _CODE_MAP.get(code or "", CatworldError)
    return cls(message, code=code)
