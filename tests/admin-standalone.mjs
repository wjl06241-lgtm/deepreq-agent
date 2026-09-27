import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createAdminServer } from '../src/admin-server.js'
import { createStandaloneAdmin, standaloneConfig } from '../src/admin-standalone.js'
import { hashPassword } from '../src/admin-auth.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const env = { DATABASE_URL: 'postgresql://test.invalid/test', ADMIN_APP_ID: 'cli_test',
  ADMIN_PASSWORD_HASH: hashPassword('test-password'), ADMIN_SESSION_SECRET: 's'.repeat(48) }
const cfg = standaloneConfig(env)
assert.equal(cfg.adminPort, 3900)
assert.equal(cfg.feishu.appSecret, '')
assert.throws(() => standaloneConfig({ ...env, ADMIN_SESSION_SECRET: '' }))
assert.throws(() => standaloneConfig({ ...env, ADMIN_APP_ID: '' }))
assert.throws(() => standaloneConfig({ ...env, ADMIN_ONLY_PORT: '-1' }))

const queries = []
let databaseDown = false
let savedNote = ''
const pool = { async query(sql, args) {
  queries.push({ sql, args })
  if (databaseDown) throw new Error('postgresql://secret:password@private-host')
  if (sql.includes('to_regclass')) return { rows: [{ t: 'requirement_assistant.enterprises' }] }
  if (sql.includes('SELECT e.*')) return { rows: [{ id: 'e-test', name: 'Test Hospital' }] }
  if (sql.includes('AS "memberOpenIds"')) return { rows: [{ id: 'p-test', name: 'Test Project', createdAt: new Date() }] }
  if (sql.includes('FROM requirement_assistant.records')) return { rows: [] }
  if (sql.includes('FROM requirement_assistant.tasks t')) return { rows: [{ id: 't-test', status: 'completed', project: 'p-test' }] }
  if (sql.includes('SELECT u.id, u.app_id AS "appId"')) return { rows: [
    { id: 'u-current', appId: 'cli_test', openId: 'ou_current', enterpriseName: 'Test Hospital', adminNote: '' },
    { id: 'u-other', appId: 'cli_other', openId: 'ou_other', enterpriseName: 'Other Hospital', adminNote: savedNote },
  ] }
  if (sql.includes('SELECT count(*)::int AS count FROM requirement_assistant.users')) return { rows: [{ count: 2 }] }
  if (sql.includes('SELECT u.id,u.app_id AS "appId",u.external_user_id AS "openId"')) return {
    rows: args[0] === 'cli_other' && args[1] === 'ou_other'
      ? [{ id: 'u-other', appId: 'cli_other', openId: 'ou_other', name: 'Other User', adminNote: savedNote }] : [],
  }
  if (sql.includes('INSERT INTO requirement_assistant.enterprise_audit')) {
    if (args[0] !== 'cli_other' || args[1] !== 'ou_other') return { rows: [] }
    savedNote = args[2]
    return { rows: [{ updatedAt: new Date() }] }
  }
  if (sql.includes('AS "messageCount"') && sql.includes('ORDER BY COALESCE')) return { rows: [{ id: 'c-test', messageCount: 2 }] }
  return { rows: [] }
} }
const server = await createStandaloneAdmin({ cfg, pool })
await new Promise(ok => server.listen(0, '127.0.0.1', ok))
const base = 'http://127.0.0.1:' + server.address().port
try {
  const home = await fetch(base)
  assert.equal(home.status, 200)
  assert.doesNotMatch(await home.text(), /data-page="conversations"/)
  assert.equal((await fetch(base + '/api/status')).status, 401)
  assert.equal((await fetch(base + '/api/enterprise/catalog')).status, 401)
  const denied = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong' }) })
  assert.equal(denied.status, 401)
  const login = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'test-password' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const csrf = (await login.json()).csrf
  const headers = { cookie, 'x-csrf-token': csrf }
  const status = await (await fetch(base + '/api/status', { headers })).json()
  assert.equal(status.system.mode, 'standalone-admin')
  assert.equal(status.system.feishuConfigured, false)
  assert.equal(status.database.pending, null)
  assert.equal(status.tasks[0].id, 't-test')
  const people = await (await fetch(base + '/api/admin/users', { headers })).json()
  assert.equal(people.total, 2)
  assert.deepEqual(people.users.map(u => u.appId), ['cli_test', 'cli_other'])
  assert.ok(queries.some(q => q.sql.includes('SELECT u.id, u.app_id AS "appId"') && q.args[0] === null))
  const otherUser = await (await fetch(base + '/api/admin/users/ou_other?appId=cli_other', { headers })).json()
  assert.equal(otherUser.user.appId, 'cli_other')
  assert.equal((await fetch(base + '/api/admin/users/ou_other?appId=bad', { headers })).status, 400)
  assert.ok(queries.every(q => /^SELECT\b/.test(q.sql.trim())), 'startup and read endpoints never mutate database')
  const noteUrl = base + '/api/admin/users/ou_other/note?appId=cli_other'
  assert.equal((await fetch(noteUrl, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ note: '待跟进' }) })).status, 403)
  assert.equal((await fetch(noteUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ note: 'x'.repeat(2001) }) })).status, 400)
  const saved = await (await fetch(noteUrl, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ note: '  待跟进  ' }) })).json()
  assert.equal(saved.note, '待跟进')
  assert.equal(saved.updatedBy, 'admin')
  assert.equal((await (await fetch(base + '/api/admin/users/ou_other?appId=cli_other', { headers })).json()).user.adminNote, '待跟进')
  assert.equal((await (await fetch(base + '/api/admin/users', { headers })).json()).users[1].adminNote, '待跟进')
  assert.equal(queries.filter(q => q.sql.includes('INSERT INTO requirement_assistant.enterprise_audit')).length, 1)
  const conversations = await (await fetch(base + '/api/admin/conversations', { headers })).json()
  assert.equal(conversations.conversations[0].id, 'c-test')
  assert.ok(queries.some(q => q.sql.includes('FROM requirement_assistant.conversations c JOIN requirement_assistant.users u') && q.args?.[0] === 'cli_test'))
  for (const item of queries.filter(q => q.sql.includes('FROM requirement_assistant.records') || q.sql.includes('FROM requirement_assistant.tasks t'))) assert.ok(item.args.includes('cli_test'))
  assert.equal((await fetch(base + '/api/enterprise/project', { method: 'POST', headers: { cookie }, body: '{}' })).status, 403)
  for (const [path, method] of [
    ['/api/admin/users/ou_test/refresh', 'POST'], ['/api/admin/attachments/test/download', 'GET'],
    ['/api/resolve', 'POST'], ['/api/enterprise/materials/p-test', 'POST'],
    ['/api/enterprise/global-materials', 'POST'],
    ['/api/enterprise/materials/p-test/11111111-1111-1111-1111-111111111111/download', 'GET'],
  ]) assert.equal((await fetch(base + path, { method, headers })).status, 409, path)
  const logs = await (await fetch(base + '/api/admin/logs', { headers })).json()
  assert.match(logs.lines[0].text, /尚未上报/)
  databaseDown = true
  const failure = await fetch(base + '/api/status', { headers })
  assert.equal(failure.status, 500)
  assert.doesNotMatch(await failure.text(), /secret|password|private-host/)
} finally { await new Promise(ok => server.close(ok)) }

// Shared HTTP module retains the integrated runtime behavior after extraction.
let refreshCalls = 0
const integrated = createAdminServer({ cfg, root, configFile: '', appVersion: 'test', startedAt: Date.now(),
  store: { readRange: async () => [], status: () => ({ enabled: false }), flush: async () => {} },
  projects: { list: () => [] }, enterpriseMode: false, feishuReady: true,
  assistant: { projectNames: () => ({}), openQuestions: async () => [], runtime: { tasks: { list: () => [] } } },
  users: { list: () => [], profile: async () => { refreshCalls++; return { name: 'test' } } },
})
await new Promise(ok => integrated.listen(0, '127.0.0.1', ok))
try {
  const url = 'http://127.0.0.1:' + integrated.address().port
  assert.match(await (await fetch(url)).text(), /data-page="conversations"/)
  const login = await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'test-password' }) })
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'x-csrf-token': (await login.json()).csrf }
  const status = await (await fetch(url + '/api/status', { headers })).json()
  assert.equal(status.system.mode, 'integrated')
  assert.equal(status.system.feishuConfigured, true)
  assert.equal((await fetch(url + '/api/admin/users/ou_test/refresh', { method: 'POST', headers })).status, 200)
  assert.equal(refreshCalls, 1)
} finally { await new Promise(ok => integrated.close(ok)) }
const source = await readFile(new URL('../src/admin-standalone.js', import.meta.url), 'utf8')
assert.doesNotMatch(source, /from ['"]\.\/(assistant|runtime|feishu|codex)\.js/)
assert.doesNotMatch(source, /store\.init\(|createAssistant\(|startFeishu\(/)
console.log('ADMIN-STANDALONE-OK: independent startup, database reads, auth/CSRF, app scope, local capabilities blocked, sanitized errors, integrated HTTP regression')
