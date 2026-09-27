import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/config.js'
import { createApiClient } from '../src/feishu.js'

loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
const openId = process.argv[2] || ''
if (!/^ou_[a-zA-Z0-9]+$/.test(openId)) throw new Error('飞书用户 ID 无效')
const client = createApiClient(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET)
try {
  const response = await client.contact.v3.user.get({
    path: { user_id: openId },
    params: { user_id_type: 'open_id' },
  })
  const scopes = await client.application.v6.scope.list({}).catch(() => null)
  const contactScopes = (scopes?.data?.scopes || [])
    .filter(item => /contact:user|contact:contact|contact:department/.test(item.scope_name))
    .map(item => ({ name: item.scope_name, granted: item.grant_status === 1, type: item.scope_type || '' }))
  console.log(JSON.stringify({
    ok: response?.code === 0,
    code: response?.code,
    message: response?.msg || '',
    hasUser: Boolean(response?.data?.user),
    hasName: Boolean(response?.data?.user?.name),
    name: response?.data?.user?.name || '',
    returnedFields: Object.keys(response?.data?.user || {}).sort(),
    contactScopes,
  }))
} catch (error) {
  const data = error?.response?.data
  console.log(JSON.stringify({
    ok: false,
    code: data?.code || error?.code || 'REQUEST_FAILED',
    message: data?.msg || data?.message || error?.message || '请求失败',
  }))
  process.exitCode = 1
}
