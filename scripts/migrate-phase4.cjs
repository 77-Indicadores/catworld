/**
 * Fase 4 — Migração de schema: adiciona storage_server_id aos datasets
 * e cadastra o Azure SQL Server como StorageServer default no Postgres.
 *
 * Uso:
 *   PG_URL=... CATWORLD_MSSQL_URL=... node scripts/migrate-phase4.cjs
 */

require('dotenv').config()
const { Client } = require('pg')
const { randomUUID } = require('crypto')

const PG_URL = process.env.PG_URL || process.env.CATWORLD_DATABASE_URL
const MSSQL_URL = process.env.CATWORLD_MSSQL_URL || process.env.MSSQL_URL

if (!PG_URL) { console.error('PG_URL ou CATWORLD_DATABASE_URL obrigatório'); process.exit(1) }
if (!MSSQL_URL) { console.error('CATWORLD_MSSQL_URL obrigatório'); process.exit(1) }

async function main() {
  const pg = new Client({ connectionString: PG_URL })
  await pg.connect()

  try {
    // 1. Cria tabela cw_storage_servers se não existir
    await pg.query(`
      CREATE TABLE IF NOT EXISTS cw_storage_servers (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name       VARCHAR(120) NOT NULL,
        url        TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP(3) NOT NULL DEFAULT NOW()
      )
    `)
    console.log('✓ cw_storage_servers ok')

    // 2. Adiciona coluna storage_server_id em cw_datasets (se não existir)
    await pg.query(`
      ALTER TABLE cw_datasets
      ADD COLUMN IF NOT EXISTS storage_server_id UUID REFERENCES cw_storage_servers(id)
    `)
    console.log('✓ cw_datasets.storage_server_id ok')

    // 3. Verifica se já existe um StorageServer default
    const existing = await pg.query(`SELECT id FROM cw_storage_servers WHERE is_default = true LIMIT 1`)
    let defaultId

    if (existing.rows.length > 0) {
      defaultId = existing.rows[0].id
      // Atualiza URL caso tenha mudado
      await pg.query(`UPDATE cw_storage_servers SET url = $1, updated_at = NOW() WHERE id = $2`, [MSSQL_URL, defaultId])
      console.log(`✓ StorageServer default já existe (${defaultId}), URL atualizada`)
    } else {
      defaultId = randomUUID()
      await pg.query(
        `INSERT INTO cw_storage_servers (id, name, url, is_default) VALUES ($1, $2, $3, true)`,
        [defaultId, 'Azure SQL Server (default)', MSSQL_URL]
      )
      console.log(`✓ StorageServer default criado (${defaultId})`)
    }

    // 4. Aponta todos os datasets sem storage_server_id para o default
    const updated = await pg.query(
      `UPDATE cw_datasets SET storage_server_id = $1, updated_at = NOW() WHERE storage_server_id IS NULL`,
      [defaultId]
    )
    console.log(`✓ ${updated.rowCount} datasets apontados para o StorageServer default`)

    console.log('\n✅ Migração Fase 4 concluída.')
    console.log(`   StorageServer ID: ${defaultId}`)
    console.log('   Próximo passo: adicionar CATWORLD_MSSQL_URL no Coolify e fazer deploy.')
  } finally {
    await pg.end()
  }
}

main().catch(e => { console.error('Erro:', e.message); process.exit(1) })
