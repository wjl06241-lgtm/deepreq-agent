#!/usr/bin/env node
// 历史对话 → 项目上下文加工脚本（零依赖）
// 用法：node scripts/build-context.mjs [--summarize]
// 输入：context/raw/**/*.{txt,md,csv,jsonl}
// 输出：AGENTS.md / AGENTS.local.md / context/项目上下文.md / context/chunks/*.md / context/stats.json
// --summarize：用 DEEPSEEK_API_KEY（可选 DEEPSEEK_BASE_URL，默认 https://api.deepseek.com）逐块摘要。

import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW_DIR = join(ROOT, 'context', 'raw')
const OUT_DIR = join(ROOT, 'context')
const CHUNK_DIR = join(OUT_DIR, 'chunks')
const CHUNK_SIZE = 200
const AGENT_MAX_BYTES = 60 * 1024 // 压缩上下文上限（提示词友好）

const summarize = process.argv.includes('--summarize')

function walk(dir, exts) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { out.push(...walk(p, exts)); continue }
    if (exts.some(e => name.toLowerCase().endsWith(e))) out.push(p)
  }
  return out.sort()
}

// ── 解析器 ──────────────────────────────────────────────────────────

function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; continue }
      if (c === '"') { inQ = false; continue }
      cur += c
    } else if (c === '"') { inQ = true }
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

function norm(text) {
  return String(text ?? '').replace(/\ufeff/g, '').trim()
}

function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const header = splitCsvLine(lines[0]).map(h => norm(h).toLowerCase())
  const colTime = header.findIndex(h => /time|date|时间|日期/.test(h))
  const colSpeaker = header.findIndex(h => /speaker|user|name|发言人|用户|昵称|姓名/.test(h))
  const colText = header.findIndex(h => /^(text|content|message|msg)$|内容|消息|文本/.test(h))
  if (colText < 0) return []
  const msgs = []
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line)
    const text = norm(cells[colText])
    if (!text) continue
    msgs.push({
      speaker: colSpeaker >= 0 ? norm(cells[colSpeaker]) || '未知' : '未知',
      text,
      ts: colTime >= 0 ? Date.parse(norm(cells[colTime])) : null,
    })
  }
  return msgs
}

function parseJsonl(raw) {
  const msgs = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      const text = norm(j.text ?? j.content ?? j.message ?? '')
      if (!text) continue
      const tsRaw = j.ts ?? j.time ?? j.timestamp ?? null
      msgs.push({
        speaker: norm(j.speaker ?? j.role ?? j.user ?? j.name ?? '未知'),
        text,
        ts: typeof tsRaw === 'number' ? tsRaw : Date.parse(String(tsRaw ?? '')) || null,
      })
    } catch { /* 跳过坏行 */ }
  }
  return msgs
}

function parseText(raw) {
  // 第一遍：收集【名字】/ [名字] 形态的发言人集合
  const nameSet = new Set()
  for (const line of raw.split(/\r?\n/)) {
    const m = /^[【\[]([^】\]]{1,30})[】\]]\s*/.exec(line)
    if (m) nameSet.add(m[1].trim())
  }
  const msgs = []
  let current = null
  const flush = () => {
    if (current && current.text) msgs.push(current)
    current = null
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = norm(rawLine)
    if (!line) { flush(); continue }
    let speaker = null
    let text = line
    const bracket = /^[【\[]([^】\]]{1,30})[】\]]\s*/.exec(line)
    if (bracket) { speaker = bracket[1].trim(); text = line.slice(bracket[0].length) }
    else {
      const colon = /^([^:：]{1,24})[:：]\s?/.exec(line)
      if (colon && (nameSet.has(colon[1].trim()) || /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,16}$/.test(colon[1].trim()))) {
        speaker = colon[1].trim()
        text = line.slice(colon[0].length)
      }
    }
    if (speaker) {
      flush()
      if (text) current = { speaker, text, ts: null }
    } else if (current) {
      current.text += '\n' + line // 同一人连续多行合并
    }
  }
  flush()
  return msgs
}

// ── 读取与归一化 ─────────────────────────────────────────────────────

export function loadAll() {
  const files = walk(RAW_DIR, ['.txt', '.md', '.csv', '.jsonl'])
  const msgs = []
  for (const f of files) {
    const raw = readFileSync(f, 'utf8')
    const ext = f.toLowerCase().split('.').pop()
    if (ext === 'jsonl') msgs.push(...parseJsonl(raw))
    else if (ext === 'csv') msgs.push(...parseCsv(raw))
    else msgs.push(...parseText(raw))
  }
  return { files, msgs }
}

// ── 统计与 FAQ ──────────────────────────────────────────────────────

function isQuestion(text) {
  return /[?？]$|^请|^如何|^怎么|^为什么|^能不能|^可以|^是否/.test(text.slice(0, 60)) || /[?？]/.test(text.slice(0, 200))
}

export const ASSISTANT_LIKE = /助手|assistant|机器人|AI|bot|客服/i

function extractFaq(msgs, maxPairs = 30) {
  const faq = []
  for (let i = 0; i < msgs.length - 1 && faq.length < maxPairs; i++) {
    const q = msgs[i]
    const a = msgs[i + 1]
    // 只取「非助手发言的问句 → 回答」方向；助手的追问不算 FAQ 的 Q
    if (ASSISTANT_LIKE.test(q.speaker)) continue
    if (isQuestion(q.text) && !isQuestion(a.text) && a.text.length >= 10) {
      faq.push({ q: q.text.slice(0, 300), a: a.text.slice(0, 500) })
    }
  }
  return faq
}

function summarizeChunk(chunk) {
  if (chunk.length === 0) return '（空块）'
  const first = chunk[0]
  const last = chunk[chunk.length - 1]
  const texts = chunk.map(m => m.text).join(' ')
  const terms = (texts.match(/[\u4e00-\u9fa5]{2,6}/g) ?? [])
  const freq = {}
  for (const t of terms) freq[t] = (freq[t] ?? 0) + 1
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]).join('、')
  return '块内 ' + chunk.length + ' 条消息；起始：' + (first.speaker + '：' + first.text.slice(0, 60))
    + '；结尾：' + (last.speaker + '：' + last.text.slice(0, 60))
    + '；高频词：' + (top || '（无）')
}

async function llmSummarize(chunk, index) {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) return null
  const base = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const text = chunk.map(m => m.speaker + '：' + m.text).join('\n').slice(0, 12000)
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        { role: 'system', content: '你是需求分析助手。把下面这段聊天记录压缩成要点：涉及的主题、用户提出的需求点、达成的结论、待办事项。用中文，分条列出，每条不超过 60 字。' },
        { role: 'user', content: text },
      ],
    }),
  })
  if (!res.ok) throw new Error('摘要请求失败 HTTP ' + res.status)
  const data = await res.json()
  return '### 第 ' + index + ' 块要点（模型摘要）\n' + (data.choices?.[0]?.message?.content ?? '(无输出)')
}

// ── 输出 ─────────────────────────────────────────────────────────────

export function fmtTime(ts) {
  if (!ts) return '未知'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '未知'
  return d.toLocaleString('zh-CN', { hour12: false })
}

function buildDigest(msgs, faq, chunkNotes, files) {
  const validTs = msgs.map(m => m.ts).filter(Boolean).sort((a, b) => a - b)
  const speakers = {}
  for (const m of msgs) speakers[m.speaker] = (speakers[m.speaker] ?? 0) + 1
  const topSpeakers = Object.entries(speakers).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(e => e[0] + '（' + e[1] + ' 条）').join('、')
  const recent = msgs.slice(-40)
  const lines = [
    '# 需求助手 · 项目上下文（自动生成，可随时用 scripts/build-context.mjs 重新生成）',
    '',
    '> 本文件由历史聊天记录压缩而成。请勿手工编辑；原始记录在 context/raw/。',
    '',
    '## 总体情况',
    '- 消息总数：' + msgs.length + ' 条',
    '- 时间范围：' + (validTs.length ? fmtTime(validTs[0]) + ' ~ ' + fmtTime(validTs[validTs.length - 1]) : '未知'),
    '- 主要参与者：' + (topSpeakers || '（无）'),
    '- 原始文件：' + (files.length ? files.map(f => f.replace(ROOT + '\\', '')).join('、') : '（context/raw/ 为空）'),
    '',
  ]
  if (faq.length) {
    lines.push('## 常见问题与结论（FAQ 摘录）', '')
    for (const [i, f] of faq.entries()) {
      lines.push('### Q' + (i + 1) + ' ' + f.q.replace(/\s+/g, ' ').slice(0, 120))
      lines.push(f.a.replace(/\s+/g, ' ').slice(0, 260), '')
    }
  }
  lines.push('## 分块索引（全文见 context/chunks/）', '')
  for (const [i, note] of chunkNotes.entries()) lines.push('- 第 ' + (i + 1) + ' 块：' + note)
  lines.push('', '## 最近对话摘录（末 40 条，按时间顺序）', '')
  for (const m of recent) {
    lines.push('【' + m.speaker + '】' + (m.ts ? '（' + fmtTime(m.ts) + '）' : '') + '：' + m.text.replace(/\s+/g, ' ').slice(0, 300))
  }
  const joined = lines.join('\n')
  if (Buffer.byteLength(joined, 'utf8') > AGENT_MAX_BYTES) {
    // 超限：砍掉最近摘录的一半再截断
    return joined.slice(0, AGENT_MAX_BYTES - 200) + '\n\n> （上下文超过预算，已截断；完整内容见 context/chunks/）'
  }
  return joined
}

// ── 主流程（仅直接运行时执行；被 import 时跳过）─────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (!isMain) {
  // 被 import-history.mjs 等引用：只导出解析能力
} else {

const { files, msgs } = loadAll()
console.log('原始文件：' + (files.length ? files.join('、') : '（无，请把记录放入 context/raw/）'))
console.log('解析消息：' + msgs.length + ' 条')
if (msgs.length === 0) {
  console.log('没有可加工的内容，退出。')
  process.exit(0)
}

mkdirSync(CHUNK_DIR, { recursive: true })
const chunks = []
for (let i = 0; i < msgs.length; i += CHUNK_SIZE) chunks.push(msgs.slice(i, i + CHUNK_SIZE))
const chunkNotes = []
for (const [i, chunk] of chunks.entries()) {
  const body = chunk.map(m => '【' + m.speaker + '】' + (m.ts ? '（' + fmtTime(m.ts) + '）' : '') + m.text).join('\n\n')
  writeFileSync(join(CHUNK_DIR, 'chunk-' + String(i + 1).padStart(3, '0') + '.md'), body, 'utf8')
  let note = summarizeChunk(chunk)
  if (summarize && process.env.DEEPSEEK_API_KEY) {
    try {
      const s = await llmSummarize(chunk, i + 1)
      if (s) {
        note = s + '\n  - 启发式摘要：' + summarizeChunk(chunk)
        chunkNotes.push(note)
        continue
      }
    } catch (err) {
      console.warn('第 ' + (i + 1) + ' 块模型摘要失败：' + err.message)
    }
  }
  chunkNotes.push(note)
}

const faq = extractFaq(msgs)
const digest = buildDigest(msgs, faq, chunkNotes, files)
writeFileSync(join(ROOT, 'AGENTS.md'), digest, 'utf8')
writeFileSync(join(ROOT, 'AGENTS.local.md'), digest, 'utf8')
writeFileSync(join(OUT_DIR, '项目上下文.md'), digest, 'utf8')
const stats = {
  files,
  messageCount: msgs.length,
  chunkCount: chunks.length,
  speakers: Object.fromEntries(Object.entries(msgs.reduce((acc, m) => {
    acc[m.speaker] = (acc[m.speaker] ?? 0) + 1
    return acc
  }, {})).sort((a, b) => b[1] - a[1])),
  generatedAt: new Date().toISOString(),
}
writeFileSync(join(OUT_DIR, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8')
console.log('已生成：AGENTS.md、AGENTS.local.md、context/项目上下文.md、context/chunks/（' + chunks.length + ' 块）、context/stats.json')
console.log('FAQ 条数：' + faq.length + '；最近摘录：' + Math.min(40, msgs.length) + ' 条')

} // end isMain
