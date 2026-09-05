// v6：提取文档名/章节号/红线/模块引用
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const data = JSON.parse(readFileSync(file, 'utf8'))
const conv = data.conversation

function nodeText(node) {
  const c = node?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(b => (b?.type === 'text' || typeof b === 'string') ? (b.text ?? b) : '').join('\n').trim()
  return ''
}

const docs = new Set()
const chapters = new Set()
const redlineBits = new Set()
let idx = 0
for (const exchange of conv.chatHistory) {
  for (const n of exchange?.structured_output_nodes ?? []) {
    const t = nodeText(n)
    if (!t) continue
    idx += 1
    for (const m of t.matchAll(/(?:docs[\/\\])?([A-Za-z0-9_\u4e00-\u9fa5·—\-]{2,60}\.md)/g)) {
      docs.add(m[1])
    }
    for (const m of t.matchAll(/\b(?:[26][A-C]|12)\.\d+\b/g)) {
      chapters.add(m[0])
    }
    for (const m of t.matchAll(/验收红线.{0,60}/g)) {
      redlineBits.add(m[0].slice(0, 80))
    }
  }
}
console.log('=== 引用的文档名（docs/*.md） ===')
console.log([...docs].sort().join('\n'))
console.log('')
console.log('=== 章节号引用 ===')
console.log([...chapters].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', '))
console.log('')
console.log('=== 验收红线片段（去重） ===')
console.log([...redlineBits].slice(0, 25).join('\n'))
