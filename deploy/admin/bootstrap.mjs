import { randomBytes } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashPassword } from '../../src/admin-auth.js'

export async function bootstrap(dir, env = process.env) {
  const configPath = join(dir, 'app.env')
  try { await access(configPath); return false } catch (e) { if (e.code !== 'ENOENT') throw e }
  const database = env.DEPLOY_DB_URL || ''
  const appId = env.DEPLOY_APP_ID || ''
  const username = env.DEPLOY_ADMIN_USERNAME || 'admin'
  const parsed = new URL(database)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('invalid database')
  if (!/^cli_[a-zA-Z0-9]+$/.test(appId)) throw new Error('invalid app id')
  if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(username)) throw new Error('invalid username')
  if (/[\r\n\0]/.test(database)) throw new Error('invalid database')
  const password = randomBytes(24).toString('base64url')
  const values = { DATABASE_URL: database, ADMIN_APP_ID: appId, ADMIN_USERNAME: username,
    ADMIN_PASSWORD_HASH: hashPassword(password), ADMIN_SESSION_SECRET: randomBytes(48).toString('base64url'),
    ADMIN_SESSION_HOURS: '12' }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Write credentials first; never leave a successfully created config with a lost password.
  await writeFile(join(dir, 'initial-password.txt'), `账号：${username}\n密码：${password}\n请妥善保存，取走后删除此明文文件。\n`, { flag: 'wx', mode: 0o600 })
  await writeFile(configPath, Object.entries(values).map(([k, v]) => k + '=' + v).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  return true
}

if (process.argv[1]?.endsWith('/bootstrap.mjs')) {
  bootstrap('/setup').then(created => console.log(created ? '独立配置与初始密码已生成。' : '已有配置，保留原密码和会话密钥。'))
    .catch(() => { console.error('首次配置失败：检查输入格式、目录写入权限或是否存在上次未完成的密码文件。'); process.exitCode = 1 })
}
