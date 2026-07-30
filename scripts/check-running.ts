import { prisma } from '../src/server/db';

async function main() {
  const running = await (prisma as any).$queryRawUnsafe(`
    SELECT id, type, status, weight, locked_by
    FROM dbo.cw_jobs
    WHERE status IN ('RUNNING','QUEUED') AND type NOT LIKE '%SOURCE%'
    ORDER BY status, weight
  `) as any[];
  console.log('Jobs não-SOURCE em RUNNING/QUEUED:', running.length);
  running.forEach((j: any) => console.log(' ', j.type, j.status, 'weight='+j.weight, j.locked_by ?? ''));
  await (prisma as any).$disconnect();
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
