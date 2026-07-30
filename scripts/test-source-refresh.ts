import { prisma } from '../src/server/db';
import { refreshDatasetSource } from '../src/server/connections/sources';

async function main() {
  const sourceId = process.argv[2];
  if (!sourceId) { console.error('Usage: tsx scripts/test-source-refresh.ts <sourceId>'); process.exit(1); }

  const before = await prisma.datasetSource.findUniqueOrThrow({
    where: { id: sourceId },
    select: { name: true, lastStatus: true, lastRowCount: true, lastRefreshedAt: true, lastDeltaValue: true },
  });
  console.log('Antes:', JSON.stringify(before, (_, v) => typeof v === 'bigint' ? v.toString() : v));

  console.log('\nExecutando refreshDatasetSource...');
  const start = Date.now();
  await refreshDatasetSource(sourceId);
  console.log(`Concluído em ${((Date.now() - start) / 1000).toFixed(1)}s\n`);

  const after = await prisma.datasetSource.findUniqueOrThrow({
    where: { id: sourceId },
    select: { name: true, lastStatus: true, lastRowCount: true, lastRefreshedAt: true, lastDeltaValue: true, nextRefreshAt: true },
  });
  console.log('Depois:', JSON.stringify(after, (_, v) => typeof v === 'bigint' ? v.toString() : v));

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
