import { Client } from 'pg'
import { loadEnvFile } from '../src/config.js'
import { fileURLToPath } from 'node:url'

loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL 配置')
const client = new Client({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000, query_timeout: 10000,
  application_name: 'requirement-assistant-check' })
client.on('error', () => {})
try {
  await client.connect()
  await client.query('BEGIN READ ONLY')
  const info = await client.query(`SELECT current_database() AS database,
    current_user AS username, current_setting('server_version') AS version,
    has_database_privilege(current_database(), 'CREATE') AS can_create_schema`)
  const tables = await client.query(`SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema = 'requirement_assistant' ORDER BY table_name`)
  await client.query('COMMIT')
  console.log(JSON.stringify({ connected: true, ...info.rows[0], tables: tables.rows }))
} catch (error) {
  // Never print raw errors: connection strings and server details can contain secrets.
  const code = /^[A-Z0-9_]{3,30}$/.test(error.code || '') ? error.code : 'CONNECTION_FAILED'
  console.error(JSON.stringify({ connected: false, code }))
  process.exitCode = 1
} finally { await client.end().catch(() => {}) }
