import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { hashPassword } from '../src/admin-auth.js'

const root = resolve(import.meta.dirname, '..')
const envFile = resolve(root, process.env.ADMIN_ENV_FILE || '.env.admin')
const username = process.argv[2] || 'admin'
const password = process.argv[3] || randomBytes(24).toString('base64url')
let env = await readFile(envFile, 'utf8').catch(async e => {
  if (e.code !== 'ENOENT') throw e
  return readFile(join(root, '.env.admin.example'), 'utf8')
})
for (const [key, value] of Object.entries({ ADMIN_USERNAME: username,
  ADMIN_PASSWORD_HASH: hashPassword(password), ADMIN_SESSION_SECRET: randomBytes(48).toString('base64url') })) {
  if (/[\r\n]/.test(value)) throw new Error('参数不能包含换行')
  const re = new RegExp('^' + key + '=.*$', 'gm')
  env = re.test(env) ? env.replace(re, () => key + '=' + value) : env + '\n' + key + '=' + value + '\n'
}
await writeFile(envFile, env, { mode: 0o600 })
const dir = join(root, 'data', 'admin-only')
await mkdir(dir, { recursive: true })
const credentialFile = join(dir, 'initial-password.txt')
await writeFile(credentialFile, `账号：${username}\n密码：${password}\n请妥善保存，取走后删除此文件。\n`, { mode: 0o600 })
console.log('独立后台凭据已配置；未修改本地 .env。初始密码文件：' + credentialFile)
