// 会话记忆：按「聊天 + 项目」隔离的多轮对话历史，持久化到 data/memory/。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

function safeKey(chatId, projectId) {
  const raw = String(chatId) + '::' + String(projectId ?? '')
  return createHash('sha1').update(raw).digest('hex').slice(0, 20)
}

export class MemoryStore {
  /**
   * @param {string} dir data/memory 目录
   * @param {number} maxTurns 每会话保留的最大轮数（一轮 = 用户 + 助手）
   */
  constructor(dir, maxTurns = 20) {
    this.dir = dir
    this.maxTurns = maxTurns
    this.sessions = new Map() // key → [{role, content}]
    this._dirty = new Set()
    this._saveTimer = null
  }

  async init() {
    await mkdir(this.dir, { recursive: true })
  }

  key(chatId, projectId) {
    return safeKey(chatId, projectId)
  }

  async get(chatId, projectId) {
    const k = this.key(chatId, projectId)
    if (!this.sessions.has(k)) {
      try {
        const parsed = JSON.parse(await readFile(join(this.dir, k + '.json'), 'utf8'))
        if (Array.isArray(parsed)) this.sessions.set(k, parsed)
      } catch {
        // 文件缺失/损坏 → 空历史
      }
    }
    return this.sessions.get(k) ?? []
  }

  /** 追加一条消息（自动裁剪轮数）。 */
  async push(chatId, projectId, role, content) {
    const k = this.key(chatId, projectId)
    const list = await this.get(chatId, projectId)
    list.push({ role, content })
    const maxItems = this.maxTurns * 2
    if (list.length > maxItems) {
      // 从最早的「用户」消息处裁剪，保持 user/assistant 配对完整
      const overflow = list.length - maxItems
      let cut = 0
      let found = 0
      for (let i = 0; i < list.length; i++) {
        if (list[i].role === 'user') {
          found += 1
          if (found > overflow) {
            cut = i
            break
          }
        }
      }
      list.splice(0, cut)
    }
    this.sessions.set(k, list)
    this._dirty.add(k)
    this._scheduleSave()
    return list
  }

  /** 清空某会话（/new）。 */
  async clear(chatId, projectId) {
    const k = this.key(chatId, projectId)
    this.sessions.set(k, [])
    this._dirty.add(k)
    this._scheduleSave()
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      void this.saveDirty()
    }, 500)
  }

  async saveDirty() {
    const keys = [...this._dirty]
    this._dirty.clear()
    for (const k of keys) {
      const list = this.sessions.get(k) ?? []
      await writeFile(join(this.dir, k + '.json'), JSON.stringify(list), 'utf8').catch(err =>
        console.error('[memory] save failed:', err.message))
    }
  }

  async dispose() {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    await this.saveDirty()
  }
}
