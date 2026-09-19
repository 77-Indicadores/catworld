/** Rótulos em português para códigos que aparecem nas telas (nunca mostre o enum cru). */
export const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Administrador",
  DATA_MANAGER: "Gestor de dados",
  ANALYST: "Analista",
  VIEWER: "Leitor",
};

const SCOPE_LABEL: Record<string, string> = { GLOBAL: "Global", PROJECT: "Projeto", DATASET: "Dataset" };
const PERMISSION_LABEL: Record<string, string> = { READ: "leitura", WRITE: "escrita", ADMIN: "administração" };

export function grantLabel(g: { scopeType: string; permission: string }): string {
  return `${SCOPE_LABEL[g.scopeType] ?? g.scopeType} · ${PERMISSION_LABEL[g.permission] ?? g.permission}`;
}
