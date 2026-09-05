#!/usr/bin/env node
// 历史对话导入会话记忆：把 context/raw/ 的历史记录最后 N 轮，导入指定「飞书聊天 + 项目」的会话记忆，
// 实现「接着聊」：新对话从历史上下文继续，模型可直接引用之前的讨论。
// 用法：node scripts/import-history.mjs --chat <oc_xxx> --project <项目id或名称> [--turns 30] [--assistant 名字1,名字2]
//   chatId 见服务日志「收到消息 oc_xxx …」；项目用 /project list 的 id 或名称。
//   --assistant 可选：把历史上某些人名也当作助手方（默认仅识别 助手/AI/机器人/bot 等）。

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAll, ASSISTANT_LIKE } from './build-context.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const chatId = arg('chat')
const projectQuery = arg('project')
const turns = Number(arg('turns', '30')) || 30
const extraAssistants = arg('assistant', '').split(',').map(s => s.trim()).filter(Boolean)

if (!chatId || !projectQuery) {
  console.log('用法：node scripts/import-history.mjs --chat <oc_xxx> --project <项目id或名称> [--turns 30] [--assistant 名字1,名字2]')
  console.log('chatId 见服务日志「收到消息 oc_xxx …」；项目用 /project list 的 id 或名称。')
  process.exit(1)
}

// 解析项目 id（支持传名称）
let projectId = projectQuery
let projectName = projectQuery
try {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'projects.json'), 'utf8'))
  const list = Object.values(raw.projects ?? {})
  const byId = list.find(p => p.id === projectQuery)
  const byName = list.find(p => p.name === projectQuery)
  if (byId) {
    projectId = byId.id
    projectName = byId.name
  } else if (byName) {
    projectId = byName.id
    projectName = byName.name
  } else {
    console.log('未找到项目「' + projectQuery + '」。先在飞书里 /project new ' + projectQuery + ' 创建，再运行本脚本。')
    process.exit(1)
  }
} catch {
  console.log('读 data/projects.json 失败，项目 id 按原样使用。')
}

const { msgs } = loadAll()
if (msgs.length === 0) {
  console.log('context/raw/ 里没有可解析的历史记录（支持 txt/md/csv/jsonl，格式见 context/README.md）。')
  process.exit(1)
}

// 角色映射：助手类名字 → assistant；其余 → user
const assistantSet = new Set(extraAssistants.map(s => s.toLowerCase()))
const roleOf = (speaker) => {
  const s = String(speaker ?? '')
  return (ASSISTANT_LIKE.test(s) || assistantSet.has(s.toLowerCase())) ? 'assistant' : 'user'
}

// 取最后 N「轮」（以 user 消息为轮起点，向后包含其后的 assistant 回复）
const history = []
let userCount = 0
for (let i = msgs.length - 1; i >= 0 && userCount < turns; i--) {
  const role = roleOf(msgs[i].speaker)
  history.unshift({ role, content: msgs[i].text })
  if (role === 'user') userCount += 1
}
// 轮对齐：去掉头部残留的 assistant 段（不完整的开头轮）
while (history.length && history[0].role === 'assistant') history.shift()

// 写入 data/memory/<key>.json（key 规则与 src/memory.js safeKey 一致）
const key = createHash('sha1').update(chatId + '::' + projectId).digest('hex').slice(0, 20)
mkdirSync(join(ROOT, 'data', 'memory'), { recursive: true })
const file = join(ROOT, 'data', 'memory', key + '.json')
writeFileSync(file, JSON.stringify(history, null, 2), 'utf8')

console.log('已导入 ' + history.length + ' 条消息（' + userCount + ' 轮）')
console.log('目标：chat=' + chatId + ' → 项目「' + projectName + '」（' + projectId + '）')
console.log('写入：' + file)
console.log('下一步：重启服务 → 飞书该聊天 /project use ' + projectName + ' → 直接接着聊。')
