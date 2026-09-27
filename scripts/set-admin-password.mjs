import { randomBytes } from 'node:crypto'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hashPassword } from '../src/admin-auth.js'

const root = join(import.meta.dirname, '..')
const envFile = join(root, '.env')
const username = process.argv[2] || 'admin'
const password = process.argv[3] || `RA-${randomBytes(12).toString('base64url')}!`
const secret = randomBytes(48).toString('base64url')
let env = await readFile(envFile, 'utf8')
const values = {
  ADMIN_USERNAME: username,
  ADMIN_PASSWORD_HASH: hashPassword(password),
  ADMIN_SESSION_SECRET: secret,
  ADMIN_SESSION_HOURS: '12',
}
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, 'gm')
  env = re.test(env) ? env.replace(re, `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`
}
await writeFile(`${envFile}.tmp`, env, 'utf8')
await rename(`${envFile}.tmp`, envFile)
const dataDirLine = env.split(/\r?\n/).find(line => line.startsWith('DATA_DIR='))
const dataDir = dataDirLine?.slice('DATA_DIR='.length) || join(root, 'data')
await mkdir(dataDir, { recursive: true })
await writeFile(join(dataDir, 'admin-initial-password.txt'), `管理后台初始账号：${username}\n管理后台初始密码：${password}\n首次登录后请运行 npm run admin:password -- admin 新密码 进行修改。\n`, { encoding: 'utf8', mode: 0o600 })
console.log(JSON.stringify({ configured: true, username, credentialFile: join(dataDir, 'admin-initial-password.txt') }))
