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

/** Tipos de job (worker) e o que cada um faz, para a tela de Worker. */
export const JOB_TYPE_LABEL: Record<string, { label: string; hint: string }> = {
  PREVIEW_UPLOAD: { label: "Prévia de upload", hint: "Lê o arquivo enviado e monta a prévia das colunas" },
  IMPORT_UPLOAD: { label: "Importação de upload", hint: "Grava o arquivo no dataset" },
  SOURCE_REFRESH: { label: "Atualização de fonte", hint: "Sincroniza dados de uma conexão externa (extract)" },
  DERIVED_REFRESH: { label: "Tabela derivada", hint: "Recalcula tabelas derivadas por SQL" },
  METADATA_CLEANUP: { label: "Limpeza diária", hint: "Apaga jobs, auditoria e uploads antigos conforme a retenção" },
  MIGRATE_STORAGE_PROJECT: { label: "Migração de projeto (storage)", hint: "Copia os datasets de um projeto inteiro para outro servidor de armazenamento" },
  MIGRATE_STORAGE_DATASET: { label: "Migração de dataset (storage)", hint: "Copia um dataset para outro servidor de armazenamento" },
};

export const COMMAND_ACTION_LABEL: Record<string, string> = {
  RESTART_PROFILE: "Reiniciar worker",
  STOP_PROFILE: "Parar worker",
  START_PROFILE: "Iniciar worker",
  RESTART_ALL: "Reiniciar todos os workers",
  RESTART_SUPERVISOR: "Reiniciar supervisor",
};

export const COMMAND_STATUS_LABEL: Record<string, string> = {
  PENDING: "Aguardando",
  ACCEPTED: "Aceito",
  DRAINING: "Esperando os jobs terminarem",
  APPLYING: "Aplicando",
  DONE: "Concluído",
  FORCED: "Concluído à força (passou do prazo)",
  FAILED: "Falhou",
  CANCELLED: "Cancelado",
  EXPIRED: "Expirou",
};

export const WORKER_STATE_LABEL: Record<string, string> = {
  STARTING: "Iniciando",
  RUNNING: "Rodando",
  DRAINING: "Finalizando jobs",
  BACKOFF: "Reiniciando após falha",
  CRASH_LOOP: "Caindo repetidamente",
  STOPPED: "Parado",
};
