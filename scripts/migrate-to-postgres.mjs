/**
 * Fase 2 — Migração de dados: Azure SQL Server → Postgres (sys_catworld)
 *
 * Lê todas as tabelas cw_* do Azure e insere no Postgres.
 * Não modifica o Azure. Valida contagem de linhas ao final.
 *
 * Uso:
 *   node scripts/migrate-to-postgres.mjs
 *
 * Env necessárias:
 *   MSSQL_URL  — connection string do Azure (atual CATWORLD_DATABASE_URL)
 *   PG_URL     — connection string do Postgres (sys_catworld)
 */

import sql from 'mssql'
import pg from 'pg'

const MSSQL_URL = process.env.MSSQL_URL
const PG_URL = process.env.PG_URL

if (!MSSQL_URL || !PG_URL) {
  console.error('Defina MSSQL_URL e PG_URL antes de rodar.')
  process.exit(1)
}

// ─── Ordem respeitando FKs ─────────────────────────────────────────────────
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
  'cw_saved_queries',
  'cw_audit_events',
  'cw_jobs',
]

// cw_storage_servers não existe no Azure — pulamos (tabela nova)

// ─── Conectar SQL Server ───────────────────────────────────────────────────
async function connectMssql() {
  // Parseia sqlserver://user:pass@host:port;database=X;...
  const raw = MSSQL_URL.replace(/^sqlserver:\/\//, '')
  const [credentials, ...rest] = raw.split('@')
  const [user, password] = credentials.split(':')
  const [hostPort, ...params] = rest.join('@').split(';')
  const [server, port] = hostPort.split(':')

  const paramMap = {}
  for (const p of params) {
    const [k, v] = p.split('=')
    if (k && v) paramMap[k.toLowerCase()] = v
  }

  const pool = await sql.connect({
    server,
    port: parseInt(port || '1433'),
    user,
    password,
    database: paramMap['database'],
    options: {
      encrypt: paramMap['encrypt'] !== 'false',
      trustServerCertificate: paramMap['trustservercertificate'] === 'true',
    },
  })
  return pool
}

// ─── Conectar Postgres ─────────────────────────────────────────────────────
function connectPg() {
  const client = new pg.Client({ connectionString: PG_URL })
  return client.connect().then(() => client)
}

// ─── Ler todas as linhas de uma tabela no SQL Server ──────────────────────
async function readMssql(pool, table) {
  const result = await pool.request().query(`SELECT * FROM [dbo].[${table}]`)
  return result.recordset
}

// ─── Converter valores SQL Server → Postgres ──────────────────────────────
function convertRow(row) {
  const out = {}
  for (const [key, val] of Object.entries(row)) {
    if (val === null || val === undefined) {
      out[key] = null
    } else if (Buffer.isBuffer(val)) {
      // UNIQUEIDENTIFIER vem como Buffer em alguns drivers
      out[key] = val.toString('hex')
    } else if (val instanceof Date) {
      out[key] = val.toISOString()
    } else {
      out[key] = val
    }
  }
  return out
}

// ─── Inserir batch no Postgres ─────────────────────────────────────────────
async function insertBatch(pgClient, table, rows) {
  if (rows.length === 0) return

  const columns = Object.keys(rows[0])
  const quoted = columns.map((c) => `"${c}"`)

  for (const row of rows) {
    const values = columns.map((c) => row[c])
    const placeholders = values.map((_, i) => `$${i + 1}`)
    const query = `INSERT INTO "${table}" (${quoted.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT DO NOTHING`
    await pgClient.query(query, values)
  }
}

// ─── Contar linhas ─────────────────────────────────────────────────────────
async function countMssql(pool, table) {
  const r = await pool.request().query(`SELECT COUNT(*) as n FROM [dbo].[${table}]`)
  return r.recordset[0].n
}

async function countPg(pgClient, table) {
  const r = await pgClient.query(`SELECT COUNT(*) as n FROM "${table}"`)
  return parseInt(r.rows[0].n)
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('Conectando ao SQL Server (Azure)...')
  const mssqlPool = await connectMssql()
  console.log('✓ SQL Server conectado')

  console.log('Conectando ao Postgres (sys_catworld)...')
  const pgClient = await connectPg()
  console.log('✓ Postgres conectado\n')

  const results = []

  for (const table of TABLES) {
    process.stdout.write(`[${table}] lendo...`)
    let rows
    try {
      rows = await readMssql(mssqlPool, table)
    } catch (err) {
      console.log(` ERRO ao ler: ${err.message}`)
      results.push({ table, status: 'ERRO_LEITURA', detail: err.message })
      continue
    }

    console.log(` ${rows.length} linhas`)

    if (rows.length === 0) {
      results.push({ table, status: 'OK', mssql: 0, pg: 0 })
      continue
    }

    process.stdout.write(`[${table}] inserindo...`)

    // Desabilita FKs temporariamente via transação isolada não é possível no PG
    // Inserimos em ordem de dependência para evitar violações

    try {
      const converted = rows.map(convertRow)
      const BATCH = 500
      for (let i = 0; i < converted.length; i += BATCH) {
        await insertBatch(pgClient, table, converted.slice(i, i + BATCH))
        process.stdout.write(`.`)
      }
      console.log(` ✓`)
    } catch (err) {
      console.log(` ERRO ao inserir: ${err.message}`)
      results.push({ table, status: 'ERRO_INSERÇÃO', detail: err.message })
      continue
    }

    // Validação de contagem
    const mssqlCount = await countMssql(mssqlPool, table)
    const pgCount = await countPg(pgClient, table)
    const match = mssqlCount === pgCount

    results.push({
      table,
      status: match ? 'OK' : 'DIVERGÊNCIA',
      mssql: mssqlCount,
      pg: pgCount,
    })

    if (!match) {
      console.log(`  ⚠️  DIVERGÊNCIA: SQL Server=${mssqlCount} Postgres=${pgCount}`)
    }
  }

  await mssqlPool.close()
  await pgClient.end()

  // ─── Relatório final ────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════')
  console.log('RELATÓRIO DE MIGRAÇÃO')
  console.log('════════════════════════════════════════')

  let hasError = false
  for (const r of results) {
    const icon = r.status === 'OK' ? '✅' : '❌'
    const detail = r.status === 'OK'
      ? `${r.mssql} linhas`
      : r.detail || `SQL Server=${r.mssql} Postgres=${r.pg}`
    console.log(`${icon} ${r.table.padEnd(26)} ${r.status.padEnd(14)} ${detail}`)
    if (r.status !== 'OK') hasError = true
  }

  console.log('════════════════════════════════════════')
  if (hasError) {
    console.log('\n⚠️  Migração concluída com erros. Verifique antes de prosseguir.')
    process.exit(1)
  } else {
    console.log('\n✅ Migração concluída com sucesso. Dados validados.')
    console.log('   Próximo passo: Fase 3 — atualizar CATWORLD_DATABASE_URL para o Postgres.')
  }
}

main().catch((err) => {
  console.error('\nErro fatal:', err)
  process.exit(1)
})
