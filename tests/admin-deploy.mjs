import assert from 'node:assert/strict'
import { mkdtemp, readFile, copyFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bootstrap } from '../deploy/admin/bootstrap.mjs'
import { verifyPassword } from '../src/admin-auth.js'

const dir = await mkdtemp(join(tmpdir(), 'admin-deploy-test-'))
try {
  const state = join(dir, 'deploy/admin/state')
  const input = { DEPLOY_DB_URL: 'postgresql://demo:pa$word@database.example/demo', DEPLOY_APP_ID: 'cli_test123' }
  assert.equal(await bootstrap(state, input), true)
  const config = await readFile(join(state, 'app.env'), 'utf8')
  const credentials = await readFile(join(state, 'initial-password.txt'), 'utf8')
  const values = Object.fromEntries(config.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  const password = credentials.match(/密码：([^\n]+)/)[1]
  assert.equal(verifyPassword(password, values.ADMIN_PASSWORD_HASH), true)
  assert.equal(config.includes(password), false)
  assert.equal(await bootstrap(state, {}), false)
  assert.equal(await readFile(join(state, 'app.env'), 'utf8'), config)
  await assert.rejects(bootstrap(join(dir, 'invalid'), { ...input, DEPLOY_APP_ID: 'invalid' }))
  await copyFile(resolve('compose.admin.yaml'), join(dir, 'compose.admin.yaml'))
  await writeFile(join(dir, 'empty.env'), '')
  const result = spawnSync('docker', ['compose', '--env-file', join(dir, 'empty.env'), '-f', join(dir, 'compose.admin.yaml'), 'config', '--format', 'json'], { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') console.log('SKIP Compose validation: Docker CLI unavailable')
  else {
    assert.equal(result.status, 0, 'Compose config validation failed')
    const service = JSON.parse(result.stdout).services.admin
    // Compose config escapes dollar signs for a re-loadable rendered config.
    assert.equal(service.environment.DATABASE_URL, input.DEPLOY_DB_URL.replaceAll('$', () => '$$'))
    assert.equal(service.environment.ADMIN_PASSWORD_HASH, values.ADMIN_PASSWORD_HASH.replaceAll('$', () => '$$'))
    assert.equal(service.ports[0].host_ip, '127.0.0.1')
    assert.equal(service.read_only, true)
  }
  console.log('admin deploy tests passed (bootstrap, repeat safety, raw credentials, Compose)')
} finally { await rm(dir, { recursive: true, force: true }) }
