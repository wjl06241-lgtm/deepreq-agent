// User-authorized scope: hermes_carter.public.messages, agent maxiao, owner 汪晓东.
// Stages raw history only. Never activates history, creates tasks, or sends messages.
import { Client } from 'pg'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/config.js'

loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const sourceUrl = new URL(process.env.DATABASE_URL)
sourceUrl.pathname = '/hermes_carter'
const settings = { connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000 }
const source = new Client({ ...settings, connectionString: sourceUrl.toString() })
const target = new Client({ ...settings, connectionString: process.env.DATABASE_URL })
source.on('error', () => {}); target.on('error', () => {})
try {
  await source.connect()
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const rows = (await source.query(`SELECT m.id::text AS source_id,
    to_jsonb(m) || jsonb_build_object('_source_conversation',to_jsonb(c)) AS raw_record
    FROM public.messages m LEFT JOIN public.conversations c ON c.id=m.conversation_id
    WHERE m.agent_id=$1 ORDER BY m.id`, ['maxiao'])).rows
  if (!rows.length) throw Object.assign(new Error('No source rows'), { code: 'EMPTY_SOURCE' })
  await target.connect()
  await target.query('BEGIN')
  await target.query(`ALTER TABLE requirement_assistant.legacy_imports
    ADD COLUMN IF NOT EXISTS expected_owner_name text,
    ADD COLUMN IF NOT EXISTS source_agent_id text`)
  const payload = JSON.stringify(rows)
  const result = await target.query(`INSERT INTO requirement_assistant.legacy_imports
    (source_system,source_table,source_id,raw_record,expected_owner_name,source_agent_id)
    SELECT 'hermes_carter','public.messages',r.source_id,r.raw_record,'汪晓东','maxiao'
    FROM jsonb_to_recordset($1::jsonb) AS r(source_id text,raw_record jsonb)
    ON CONFLICT(source_system,source_table,source_id) DO NOTHING`, [payload])
  const inserted = result.rowCount
  const verified = await target.query(`SELECT count(*)::int AS matched
    FROM jsonb_to_recordset($1::jsonb) AS r(source_id text,raw_record jsonb)
    JOIN requirement_assistant.legacy_imports t ON t.source_system='hermes_carter'
      AND t.source_table='public.messages' AND t.source_id=r.source_id
    WHERE t.raw_record=r.raw_record AND t.expected_owner_name='汪晓东'
      AND t.source_agent_id='maxiao' AND t.mapped_user_id IS NULL AND t.status='pending'`,[payload])
  if (verified.rows[0].matched !== rows.length) throw Object.assign(new Error('Staging differs'), {code:'STAGING_CONFLICT'})
  await source.query('COMMIT')
  await target.query('COMMIT')
  console.log(JSON.stringify({ sourceRows: rows.length, inserted, verified: rows.length,
    ownerName: '汪晓东', status: 'pending_identity', sourceUnchanged: true }))
} catch (error) {
  await target.query('ROLLBACK').catch(() => {})
  await source.query('ROLLBACK').catch(() => {})
  console.error(JSON.stringify({ errorCode: /^[A-Z0-9_]{3,30}$/.test(error.code || '') ? error.code : (/timeout/i.test(error.message || '') ? 'TIMEOUT' : 'STAGING_FAILED') }))
  process.exitCode = 1
} finally {
  await source.end().catch(() => {}); await target.end().catch(() => {})
}
