import { prisma } from '../src/server/db';
import { sqlPool } from '../src/server/azure/sql';

async function main() {
  const sourceId = process.argv[2] ?? '78702148-a8e1-4d84-9529-2429243dea26';

  const source = await prisma.datasetSource.findUniqueOrThrow({
    where: { id: sourceId },
    include: {
      targetTable: { select: { sqlName: true, rowCount: true, dataset: { select: { schemaName: true } } } },
    },
  });

  console.log(`Fonte: ${source.name}  kind=${source.sourceKind}  status=${source.lastStatus}`);
  console.log(`Último sync: ${source.lastRefreshedAt?.toISOString()}`);
  console.log(`Próximo sync: ${source.nextRefreshAt?.toISOString()}`);

  const schema = source.targetTable?.dataset?.schemaName ?? 'dbo';
  const table = source.targetTable?.sqlName;
  if (!table) { console.log('Sem target table'); process.exit(1); }

  const pool = await sqlPool();

  // 1. Contagem real vs catálogo
  const countRes = await pool.request().query(
    `SELECT COUNT_BIG(*) AS cnt FROM [${schema}].[${table}]`
  );
  const realCount = Number(countRes.recordset[0].cnt);
  const catalogCount = Number(source.targetTable?.rowCount ?? 0);
  const lastRowCount = Number(source.lastRowCount ?? 0);

  console.log(`\nRows registrados no job (lastRowCount): ${lastRowCount}`);
  console.log(`Rows no catálogo (cw_tables.row_count):  ${catalogCount}`);
  console.log(`Rows reais na tabela target:              ${realCount}`);

  const ok1 = realCount === lastRowCount;
  const ok2 = realCount === catalogCount;
  if (ok1 && ok2) console.log(`✅ Contagens consistentes`);
  else {
    if (!ok1) console.log(`⚠️  lastRowCount (${lastRowCount}) != real (${realCount})`);
    if (!ok2) console.log(`⚠️  catalogCount (${catalogCount}) != real (${realCount})`);
  }

  // 2. Amostra das 5 primeiras linhas — verifica que há dados, não lixo
  const sample = await pool.request().query(
    `SELECT TOP 5 * FROM [${schema}].[${table}] ORDER BY (SELECT NULL)`
  );
  console.log(`\nAmostra de 5 linhas do target (primeiros 5 campos):`);
  for (const [i, row] of sample.recordset.entries()) {
    const preview = Object.entries(row as Record<string, unknown>)
      .slice(0, 5)
      .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
      .join('  ');
    console.log(`  [${i + 1}] ${preview}`);
  }

  // 3. Verifica que não há dados do staging esquecidos (tabela stage_ não deve existir)
  const stageCheck = await pool.request().query(
    `SELECT COUNT(*) AS cnt FROM sys.tables t
     JOIN sys.schemas s ON t.schema_id = s.schema_id
     WHERE s.name = '${schema}' AND t.name LIKE 'cw_stage_%'`
  );
  const stageCount = stageCheck.recordset[0].cnt;
  if (stageCount > 0) {
    console.log(`\n⚠️  ${stageCount} tabelas staging (cw_stage_*) órfãs em ${schema} — podem indicar sync interrompido`);
  } else {
    console.log(`\n✅ Sem tabelas staging órfãs`);
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
