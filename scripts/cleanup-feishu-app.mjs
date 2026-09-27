import { Client } from 'pg'
import { loadEnvFile } from '../src/config.js'
import { fileURLToPath } from 'node:url'

loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const appId = args.find((arg) => arg.startsWith('cli_')) || ''
const externalIds = args
  .filter((arg) => arg.startsWith('--external-user-id='))
  .map((arg) => arg.slice('--external-user-id='.length))
  .filter(Boolean)
const externalIdFilter = externalIds.length ? externalIds : null

if (!appId) throw new Error('请明确提供要清理的飞书应用 ID')
if (apply && appId === process.env.FEISHU_APP_ID && !externalIdFilter) {
  throw new Error('拒绝清理当前运行中的整个飞书应用；请明确指定用户')
}
if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL 配置')

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 20_000,
  query_timeout: 30_000,
  application_name: 'requirement-assistant-app-cleanup',
})

const countSql = `
  WITH target_users AS (
    SELECT id FROM requirement_assistant.users
    WHERE platform = 'feishu' AND app_id = $1
      AND ($2::text[] IS NULL OR external_user_id = ANY($2::text[]))
  ), target_conversations AS (
    SELECT id FROM requirement_assistant.conversations
    WHERE user_id IN (SELECT id FROM target_users)
  )
  SELECT
    (SELECT count(*) FROM target_users)::int AS users,
    (SELECT count(*) FROM target_conversations)::int AS conversations,
    (SELECT count(*) FROM requirement_assistant.messages
      WHERE user_id IN (SELECT id FROM target_users))::int AS messages,
    (SELECT count(*) FROM requirement_assistant.tasks
      WHERE user_id IN (SELECT id FROM target_users))::int AS tasks,
    (SELECT count(*) FROM requirement_assistant.attachments
      WHERE user_id IN (SELECT id FROM target_users))::int AS attachments,
    (SELECT count(*) FROM requirement_assistant.records
      WHERE ($2::text[] IS NULL AND app_id = $1)
         OR user_id IN (SELECT id FROM target_users))::int AS records,
    (SELECT count(*) FROM requirement_assistant.inbound_events
      WHERE platform = 'feishu' AND app_id = $1
        AND message_id IN (SELECT id FROM requirement_assistant.messages
          WHERE user_id IN (SELECT id FROM target_users)))::int AS inbound_events
`

async function counts() {
  return (await client.query(countSql, [appId, externalIdFilter])).rows[0]
}

try {
  await client.connect()
  await client.query('BEGIN')
  const before = await counts()

  if (!apply) {
    const profiles = (await client.query(`
      SELECT display_name, external_user_id, created_at
      FROM requirement_assistant.users
      WHERE platform = 'feishu' AND app_id = $1
        AND ($2::text[] IS NULL OR external_user_id = ANY($2::text[]))
      ORDER BY created_at
    `, [appId, externalIdFilter])).rows
    await client.query('ROLLBACK')
    console.log(JSON.stringify({ mode: 'preview', appId, counts: before, profiles }))
    process.exit(0)
  }

  await client.query(`
    CREATE TEMP TABLE cleanup_users ON COMMIT DROP AS
    SELECT id FROM requirement_assistant.users
    WHERE platform = 'feishu' AND app_id = $1
      AND ($2::text[] IS NULL OR external_user_id = ANY($2::text[]))
  `, [appId, externalIdFilter])

  await client.query(`DELETE FROM requirement_assistant.attachments WHERE user_id IN (SELECT id FROM cleanup_users)`)
  await client.query(`DELETE FROM requirement_assistant.tasks WHERE user_id IN (SELECT id FROM cleanup_users)`)
  await client.query(`DELETE FROM requirement_assistant.inbound_events
    WHERE platform = 'feishu' AND app_id = $1
      AND message_id IN (SELECT id FROM requirement_assistant.messages
        WHERE user_id IN (SELECT id FROM cleanup_users))`, [appId])
  await client.query(`DELETE FROM requirement_assistant.records
    WHERE ($2::text[] IS NULL AND app_id = $1)
       OR user_id IN (SELECT id FROM cleanup_users)`, [appId, externalIdFilter])
  await client.query(`DELETE FROM requirement_assistant.messages WHERE user_id IN (SELECT id FROM cleanup_users)`)
  await client.query(`DELETE FROM requirement_assistant.conversations WHERE user_id IN (SELECT id FROM cleanup_users)`)
  await client.query(`DELETE FROM requirement_assistant.user_chat_settings WHERE user_id IN (SELECT id FROM cleanup_users)`)
  await client.query(`UPDATE requirement_assistant.projects SET owner_user_id = NULL WHERE owner_user_id IN (SELECT id FROM cleanup_users)`)
  await client.query(`UPDATE requirement_assistant.user_packages SET user_id = NULL, status = 'pending_identity', bound_at = NULL WHERE user_id IN (SELECT id FROM cleanup_users)`)
  await client.query(`UPDATE requirement_assistant.legacy_imports SET mapped_user_id = NULL, imported_message_ids = '{}', status = 'pending', imported_at = NULL WHERE mapped_user_id IN (SELECT id FROM cleanup_users)`)
  await client.query(`DELETE FROM requirement_assistant.users WHERE id IN (SELECT id FROM cleanup_users)`)

  const after = await counts()
  await client.query('COMMIT')
  console.log(JSON.stringify({ mode: 'applied', appId, deleted: before, remaining: after }))
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  const code = /^[A-Z0-9_]{3,30}$/.test(error.code || '') ? error.code : 'CLEANUP_FAILED'
  const constraint = /^[A-Za-z0-9_]{1,80}$/.test(error.constraint || '') ? error.constraint : undefined
  const table = /^[A-Za-z0-9_]{1,80}$/.test(error.table || '') ? error.table : undefined
  console.error(JSON.stringify({ ok: false, code, table, constraint }))
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
