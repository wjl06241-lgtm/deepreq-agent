// 字节级替换 .env 中的飞书凭据（保持文件其余字节不变，避免编码损坏）
// 用法：node scripts/swap-feishu-app.mjs <新AppId> <新AppSecret>
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [, , newAppId, newAppSecret] = process.argv
if (!newAppId || !newAppSecret) {
  console.log('用法：node scripts/swap-feishu-app.mjs <新AppId> <新AppSecret>')
  process.exit(1)
}
const file = fileURLToPath(new URL('../.env', import.meta.url))
const multiAppFile = fileURLToPath(new URL('../.feishu-apps.json', import.meta.url))
if (existsSync(multiAppFile)) {
  throw new Error('已启用多 App 配置，不能再用凭据替换脚本；请在 .env 和 .feishu-apps.json 中新增应用。')
}
const buf = readFileSync(file)
const raw = buf.toString('latin1') // 字节保真
const oldId = (/FEISHU_APP_ID=([^\r\n]+)/.exec(raw) ?? [])[1] ?? '(未找到)'
let out = raw.replace(/FEISHU_APP_ID=[^\r\n]*/, 'FEISHU_APP_ID=' + newAppId)
out = out.replace(/FEISHU_APP_SECRET=[^\r\n]*/, 'FEISHU_APP_SECRET=' + newAppSecret)
if (!/OLD_FEISHU_APP_ID=/.test(out)) {
  out += '\r\n# OLD app backup: ' + oldId + '\r\nOLD_FEISHU_APP_ID=' + oldId + '\r\n'
}
writeFileSync(file, Buffer.from(out, 'latin1'))
console.log('done: ' + oldId + ' -> ' + newAppId)
