import { prisma } from '../src/server/db';

async function main() {
  const nameFilter = process.argv[2] ?? 'auvo';

  const sources = await prisma.datasetSource.findMany({
    where: { name: { contains: nameFilter } },
    include: {
      dataset: { select: { name: true, schemaName: true, project: { select: { name: true } } } },
      targetTable: { select: { sqlName: true, rowCount: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  if (!sources.length) {
    console.log(`Nenhuma fonte com nome contendo "${nameFilter}" encontrada.`);
    process.exit(0);
  }

  for (const s of sources) {
    const projeto = s.dataset?.project?.name ?? '?';
    const dataset = s.dataset?.name ?? '?';
    const now = new Date();
    const isOverdue = s.nextRefreshAt && s.nextRefreshAt < now && s.lastStatus === 'completed';

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Projeto: ${projeto} → Dataset: ${dataset}`);
    console.log(`Fonte: ${s.name} [${s.id}]`);
    console.log(`Modo: ${s.mode}  Tabela origem: ${s.sourceTable ?? '(query)'}  Policy: ${s.refreshPolicy}`);
    console.log(`KeyColumn: ${s.keyColumn ?? 'nenhuma'}  DeltaColumn: ${s.deltaColumn ?? 'nenhuma'}`);
    console.log(`lastDeltaValue: ${s.lastDeltaValue ?? 'null'}`);
    console.log(`Status: ${s.lastStatus}  Rows: ${s.lastRowCount?.toString() ?? 'null'}`);
    console.log(`Último sync: ${s.lastRefreshedAt?.toISOString() ?? 'nunca'}`);
    console.log(`Próximo sync: ${s.nextRefreshAt?.toISOString() ?? 'null'} ${isOverdue ? '⚠️  ATRASADO' : ''}`);
    console.log(`Ativa: ${s.active}  Target: ${s.targetTable?.sqlName ?? '?'} (${s.targetTable?.rowCount?.toString() ?? '?'} rows no catálogo)`);

    // Jobs recentes para esta fonte
    const jobs = await prisma.$queryRawUnsafe<{
      id: string; status: string; attempts: number; max_attempts: number;
      created_at: Date; updated_at: Date; last_error: string | null;
    }[]>(
      `SELECT TOP 5 id, status, attempts, max_attempts, created_at, updated_at, last_error
       FROM dbo.cw_jobs
       WHERE type='SOURCE_REFRESH' AND payload_json=@P1
       ORDER BY created_at DESC`,
      JSON.stringify({ datasetSourceId: s.id }),
    );

    if (jobs.length) {
      console.log('\nJobs recentes:');
      for (const j of jobs) {
        console.log(`  ${j.status.padEnd(10)} tentativa ${j.attempts}/${j.max_attempts}  criado ${j.created_at.toISOString().slice(0,19)}  updated ${j.updated_at.toISOString().slice(0,19)}${j.last_error ? `  ERRO: ${j.last_error.slice(0,100)}` : ''}`);
      }
    } else {
      console.log('\nNenhum job SOURCE_REFRESH encontrado para esta fonte.');
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
