import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/config.js'

loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL 配置')
const client = new Client({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000, query_timeout: 30000,
  application_name: 'requirement-assistant-migrate' })
client.on('error', () => {})
try {
  const version = process.argv.includes('--v9') ? 'v9' : process.argv.includes('--v8') ? 'v8' : process.argv.includes('--v7') ? 'v7' : process.argv.includes('--v6') ? 'v6' : process.argv.includes('--v5') ? 'v5' : process.argv.includes('--v4') ? 'v4' : process.argv.includes('--v3') ? 'v3' : process.argv.includes('--v2') ? 'v2' : 'v1'
  const sql = await readFile(new URL('../docs/db/postgresql-' + version + '.sql', import.meta.url), 'utf8')
  await client.connect()
  await client.query(sql)
  console.log('POSTGRES-SCHEMA-CREATED')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  const code = /^[A-Z0-9_]{3,30}$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED'
  console.error(JSON.stringify({ initialized: false, code }))
  process.exitCode = 1
} finally { await client.end().catch(() => {}) }
