import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { instanceEnvironment, loadFeishuAppInstances } from '../src/app-instances.js'

let failed = 0
const check = (name, condition) => {
  console.log((condition ? 'PASS' : 'FAIL') + ' ' + name)
  if (!condition) failed += 1
}

const root = await mkdtemp(join(tmpdir(), 'req-assistant-apps-'))
const legacy = loadFeishuAppInstances(root, {
  FEISHU_APP_ID: 'cli_legacy', FEISHU_APP_SECRET: 'legacy-secret',
  DATA_DIR: './legacy-data', ADMIN_PORT: '3900',
})
check('legacy config stays compatible', legacy.mode === 'legacy' && legacy.instances[0].adminPort === 3900)

const configFile = join(root, '.feishu-apps.json')
await writeFile(configFile, JSON.stringify({ apps: [
  { name: '应用一', appIdEnv: 'APP_ONE_ID', appSecretEnv: 'APP_ONE_SECRET', dataDir: './one', adminPort: 4001 },
  { name: '应用二', appId: 'cli_two', appSecret: 'secret-two', dataDir: './two', adminPort: 4002 },
] }))
const multi = loadFeishuAppInstances(root, { APP_ONE_ID: 'cli_one', APP_ONE_SECRET: 'secret-one' })
check('loads multiple apps', multi.mode === 'multi' && multi.instances.length === 2)
check('resolves isolated data dirs', multi.instances[0].dataDir !== multi.instances[1].dataDir)
const childEnv = instanceEnvironment(multi.instances[0], { SHARED: 'yes' })
check('builds isolated child env', childEnv.FEISHU_APP_ID === 'cli_one' && childEnv.DATA_DIR.endsWith('one') && childEnv.SHARED === 'yes')

await writeFile(configFile, JSON.stringify({ apps: [
  { name: '一', appId: 'cli_one', appSecret: 'x', dataDir: './one', adminPort: 4001 },
  { name: '二', appId: 'cli_two', appSecret: 'y', dataDir: './two', adminPort: 4001 },
] }))
let duplicateRejected = false
try { loadFeishuAppInstances(root, {}) } catch (error) { duplicateRejected = /管理端口.*重复/.test(error.message) }
check('rejects duplicate admin ports', duplicateRejected)

await rm(root, { recursive: true, force: true })
console.log(failed === 0 ? 'MULTI-APP-OK' : 'MULTI-APP-FAILED: ' + failed)
process.exit(failed === 0 ? 0 : 1)
