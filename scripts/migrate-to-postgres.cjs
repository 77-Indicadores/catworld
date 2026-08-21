/**
 * Fase 2 — Migração: Azure SQL Server → Postgres (sys_catworld)
 *
 * Estratégia em 3 passos por tabela:
 *   1. Lê do SQL Server e salva TSV em disco (tmp/)
 *   2. Fecha conexão SQL Server
 *   3. Faz COPY FROM do arquivo TSV pro Postgres
 *
 * Vantagens:
 *   - Nunca mantém as duas conexões abertas ao mesmo tempo
 *   - Resume automático: se TSV já existe e tem linhas corretas, pula leitura
 *   - Paraleliza tabelas dentro do mesmo nível de FK
 *   - Sem pressão de memória (streaming pra disco)
 *
 * Uso:
 *   node scripts/migrate-to-postgres.cjs
 */

require('dotenv').config()
const sql    = require('mssql')
const { Client } = require('pg')
const { from: copyFrom } = require('pg-copy-streams')
const fs     = require('fs')
const path   = require('path')
const os     = require('os')

const MSSQL_URL = process.env.MSSQL_URL || process.env.CATWORLD_DATABASE_URL
const PG_URL    = process.env.PG_URL

if (!MSSQL_URL || !PG_URL) {
  console.error('Defina PG_URL. MSSQL_URL ou CATWORLD_DATABASE_URL deve estar presente.')
  process.exit(1)
}

const TMP_DIR = path.join(os.tmpdir(), 'catworld-migration')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// Níveis de FK — tabelas no mesmo nível rodam em paralelo
const FK_LEVELS = [
  ['cw_users'],
  ['cw_projects', 'cw_tokens', 'cw_database_users'],
  ['cw_connections', 'cw_datasets'],
  ['cw_tables', 'cw_access_grants', 'cw_dataset_sources'],
  ['cw_uploads', 'cw_columns', 'cw_derived_tables'],
  ['cw_dataset_versions', 'cw_saved_queries', 'cw_audit_events', 'cw_jobs'],
]

const TRUNCATE_ORDER = FK_LEVELS.flat().reverse()

// Filtros por tabela — WHERE clause aplicada no SELECT do SQL Server e no COUNT
const TABLE_WHERE = {
  cw_uploads:          `created_at >= DATEADD(day, -3, GETUTCDATE())`,
  cw_dataset_versions: `created_at >= DATEADD(day, -3, GETUTCDATE())`,
  cw_audit_events:     `created_at >= DATEADD(day, -3, GETUTCDATE())`,
  cw_jobs:             `created_at >= DATEADD(day, -3, GETUTCDATE())`,
}

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
    requestTimeout: 300000,
    pool: { max: 10 },
  })
}

async function connectPg() {
  const client = new Client({ connectionString: PG_URL })
  await client.connect()
  await client.query('SET statement_timeout = 0')
  return client
}

// ─── TSV ─────────────────────────────────────────────────────────────────────

function toTsvField(val) {
  if (val === null || val === undefined) return '\\N'
  const s = val instanceof Date ? val.toISOString() : String(val)
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

// ─── Passo 1: SQL Server → arquivo TSV ───────────────────────────────────────

async function dumpToFile(mssqlPool, table, pgCols) {
  const tsvPath  = path.join(TMP_DIR, `${table}.tsv`)
  const metaPath = path.join(TMP_DIR, `${table}.meta.json`)

  // Campos excluídos da migração (dados grandes/desnecessários para histórico)
  const EXCLUDE_COLS = {
    cw_uploads: ['preview_json', 'mapping_json'],
  }

  const request = mssqlPool.request()
  request.stream = true
  const where = TABLE_WHERE[table] ? ` WHERE ${TABLE_WHERE[table]}` : ''
  request.query(`SELECT * FROM [dbo].[${table}]${where}`)

  let cols = null
  let count = 0
  const start = Date.now()
  const writer = fs.createWriteStream(tsvPath)

  await new Promise((resolve, reject) => {
    writer.on('error', reject)
    request.on('row', row => {
      if (!cols) {
        const excluded = EXCLUDE_COLS[table] || []
        const srcCols = Object.keys(row)
        cols = srcCols.filter(c => pgCols.includes(c) && !excluded.includes(c))
        const skipped = srcCols.filter(c => !pgCols.includes(c) || excluded.includes(c))
        if (skipped.length > 0)
          process.stdout.write(`\n  [${table}] ignoradas: ${skipped.join(', ')}\n`)
      }
      count++
      if (count % 10000 === 0) {
        const rps = Math.round(count / ((Date.now() - start) / 1000))
        process.stdout.write(`\r  [${table}] lendo... ${count} (${rps} rows/s)   `)
      }
      writer.write(cols.map(c => toTsvField(row[c])).join('\t') + '\n')
    })
    request.once('error', err => { writer.destroy(); reject(err) })
    request.once('done', () => writer.end(resolve))
  })

  fs.writeFileSync(metaPath, JSON.stringify({ cols, count }))
  return { tsvPath, cols, count }
}

// ─── Passo 2: arquivo TSV → Postgres COPY ────────────────────────────────────

async function copyFromFile(table, tsvPath, cols) {
  const quoted    = cols.map(c => `"${c}"`).join(', ')
  const copyQuery = `COPY "${table}" (${quoted}) FROM STDIN WITH (FORMAT text, DELIMITER '\t', NULL '\\N')`

  const pg = await connectPg()
  try {
    const copyStream = await pg.query(copyFrom(copyQuery))
    const fileStream = fs.createReadStream(tsvPath)

    await new Promise((resolve, reject) => {
      copyStream.on('finish', resolve)
      copyStream.on('error', reject)
      fileStream.on('error', reject)
      fileStream.pipe(copyStream)
    })
  } finally {
    await pg.end().catch(() => {})
  }
}

// ─── Contagens ───────────────────────────────────────────────────────────────

async function countMssql(pool, table) {
  const where = TABLE_WHERE[table] ? ` WHERE ${TABLE_WHERE[table]}` : ''
  const r = await pool.request().query(`SELECT COUNT(*) AS n FROM [dbo].[${table}]${where}`)
  return r.recordset[0].n
}

async function countPg(pgClient, table) {
  const r = await pgClient.query(`SELECT COUNT(*) AS n FROM "${table}"`)
  return parseInt(r.rows[0].n)
}

async function getPgColumns(pgClient, table) {
  const r = await pgClient.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND table_schema = 'public'
     ORDER BY ordinal_position`, [table]
  )
  return r.rows.map(row => row.column_name)
}

// ─── Migra uma tabela ─────────────────────────────────────────────────────────

async function migrateTable(mssqlPool, table, srcCount) {
  const tsvPath  = path.join(TMP_DIR, `${table}.tsv`)
  const metaPath = path.join(TMP_DIR, `${table}.meta.json`)

  const pgProbe = await connectPg()
  const pgCols  = await getPgColumns(pgProbe, table)
  await pgProbe.end()

  let cols, fileCount

  // Resume: se TSV já existe com contagem correta, pula leitura
  if (fs.existsSync(metaPath) && fs.existsSync(tsvPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    if (meta.count === srcCount) {
      process.stdout.write(`\r  [${table}] TSV já existe (${meta.count} linhas), pulando leitura\n`)
      cols = meta.cols
      fileCount = meta.count
    }
  }

  if (!cols) {
    process.stdout.write(`  [${table}] lendo do SQL Server...\n`)
    const result = await dumpToFile(mssqlPool, table, pgCols)
    cols = result.cols
    fileCount = result.count
    process.stdout.write(`\r  [${table}] ${fileCount} linhas salvas em disco (${(fs.statSync(tsvPath).size / 1024 / 1024).toFixed(1)} MB)\n`)
  }

  // COPY para Postgres
  process.stdout.write(`  [${table}] copiando para Postgres...\n`)
  const t = Date.now()
  await copyFromFile(table, tsvPath, cols)
  const elapsed = ((Date.now() - t) / 1000).toFixed(1)

  // Valida
  const pgFinal = await connectPg()
  const pgCount = await countPg(pgFinal, table)
  await pgFinal.end()

  const rps = Math.round(fileCount / ((Date.now() - t + 1) / 1000))
  process.stdout.write(`  [${table}] ✓ ${pgCount}/${srcCount} linhas (COPY ${elapsed}s)\n`)

  // Limpa TSV após sucesso
  if (pgCount === srcCount) {
    fs.unlinkSync(tsvPath)
    fs.unlinkSync(metaPath)
  }

  return pgCount
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now()
  console.log(`Arquivos temporários em: ${TMP_DIR}\n`)

  console.log('Conectando ao SQL Server (Azure)...')
  const mssqlPool = await connectMssql()
  console.log('✓ SQL Server conectado')

  const pgMain = await connectPg()
  console.log('✓ Postgres conectado\n')

  // Contagens
  console.log('Contando linhas no SQL Server...')
  const srcCounts = {}
  for (const table of FK_LEVELS.flat()) {
    srcCounts[table] = await countMssql(mssqlPool, table)
  }
  const total = Object.values(srcCounts).reduce((a, b) => a + b, 0)
  console.log(`Total: ${total.toLocaleString()} linhas\n`)

  // Resume: verifica quais já estão ok
  console.log('Verificando estado atual do Postgres...')
  const skip = new Set()
  for (const table of FK_LEVELS.flat()) {
    if (srcCounts[table] === 0) { skip.add(table); continue }
    try {
      const pgCount = await countPg(pgMain, table)
      if (pgCount === srcCounts[table]) {
        console.log(`  ✓ ${table} já migrada (${pgCount} linhas)`)
        skip.add(table)
      }
    } catch {}
  }

  const toMigrate = FK_LEVELS.flat().filter(t => !skip.has(t))
  if (toMigrate.length === 0) {
    console.log('\n✅ Todas as tabelas já estão migradas.')
    await mssqlPool.close(); await pgMain.end(); return
  }

  // TRUNCATE
  const truncateList = TRUNCATE_ORDER.filter(t => toMigrate.includes(t)).map(t => `"${t}"`).join(', ')
  if (truncateList) {
    console.log('\nLimpando tabelas no Postgres...')
    await pgMain.query(`TRUNCATE ${truncateList} RESTART IDENTITY CASCADE`)
    console.log('✓ Tabelas limpas\n')
  }

  await pgMain.end()

  const results = []

  for (const level of FK_LEVELS) {
    const tables = level.filter(t => toMigrate.includes(t))
    if (!tables.length) continue

    console.log(`\n[${tables.join(' + ')}]`)
    const levelStart = Date.now()

    await Promise.all(tables.map(async table => {
      if (srcCounts[table] === 0) {
        console.log(`  ${table}: vazia ✓`)
        results.push({ table, status: 'OK', src: 0, pg: 0 })
        return
      }
      try {
        const pgCount = await migrateTable(mssqlPool, table, srcCounts[table])
        if (pgCount === srcCounts[table]) {
          results.push({ table, status: 'OK', src: srcCounts[table], pg: pgCount })
        } else {
          results.push({ table, status: 'DIVERGÊNCIA', src: srcCounts[table], pg: pgCount })
        }
      } catch (err) {
        console.log(`  [${table}] ERRO: ${err.message}`)
        results.push({ table, status: 'ERRO', src: srcCounts[table], pg: 0, detail: err.message })
      }
    }))

    console.log(`  └ nível concluído em ${((Date.now() - levelStart) / 1000).toFixed(1)}s`)
  }

  await mssqlPool.close()

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log('\n════════════════════════════════════════')
  console.log('RELATÓRIO DE MIGRAÇÃO')
  console.log('════════════════════════════════════════')

  let hasError = false
  for (const r of results) {
    const icon   = r.status === 'OK' ? '✅' : '❌'
    const detail = r.status === 'OK' ? `${r.src.toLocaleString()} linhas` : r.detail || `Azure=${r.src} PG=${r.pg}`
    console.log(`${icon} ${r.table.padEnd(26)} ${r.status.padEnd(14)} ${detail}`)
    if (r.status !== 'OK') hasError = true
  }

  console.log('════════════════════════════════════════')
  console.log(`Tempo total: ${elapsed}s`)

  if (hasError) {
    console.log('\n⚠️  Migração com erros.')
    process.exit(1)
  } else {
    console.log('\n✅ Migração concluída. Dados validados.')
    console.log('   Próximo passo: Fase 3 — atualizar CATWORLD_DATABASE_URL para o Postgres.')
  }
}

main().catch(err => {
  console.error('\nErro fatal:', err.message)
  process.exit(1)
})
