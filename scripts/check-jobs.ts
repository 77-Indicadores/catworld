import { prisma } from '../src/server/db';

async function main() {
  // Jobs IMPORT_UPLOAD recentes (prova que o worker está rodando)
  const uploads = await (prisma as any).$queryRawUnsafe(`
    SELECT TOP 5 id, type, status, attempts, created_at, updated_at
    FROM dbo.cw_jobs
    WHERE type IN ('IMPORT_UPLOAD','PREVIEW_UPLOAD') AND status='COMPLETED'
    ORDER BY updated_at DESC
  `) as any[];
  console.log('Upload jobs COMPLETED recentes:');
  uploads.forEach((j: any) => console.log(' ', j.type, 'completed_at='+j.updated_at));

  // Jobs SOURCE_REFRESH da última semana — todos os status
  const sr = await (prisma as any).$queryRawUnsafe(`
    SELECT TOP 30 id, type, status, attempts, max_attempts, payload_json, created_at, updated_at, last_error
    FROM dbo.cw_jobs
    WHERE type='SOURCE_REFRESH'
    ORDER BY created_at DESC
  `) as any[];
  console.log('\nSOURCE_REFRESH jobs (últimos 30):');
  sr.forEach((j: any) => console.log(
    ' ', j.status.padEnd(10), 'attempts='+j.attempts+'/'+j.max_attempts,
    'criado='+new Date(j.created_at).toISOString().slice(0,16),
    'updated='+new Date(j.updated_at).toISOString().slice(0,16),
    j.last_error ? 'ERRO: '+j.last_error.slice(0,80) : ''
  ));

  // Fontes com nextRefreshAt no passado
  const overdue = await (prisma as any).$queryRawUnsafe(`
    SELECT COUNT(*) as cnt FROM dbo.cw_dataset_sources
    WHERE active=1 AND mode='extract' AND refresh_policy IN ('hourly','daily','weekly')
    AND next_refresh_at <= SYSUTCDATETIME()
  `) as any[];
  console.log('\nFontes com nextRefreshAt vencido:', overdue[0].cnt);

  await (prisma as any).$disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
