// 飞书用户信息解析：open_id → 姓名（带本地缓存与飞行中去重）
// 依赖权限：contact:user.base:readonly（获取用户基本信息）；未开通时降级使用 open_id。

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const CACHE_TTL_MS = 24 * 3600 * 1000

export class UserResolver {
  constructor(file) {
    this.file = file
    this.cache = new Map() // openId → { name, at }
    this.inflight = new Map() // openId → Promise（并发去重）
    this._warned = false
    this._saveTimer = null
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      for (const [id, v] of Object.entries(parsed.users ?? {})) {
        if (v && typeof v.name === 'string') {
          this.cache.set(id, { name: v.name, at: v.at ?? 0 })
        }
      }
    } catch {
      // 首次启动，无缓存文件
    }
  }

  /**
   * 解析用户姓名：缓存命中直接返回；否则调用通讯录接口；失败回退 open_id。
   * @param {object|null} apiClient 飞书 API 客户端（未配凭据时为 null）
   * @param {string} openId 用户 open_id
   * @param {(line: string) => void} log
   * @returns {Promise<string>}
   */
  async resolve(apiClient, openId, log) {
    if (!openId) return ''
    const hit = this.cache.get(openId)
    if (hit && hit.name && Date.now() - hit.at < CACHE_TTL_MS) return hit.name
    if (this.inflight.has(openId)) return this.inflight.get(openId)
    const task = this.fetch(apiClient, openId, log)
    this.inflight.set(openId, task)
    try {
      return await task
    } finally {
      this.inflight.delete(openId)
    }
  }

  async fetch(apiClient, openId, log) {
    let name = ''
    if (apiClient) {
      try {
        const res = await apiClient.contact.v3.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        })
        name = res?.data?.user?.name ?? ''
      } catch (err) {
        if (!this._warned) {
          this._warned = true
          log('用户信息查询失败（缺 contact:user.base:readonly 权限或接口错误），将使用 open_id。'
            + '飞书后台添加「获取用户基本信息」权限后重新发布版本即可显示姓名。')
        }
      }
    }
    this.cache.set(openId, { name, at: Date.now() })
    this._scheduleSave()
    return name || openId
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      void this.save()
    }, 3000)
  }

  async save() {
    try {
      await mkdir(join(this.file, '..'), { recursive: true })
      const users = {}
      for (const [id, v] of this.cache) users[id] = v
      const tmp = this.file + '.tmp'
      await writeFile(tmp, JSON.stringify({ users }, null, 2), 'utf8')
      await rename(tmp, this.file)
    } catch (err) {
      console.error('[users] save failed:', err?.message ?? err)
    }
  }

  async dispose() {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    await this.save()
  }
}
