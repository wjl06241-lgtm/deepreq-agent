// Basic profile lookup; open_id is the identity, names are display-only.
import { AtomicState } from './state.js'
const SUCCESS_TTL = 24 * 3600 * 1000
const FAILURE_TTL = 5 * 60 * 1000

export class UserResolver {
  constructor(file) {
    this.state = new AtomicState(file, { users: {} })
    this.cache = new Map(); this.inflight = new Map(); this._warned = false
  }
  async init() {
    await this.state.init()
    for (const [openId, value] of Object.entries(this.state.data.users ?? {})) {
      this.cache.set(openId, { openId, name: value.name || '', avatar: value.avatar || '',
        status: value.status || (value.name ? 'available' : 'unavailable'), at: value.at || 0 })
    }
  }
  async resolve(client, openId, log) { const p = await this.profile(client, openId, log); return p.name || openId }
  async profile(client, openId, log = () => {}, { force = false } = {}) {
    if (!openId) throw new Error('缺少用户 ID')
    const hit = this.cache.get(openId)
    const ttl = hit?.status === 'available' ? SUCCESS_TTL : FAILURE_TTL
    if (!force && hit && Date.now() - hit.at < ttl) return { ...hit }
    if (this.inflight.has(openId)) return this.inflight.get(openId)
    const promise = this.fetch(client, openId, log).finally(() => this.inflight.delete(openId))
    this.inflight.set(openId, promise)
    return promise
  }
  async fetch(client, openId, log) {
    const previous = this.cache.get(openId)
    let profile = { openId, name: previous?.name || '', avatar: previous?.avatar || '', status: 'unavailable', at: Date.now() }
    if (client) {
      try {
        const res = await client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } })
        if (res?.code && res.code !== 0) throw new Error('飞书通讯录接口返回错误')
        const user = res?.data?.user
        if (!user?.name) throw new Error('接口未返回姓名')
        profile = { openId, name: String(user.name), avatar: user.avatar?.avatar_72 || user.avatar?.avatar_origin || '', status: 'available', at: Date.now() }
      } catch {
        profile.status = previous?.name ? 'stale' : 'unavailable'
        if (!this._warned) {
          this._warned = true
          log('暂未取得飞书用户基本信息：请核对通讯录权限及用户可见范围。会话仍按用户 ID 隔离。')
        }
      }
    }
    this.cache.set(openId, profile)
    await this.save()
    await this.onProfile?.(profile)
    return { ...profile }
  }
  list() { return [...this.cache.values()].map(value => ({ ...value })) }
  async save() { this.state.data.users = Object.fromEntries(this.cache); await this.state.save() }
  async dispose() { await Promise.allSettled(this.inflight.values()); await this.save() }
}
