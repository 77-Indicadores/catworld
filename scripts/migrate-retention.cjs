/**
 * Cria a tabela cw_system_settings e semeia os defaults de retenção.
 * Uso: node scripts/migrate-retention.cjs
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const { Client } = require('pg')

const pg = new Client({ connectionString: process.env.CATWORLD_DATABASE_URL })

async function run() {
  await pg.connect()

  await pg.query(`
    CREATE TABLE IF NOT EXISTS cw_system_settings (
      key        VARCHAR(120) PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
    )
  `)
  console.log('cw_system_settings OK')

  const defaults = [
    ['retention.jobs_days',             '30'],
    ['retention.audit_events_days',     '30'],
    ['retention.uploads_days',          '30'],
    ['retention.dataset_versions_keep', '10'],
  ]

  for (const [key, value] of defaults) {
    await pg.query(
      `INSERT INTO cw_system_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [key, value]
    )
    console.log(`  ${key} = ${value}`)
  }

  await pg.end()
  console.log('done')
}

run().catch(e => { console.error(e.message); process.exit(1) })
