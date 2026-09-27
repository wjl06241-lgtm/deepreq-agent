import { CodexClient, CodexBackend } from '../src/codex.js'
import { AtomicState } from '../src/state.js'
import { loadEnvFile, loadRuntimeConfig } from '../src/config.js'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

loadEnvFile(join(import.meta.dirname, '..', '.env'))
const cfg = loadRuntimeConfig().codex
const client = new CodexClient(cfg)
try {
  await client.start()
  const account = await client.request('account/read', {})
  console.log(JSON.stringify({ connected: true, authenticated: Boolean(account.account), authType: account.account?.type, requiresOpenaiAuth: account.requiresOpenaiAuth }))
  if (process.argv.includes('--live')) {
    const dir = await mkdtemp(join(tmpdir(), 'req-codex-check-'))
    await mkdir(dir, { recursive: true })
    const sessions = await new AtomicState(join(dir, 'sessions.json'), {}).init()
    const backend = new CodexBackend({ ...cfg, timeoutMs: 120000 }, sessions, client)
    const result = await backend.run({ key: 'diagnostic', cwd: dir, systemPrompt: '只做连接测试，不读取任何本地文件。',
      text: '调用 connection_check 工具，然后只回复工具返回的测试码。',
      tools: { specs: [{ type: 'function', name: 'connection_check', description: '返回测试码', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
        call: async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'REQ-CODEX-OK' }] }) },
    })
    if (!result.text.includes('REQ-CODEX-OK')) throw new Error('Codex 工具调用自检失败：' + result.text)
    console.log(result.text)
  }
} finally { client.close() }
