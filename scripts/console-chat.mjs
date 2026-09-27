// 本地终端模拟飞书对话：不建飞书应用也能全链路测试（模型问答/项目/记录/未回答检测）
// 用法：npm run chat   （退出：/exit 或 Ctrl+C；聊天记录与飞书一样写入 data/）

import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { loadEnvFile, loadRuntimeConfig } from '../src/config.js'
import { JsonlStore } from '../src/store.js'
import { ProjectRegistry } from '../src/projects.js'
import { MemoryStore } from '../src/memory.js'
import { createAssistant } from '../src/assistant.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvFile(join(ROOT, '.env'))
const cfg = loadRuntimeConfig()
const configFile = join(ROOT, 'config.json')
mkdirSync(cfg.dataDir, { recursive: true })

const store = new JsonlStore(cfg.dataDir)
await store.init()
const projects = new ProjectRegistry(join(cfg.dataDir, 'projects.json'))
await projects.load()
const memory = new MemoryStore(join(cfg.dataDir, 'memory'), cfg.maxHistoryTurns)
await memory.init()

const CHAT_ID = 'console-local'
const assistant = createAssistant({
  cfg, configFile, root: ROOT, store, projects, memory,
  sendReply: async (chatId, text) => {
    console.log('')
    console.log('🤖 ' + text)
    console.log('')
  },
  alertAdmins: async (text) => console.log('🔔 [告警] ' + text),
  log: (msg) => console.log('[需求助手] ' + msg),
})

let seq = 0
const send = (text) => assistant.processMessage({
  platform: 'console', chatId: CHAT_ID, userId: 'local', userName: '本地测试',
  text, msgId: 'c' + Date.now() + '-' + (seq += 1), chatType: 'private',
})

console.log('┌─ 需求助手 · 本地终端模拟（等同飞书私聊，聊天记录同样入库）')
console.log('│  直接输入问题回车；/help 查看命令；/exit 退出')
console.log('│  数据目录: ' + cfg.dataDir + ' | 模型: ' + cfg.llm.model + '（' + (cfg.llm.reasoningEffort || '默认推理') + '）')
console.log('└─────────────────────────────────────────────')

const rl = readline.createInterface({ input, output })
// 交互模式 Ctrl+C：保存后退出
process.on('SIGINT', async () => {
  console.log('')
  rl.close()
  await assistant.dispose()
await memory.dispose()
  await projects.dispose()
  await store.saveState()
  process.exit(0)
})
// for-await 顺序消费输入行：交互输入与管道输入（EOF）都适用，LLM 等待期间缓冲不丢行
process.stdout.write('你 > ')
for await (const line of rl) {
  const text = line.trim()
  if (!text) {
    process.stdout.write('你 > ')
    continue
  }
  if (/^\/(exit|quit)$/i.test(text)) break
  try {
    await send(text)
  } catch (err) {
    console.log('处理失败: ' + (err?.message ?? err))
  }
  process.stdout.write('你 > ')
}
rl.close()
await assistant.dispose()
await memory.dispose()
await projects.dispose()
await store.saveState()
console.log('已退出。会话记忆与聊天记录已保存到 data/。')
