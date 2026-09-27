import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadEnvFile, loadRuntimeConfig } from '../src/config.js'
import { feishuAppsFile } from '../src/app-instances.js'

const root = join(import.meta.dirname, '..')
loadEnvFile(join(root, '.env'))
const cfg = loadRuntimeConfig()
if (!cfg.feishu.appId || !cfg.feishu.appSecret) throw new Error('请先在 .env 配置当前 FEISHU_APP_ID 和 FEISHU_APP_SECRET')
const file = feishuAppsFile(root)
try {
  await access(file)
  console.log('多 App 配置已存在，无需重复初始化。')
  process.exit(0)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const config = {
  adminBasePort: cfg.adminPort,
  apps: [{
    name: '现有应用',
    appIdEnv: 'FEISHU_APP_ID',
    appSecretEnv: 'FEISHU_APP_SECRET',
    dataDir: cfg.dataDir,
    adminPort: cfg.adminPort,
    enabled: true,
  }],
}
await writeFile(file, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
console.log('已创建多 App 配置：' + file)
console.log('当前应用已纳入管理；新增应用时再添加一项并使用独立数据目录和端口。')
