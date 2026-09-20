/**
 * Retenção do ARQUIVO ORIGINAL dos uploads (o que dá sentido ao histórico de versões da tabela).
 *
 * Um import concluído mantém o arquivo em disco enquanto (1) ele for mais novo que `retention.upload_files_days`
 * (padrão 30; 0 = não guardar, o comportamento antigo) E (2) a versão da tabela que ele gerou ainda estiver entre as
 * últimas `retention.dataset_versions_keep`. O que passar de qualquer um dos dois limites é apagado no METADATA_CLEANUP.
 * O registro do upload (nome, autor, contagens) continua até `retention.uploads_days`; só o arquivo some antes.
 */
import { prisma } from "@/server/db";
import { deleteFile, fileExists } from "@/server/storage";
import { pickInt } from "@/server/worker/config";

export const UPLOAD_FILES_DAYS_KEY = "retention.upload_files_days";
export const UPLOAD_FILES_DAYS_DEFAULT = 30;

/** Valor salvo inválido ou fora da faixa cai no padrão (nunca NaN). */
export const pickUploadFilesDays = (raw: string | undefined) => pickInt(raw, UPLOAD_FILES_DAYS_DEFAULT, 0, 3650);

export async function getUploadFilesDays(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(`SELECT value FROM cw_system_settings WHERE key = $1`, UPLOAD_FILES_DAYS_KEY);
  return pickUploadFilesDays(rows[0]?.value);
}

/** Uploads concluídos cujo arquivo já passou de um dos limites ($1 = dias; 0 = não guardar). Exportado para o teste com Postgres real. */
export const EXPIRED_FILES_SQL = `SELECT u.blob_name FROM cw_uploads u
     WHERE u.status = 'COMPLETED'
       AND ($1::int = 0
            OR u.created_at < NOW() - ($1::int || ' days')::INTERVAL
            OR NOT EXISTS (SELECT 1 FROM cw_dataset_versions v WHERE v.upload_id = u.id))`;

/**
 * Apaga os arquivos de imports concluídos que já passaram de um dos limites. Idempotente (arquivo já ausente = nada a fazer).
 * Rodar DEPOIS de podar `cw_dataset_versions`, para a regra "fora das últimas N versões" enxergar o resultado da poda.
 */
export async function purgeExpiredUploadFiles(filesDays: number): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ blob_name: string }[]>(EXPIRED_FILES_SQL, filesDays);
  let deleted = 0;
  for (const { blob_name } of rows) {
    if (!fileExists(blob_name)) continue;
    await deleteFile(blob_name);
    deleted++;
  }
  return deleted;
}
