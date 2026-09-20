/**
 * SQL do `claim` do worker: pega o próximo job elegível, atomicamente (FOR UPDATE SKIP LOCKED).
 *
 * Extraído de index.ts para ser testado contra Postgres real (claim.pg.test.ts). Parâmetros:
 *   $1 lockedBy · $2 teto de jobs pesados (peso 2 rodando) · $3 leituras simultâneas por storage · $4 pesos aceitos (faixa)
 *
 * Regras:
 *  - tipos: o perfil só pega os tipos dele (interpolados aqui: validados antes, e por CHECK no banco);
 *  - faixa: `$4` vazio = qualquer peso (comportamento anterior); senão só os pesos listados;
 *  - teto de pesados: peso 2 só começa se houver menos de `$2` jobs de peso 2 rodando (somando todos os workers);
 *  - storage: jobs com storage_server_id (SOURCE_REFRESH) só começam se houver menos de `$3` rodando no mesmo storage;
 *  - ordem: leves primeiro (peso ASC), depois o mais antigo (available_at ASC). Dentro de uma faixa os pesos são parecidos,
 *    então na prática é FIFO.
 */
export function buildClaimSql(allowedTypes: string[] | null): string {
  const typeFilter = allowedTypes && allowedTypes.length > 0
    ? `AND j.type IN (${allowedTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")})`
    : "";
  return `UPDATE cw_jobs
     SET status='RUNNING',locked_at=NOW(),heartbeat_at=NOW(),locked_by=$1,attempts=attempts+1
     WHERE id=(
       SELECT j.id FROM cw_jobs j
       WHERE j.status='QUEUED' AND j.available_at<=NOW()
         ${typeFilter}
         AND (cardinality($4::int[])=0 OR j.weight=ANY($4::int[]))
         AND (j.weight<2 OR (SELECT COUNT(*) FROM cw_jobs WHERE status='RUNNING' AND weight=2)<$2)
         AND (j.storage_server_id IS NULL OR (SELECT COUNT(*) FROM cw_jobs r WHERE r.status='RUNNING' AND r.storage_server_id=j.storage_server_id)<$3)
       ORDER BY j.weight ASC,j.available_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id,type,upload_id,payload_json,attempts,max_attempts,weight`;
}
