/**
 * Fase 2 — Migração: Azure SQL Server → Postgres (sys_catworld)
 *
 * - Stream direto do SQL Server → COPY INTO Postgres (sem buffer em memória)
 * - Reconecta ao Postgres automaticamente após erro de COPY
 * - Filtra colunas que não existem no destino
 * - Valida contagens ao final
 *
 * Uso:
 *   MSSQL_URL="..." PG_URL="..." node scripts/migrate-to-postgres.cjs
 */

require('dotenv').config()
const sql = require('mssql')
const { Client } = require('pg')
const { from: copyFrom } = require('pg-copy-streams')
const { Transform, pipeline: pipelineCallback } = require('stream')
const { promisify } = require('util')
const pipeline = promisify(pipelineCallback)

const MSSQL_URL = process.env.MSSQL_URL || process.env.CATWORLD_DATABASE_URL
const PG_URL    = process.env.PG_URL

if (!MSSQL_URL || !PG_URL) {
  console.error('Defina PG_URL antes de rodar. MSSQL_URL ou CATWORLD_DATABASE_URL deve estar presente.')
  process.exit(1)
}

// Ordem respeitando FKs
const TABLES = [
  'cw_users',
  'cw_projects',
  'cw_tokens',
  'cw_database_users',
  'cw_connections',
  'cw_datasets',
  'cw_tables',
  'cw_columns',
  'cw_access_grants',
  'cw_dataset_sources',
  'cw_uploads',
  'cw_dataset_versions',
  'cw_derived_tables',
  'cw_saved_queries',
  'cw_audit_events',
  'cw_jobs',
]

const TRUNCATE_ORDER = [...TABLES].reverse()

// ─── SQL Server ──────────────────────────────────────────────────────────────

function parseMssqlUrl(url) {
  const raw = url.replace(/^sqlserver:\/\//, '')
  const semiIdx = raw.indexOf(';')
  const hostPort = semiIdx === -1 ? raw : raw.slice(0, semiIdx)
  const params   = semiIdx === -1 ? ''  : raw.slice(semiIdx + 1)
  const [server, port] = hostPort.split(':')
  const p = {}
  for (const kv of params.split(';')) {
    const eq = kv.indexOf('=')
    if (eq > 0) p[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1)
  }
  return {
    server, port: parseInt(port || '1433'),
    user: p['user'], password: p['password'], database: p['database'],
    encrypt: p['encrypt'] !== 'false',
    trustServerCertificate: p['trustservercertificate'] === 'true',
  }
}

async function connectMssql() {
  const c = parseMssqlUrl(MSSQL_URL)
  return sql.connect({
    server: c.server, port: c.port,
    user: c.user, password: c.password, database: c.database,
    options: { encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate },
    requestTimeout: 120000,
  })
}

// ─── Postgres ────────────────────────────────────────────────────────────────

async function connectPg() {
  const client = new Client({ connectionString: PG_URL })
  await client.connect()
  return client
}

async function getPgColumns(pgClient, table) {
  const r = await pgClient.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND table_schema = 'public'
     ORDER BY ordinal_position`,
    [table]
  )
  return r.rows.map((row) => row.column_name)
}

// ─── Conversão TSV (formato COPY TEXT) ───────────────────────────────────────

function toTsvField(val) {
  if (val === null || val === undefined) return '\\N'
  const s = val instanceof Date ? val.toISOString() : String(val)
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

// Transform: converte recordset do mssql em linhas TSV para o COPY
function makeTsvTransform(cols, total) {
  let count = 0
  return new Transform({
    objectMode: true,
    transform(row, _enc, cb) {
      count++
      if (count % 1000 === 0) {
        const pct = total ? ` ${Math.round((count / total) * 100)}%` : ''
        process.stdout.write(`\r  copiando... ${count}/${total}${pct}   `)
      }
      const line = cols.map((c) => toTsvField(row[c])).join('\t') + '\n'
      cb(null, line)
    },
  })
}

// ─── Migração de uma tabela ───────────────────────────────────────────────────

async function migrateTable(mssqlPool, pgClient, table, srcCount) {
  // Colunas disponíveis no destino
  const pgCols = await getPgColumns(pgClient, table)

  // Lê primeiro batch para descobrir colunas da fonte
  const request = mssqlPool.request()
  request.stream = true
  request.query(`SELECT * FROM [dbo].[${table}]`)

  // Aguarda primeira linha para descobrir colunas
  const firstRow = await new Promise((resolve, reject) => {
    request.once('row', resolve)
    request.once('error', reject)
    request.once('done', () => resolve(null))
  })

  if (!firstRow) return 0 // tabela vazia

  const srcCols     = Object.keys(firstRow)
  const cols        = srcCols.filter((c) => pgCols.includes(c))
  const skipped     = srcCols.filter((c) => !pgCols.includes(c))
  if (skipped.length > 0) process.stdout.write(`\n  (ignoradas: ${skipped.join(', ')}) `)

  const quoted    = cols.map((c) => `"${c}"`).join(', ')
  const copyQuery = `COPY "${table}" (${quoted}) FROM STDIN WITH (FORMAT text, DELIMITER '\t', NULL '\\N')`
  const copyStream = await pgClient.query(copyFrom(copyQuery))
  const tsv        = makeTsvTransform(cols, srcCount)

  // Injeta a primeira linha já lida
  tsv.write(firstRow)

  // Conecta o stream de rows do mssql ao transform
  request.on('row', (row) => tsv.write(row))
  request.once('error', (err) => tsv.destroy(err))
  request.once('done', (result) => {
    tsv.end()
    // result.rowsAffected[0] inclui a primeira linha
  })

  let count = 0
  tsv.on('data', () => count++)

  await pipeline(tsv, copyStream)

  return count
}

// ─── Contagens ───────────────────────────────────────────────────────────────

async function countMssql(pool, table) {
  const r = await pool.request().query(`SELECT COUNT(*) as n FROM [dbo].[${table}]`)
  return r.recordset[0].n
}

async function countPg(pgClient, table) {
  const r = await pgClient.query(`SELECT COUNT(*) as n FROM "${table}"`)
  return parseInt(r.rows[0].n)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Conectando ao SQL Server (Azure)...')
  const mssqlPool = await connectMssql()
  console.log('✓ SQL Server conectado')

  console.log('Conectando ao Postgres...')
  let pgClient = await connectPg()
  console.log('✓ Postgres conectado\n')

  // Limpa destino
  console.log('Limpando tabelas no Postgres...')
  const truncateList = TRUNCATE_ORDER.map((t) => `"${t}"`).join(', ')
  await pgClient.query(`TRUNCATE ${truncateList} RESTART IDENTITY CASCADE`)
  console.log('✓ Tabelas limpas\n')

  const results = []

  for (const table of TABLES) {
    process.stdout.write(`[${table}] `)

    try {
      // Reconecta ao Postgres se necessário (conexão pode ter morrido em erro anterior)
      if (pgClient.ended) {
        pgClient = await connectPg()
      }

      const srcCount = await countMssql(mssqlPool, table)

      if (srcCount === 0) {
        console.log('vazia ✓')
        results.push({ table, status: 'OK', mssql: 0, pg: 0 })
        continue
      }

      process.stdout.write(`${srcCount} linhas → copiando...\n`)
      await migrateTable(mssqlPool, pgClient, table, srcCount)
      process.stdout.write('\r' + ' '.repeat(60) + '\r')

      const pgCount = await countPg(pgClient, table)
      const match   = srcCount === pgCount

      if (match) {
        console.log(` ✓ (${pgCount})`)
        results.push({ table, status: 'OK', mssql: srcCount, pg: pgCount })
      } else {
        console.log(` ⚠️  DIVERGÊNCIA SQL Server=${srcCount} Postgres=${pgCount}`)
        results.push({ table, status: 'DIVERGÊNCIA', mssql: srcCount, pg: pgCount })
      }
    } catch (err) {
      console.log(` ERRO: ${err.message}`)
      results.push({ table, status: 'ERRO', detail: err.message })
      // Recria conexão pg para próxima tabela
      try { await pgClient.end() } catch {}
      pgClient = await connectPg()
    }
  }

  try { await mssqlPool.close() } catch {}
  try { await pgClient.end() } catch {}

  console.log('\n════════════════════════════════════════')
  console.log('RELATÓRIO DE MIGRAÇÃO')
  console.log('════════════════════════════════════════')

  let hasError = false
  for (const r of results) {
    const icon   = r.status === 'OK' ? '✅' : '❌'
    const detail = r.status === 'OK'
      ? `${r.mssql} linhas`
      : r.detail || `SQL Server=${r.mssql} Postgres=${r.pg}`
    console.log(`${icon} ${r.table.padEnd(26)} ${r.status.padEnd(14)} ${detail}`)
    if (r.status !== 'OK') hasError = true
  }

  console.log('════════════════════════════════════════')
  if (hasError) {
    console.log('\n⚠️  Migração com erros. Verifique antes de prosseguir para a Fase 3.')
    process.exit(1)
  } else {
    console.log('\n✅ Migração concluída. Dados validados.')
    console.log('   Próximo passo: Fase 3 — atualizar CATWORLD_DATABASE_URL para o Postgres.')
  }
}

main().catch((err) => {
  console.error('\nErro fatal:', err)
  process.exit(1)
})
