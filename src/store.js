// 聊天记录存储（RecordSink 接口 + JSONL 本地实现）
// 拿到数据库表结构后：新增 store-sql.js 实现同一接口并替换实例即可。
// 记录字段（v1，供建表对照）：
//   { v:1, id, ts, kind: 'user_message'|'assistant_message'|'error'|'unanswered'|'ops_note',
//     platform:'feishu', chatId, userId, userName, project, text?, status?, refId?, action?, note? }

import { mkdir, readdir, readFile, writeFile, appendFile, unlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function dayKey(ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

const PREFIX = 'records-'

/** RecordSink 的 JSONL 实现：按天分文件。 */
export class JsonlStore {
  constructor(dir, retentionDays = 90) {
    this.dir = join(dir, 'records')
    this.stateFile = join(dir, 'state.json')
    this.retentionDays = retentionDays
    this._state = { alerted: {}, resolved: {} }
  }

  async init() {
    await mkdir(this.dir, { recursive: true })
    this._state = await this.loadState()
    await this.prune()
  }

  async loadState() {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8'))
      return { alerted: parsed.alerted ?? {}, resolved: parsed.resolved ?? {} }
    } catch (err) {
      if (err?.code !== 'ENOENT') console.error('[store] state.json load failed:', err.message)
      return { alerted: {}, resolved: {} }
    }
  }

  async saveState() {
    const tmp = this.stateFile + '.tmp'
    await writeFile(tmp, JSON.stringify(this._state, null, 2), 'utf8')
    await rename(tmp, this.stateFile)
  }

  getState() {
    return this._state
  }

  fileFor(ts) {
    return join(this.dir, PREFIX + dayKey(ts) + '.jsonl')
  }

  async append(record) {
    await appendFile(this.fileFor(record.ts), JSON.stringify(record) + '\n', 'utf8')
  }

  async readRange(fromTs, toTs) {
    let names = []
    try {
      names = (await readdir(this.dir)).filter(n => n.startsWith(PREFIX) && n.endsWith('.jsonl'))
    } catch {
      return []
    }
    const out = []
    for (const name of names.sort()) {
      const day = name.slice(PREFIX.length, -6)
      const fileStart = new Date(day + 'T00:00:00').getTime()
      const fileEnd = fileStart + 24 * 3600 * 1000
      if (fileEnd <= fromTs || fileStart >= toTs) continue
      let raw = ''
      try {
        raw = await readFile(join(this.dir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line)
          if (rec.ts >= fromTs && rec.ts < toTs) out.push(rec)
        } catch {
          // 跳过损坏行
        }
      }
    }
    out.sort((a, b) => a.ts - b.ts)
    return out
  }

  async prune() {
    const cutoff = Date.now() - this.retentionDays * 24 * 3600 * 1000
    let names = []
    try {
      names = (await readdir(this.dir)).filter(n => n.startsWith(PREFIX) && n.endsWith('.jsonl'))
    } catch {
      return
    }
    for (const name of names) {
      const day = name.slice(PREFIX.length, -6)
      if (new Date(day + 'T00:00:00').getTime() < cutoff) {
        await unlink(join(this.dir, name)).catch(() => {})
      }
    }
  }
}

export function newRecordId() {
  return randomUUID()
}
