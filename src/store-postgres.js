import { Pool } from 'pg'
import { randomUUID, createHash } from 'node:crypto'
import { join, relative, isAbsolute, basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { AtomicState } from './state.js'
import { JsonlStore } from './store.js'

const S = 'requirement_assistant'
const safeCode = e => /^[A-Z0-9_]{3,30}$/.test(e?.code || '') ? e.code : 'DATABASE_UNAVAILABLE'
// Stable IDs permit replay without manufacturing duplicate users or attachments.
export function databaseId(...parts) {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}

/** Cloud history + local durable outbox. Single local service owns this directory.
 * Every operation is committed with its receipt in the same PostgreSQL transaction.
 * An uncertain COMMIT is replayed safely; no SQL failure is exposed with credentials.
 */
export class PostgresStore {
  constructor(dir, { url, appId, pool, log = () => {} }) {
    if (!pool && !url) throw new Error('启用数据库需要配置 DATABASE_URL')
    if (!appId) throw new Error('数据库存储需要应用身份 appId')
    this.dir = dir; this.appId = appId; this.log = log
    this.local = new JsonlStore(dir)
    this.queue = new AtomicState(join(dir, 'postgres-outbox.json'), { operations: [] })
    this.pool = pool ?? new Pool({ connectionString: url, max: 3,
      connectionTimeoutMillis: 4000, statement_timeout: 10000, query_timeout: 12000,
      idleTimeoutMillis: 10000, application_name: 'requirement-assistant' })
    this.pool.on?.('error', e => this.failed(e))
    this.tail = Promise.resolve(); this.flushing = null
    this.health = { enabled: true, connected: false, lastSuccessAt: null, errorCode: null }
  }
  async init() {
    await this.local.init(); await this.queue.init()
    await this.flush()
    this.timer = setInterval(() => { void this.flush() }, 15000)
    this.timer.unref?.()
  }
  failed(e) {
    const code = safeCode(e)
    if (this.health.errorCode !== code) this.log('数据库暂不可用，数据已保留本机待同步：' + code)
    this.health.connected = false; this.health.errorCode = code
  }
  succeeded() { this.health = { enabled:true,connected:true,lastSuccessAt:Date.now(),errorCode:null } }
  status() { return { ...this.health, pending: this.queue.data.operations.length } }
  serial(fn) {
    const job = this.tail.then(fn); this.tail = job.catch(() => {}); return job
  }
  async enqueue(type, payload) {
    await this.serial(async () => {
      this.queue.data.operations.push({ id: randomUUID(), type, payload: structuredClone(payload) })
      await this.queue.save()
    })
    if (!this.closing) void this.flush()
  }
  async append(record) {
    await this.enqueue('record', record)
    await this.local.append(record)
  }
  syncProfile(profile, platform = 'feishu') { return this.enqueue('profile', { ...profile, platform }) }
  syncRegistration(openId, registration) { return this.enqueue('registration', {userId:openId, platform:'feishu', registration}) }
  async readRegistration(openId) {
    const row=(await this.pool.query(`SELECT registration FROM ${S}.users WHERE app_id=$1 AND platform='feishu' AND external_user_id=$2`,[this.appId,openId])).rows[0]
    return row?.registration?.name ? row.registration : null
  }
  syncTask(task) { return this.enqueue('task', task) }
  resetConversation(msg, project = '') { return this.enqueue('reset', { ...msg, project }) }
  selectProject(msg, project) { return this.enqueue('project', { userId: msg.userId, platform: msg.platform, chatId: msg.chatId, project: project.id, projectName: project.name }) }
  getState() { return this.local.getState() }
  saveState() { return this.local.saveState() }
  userId(external, platform = 'feishu') { return databaseId('user', platform, this.appId, external) }
  async user(c, r) {
    if (!r.userId) return null
    const id = this.userId(r.userId, r.platform)
    await c.query(`INSERT INTO ${S}.users(id,platform,app_id,external_user_id,display_name)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
    [id, r.platform ?? 'feishu', this.appId, r.userId, r.userName || ''])
    return id
  }
  async conversation(c, r, uid) {
    if (!uid || !r.chatId) return null
    // A late reply always follows its original input, even after a reset.
    if (r.refId || (r.taskId && r.kind !== 'user_message')) {
      const hit = await c.query(`SELECT conversation_id FROM ${S}.messages WHERE id=$1 AND user_id=$2`, [r.refId || r.taskId, uid])
      if (hit.rows[0]) return hit.rows[0].conversation_id
    }
    const project = r.project ?? ''
    await c.query(`INSERT INTO ${S}.projects(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, [project, r.projectName || project || '默认项目'])
    const result = await c.query(`INSERT INTO ${S}.conversations(id,user_id,chat_id,project_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(user_id,chat_id,project_id,agent_id) WHERE status='active'
      DO UPDATE SET updated_at=now() RETURNING id`, [randomUUID(), uid, r.chatId, project])
    return result.rows[0].id
  }
  async apply(c, op) {
    const receipt = await c.query(`INSERT INTO ${S}.sync_events(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id`, [op.id])
    if (!receipt.rowCount) return
    const r = op.payload
    if (op.type === 'registration') {
      const uid=await this.user(c,r)
      await c.query(`UPDATE ${S}.users SET registration=$2,updated_at=now() WHERE id=$1`,[uid,JSON.stringify(r.registration)])
      return
    }
    if (op.type === 'profile') {
      const uid = await this.user(c, { userId: r.openId, userName: r.name, platform: r.platform })
      await c.query(`UPDATE ${S}.users SET display_name=$2,avatar_url=$3,profile_status=$4,
        profile_updated_at=$5,updated_at=now() WHERE id=$1 AND (profile_updated_at IS NULL OR profile_updated_at <= $5)`,
      [uid,r.name || '',r.avatar || '',r.status || 'unavailable',new Date(r.at || Date.now())])
      return
    }
    const uid = await this.user(c, r)
    if (op.type === 'reset') {
      await c.query(`UPDATE ${S}.conversations SET status='archived',updated_at=now()
        WHERE user_id=$1 AND chat_id=$2 AND project_id=$3 AND agent_id='requirement-assistant' AND status='active'`, [uid,r.chatId,r.project ?? ''])
      return
    }
    if (op.type === 'project') {
      await c.query(`INSERT INTO ${S}.projects(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=excluded.name`,[r.project,r.projectName])
      await c.query(`INSERT INTO ${S}.user_chat_settings(user_id,chat_id,active_project_id) VALUES($1,$2,$3)
        ON CONFLICT(user_id,chat_id) DO UPDATE SET active_project_id=excluded.active_project_id,updated_at=now()`,[uid,r.chatId,r.project])
      return
    }
    if (op.type === 'task') {
      const input = await c.query(`SELECT conversation_id FROM ${S}.messages WHERE id=$1 AND user_id=$2`,[r.id,uid])
      // Pre-integration local tasks have no cloud input; never invent a new history
      // or block new messages when one of those old results is manually resent.
      if (!input.rowCount) return
      const cid = input.rows[0].conversation_id
      await c.query(`INSERT INTO ${S}.tasks(id,conversation_id,user_id,input_message_id,status,result,error,
        delivery_status,delivery_attempts,delivery_progress,created_at,updated_at)
        VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,result=excluded.result,error=excluded.error,
        delivery_status=excluded.delivery_status,delivery_attempts=excluded.delivery_attempts,
        delivery_progress=excluded.delivery_progress,updated_at=excluded.updated_at`,
      [r.id,cid,uid,r.status,r.result ?? null,r.error ?? null,r.delivery || 'pending',r.deliveryAttempts || 0,
        JSON.stringify({ chunksSent:r.chunksSent || 0,filesSent:r.filesSent || 0 }),new Date(r.createdAt),new Date(r.updatedAt)])
      if (r.threadId) await c.query(`UPDATE ${S}.conversations SET codex_thread_id=$2,backend=$3 WHERE id=$1`,[cid,r.threadId,r.backend || 'codex'])
      for (const a of r.artifacts || []) await this.attachment(c, { file:a.path || a.file, name:a.name, id:databaseId('output',r.id,a.path || a.file), kind:'output' },cid,uid,null,r.id)
      return
    }
    if (op.type !== 'record') throw new Error('Unknown outbox operation')
    const existing = await c.query(`SELECT id FROM ${S}.records WHERE id=$1`,[r.id])
    if (existing.rowCount) return
    if (r.kind === 'user_message' && r.msgId) {
      const duplicate = await c.query(`SELECT message_id FROM ${S}.inbound_events
        WHERE platform=$1 AND app_id=$2 AND chat_id=$3 AND external_message_id=$4`,
      [r.platform || 'feishu',this.appId,r.chatId,r.msgId])
      if (duplicate.rowCount) return
    }
    // Unowned legacy records are archived in audit only, never used as model history.
    const cid = await this.conversation(c,r,uid)
    await c.query(`INSERT INTO ${S}.records(id,occurred_at,kind,user_id,conversation_id,payload,app_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [r.id,new Date(r.ts),r.kind,uid,cid,JSON.stringify(r),this.appId])
    if (cid && ['user_message','assistant_message'].includes(r.kind)) {
      let reply = null
      if (r.refId) {
        const hit = await c.query(`SELECT id FROM ${S}.messages WHERE id=$1 AND user_id=$2 AND conversation_id=$3`,[r.refId,uid,cid])
        reply = hit.rows[0]?.id ?? null
      }
      await c.query(`INSERT INTO ${S}.messages(id,conversation_id,user_id,role,content,external_message_id,reply_to_id,status,usage,metadata,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
      [r.id,cid,uid,r.kind === 'user_message' ? 'user':'assistant',r.text || '',r.msgId ?? null,reply,r.status || 'completed',
        r.usage ? JSON.stringify(r.usage):null,JSON.stringify({ taskId:r.taskId }),new Date(r.ts)])
      if (r.kind === 'user_message' && r.msgId) await c.query(`INSERT INTO ${S}.inbound_events(platform,app_id,chat_id,external_message_id,message_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[r.platform || 'feishu',this.appId,r.chatId,r.msgId,r.id])
    }
    if (cid && r.kind === 'attachment' && r.note) await this.attachment(c,{ file:r.note,name:r.text?.replace(/^\[附件\] /,''),id:r.id,kind:'upload' },cid,uid)
  }
  async attachment(c,a,cid,uid,messageId = null,taskId = null) {
    if (!a.file) return
    const key = relative(this.dir,a.file)
    if (isAbsolute(key) || key === '..' || key.startsWith('..\\') || key.startsWith('../')) throw new Error('Attachment outside data directory')
    const info = await stat(a.file).catch(() => null)
    const ext = (a.name || a.file).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
    const mime = ({ pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',
      webp:'image/webp',gif:'image/gif',txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json' })[ext] || null
    await c.query(`INSERT INTO ${S}.attachments(id,conversation_id,user_id,message_id,task_id,kind,filename,mime_type,size_bytes,storage_key,parse_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
    [a.id,cid,uid,messageId,taskId,a.kind,a.name || basename(a.file),mime,info?.size ?? null,key,info ? 'stored' : 'missing'])
  }
  flush() {
    if (this.flushing) return this.flushing
    this.flushing = this.drain().finally(() => { this.flushing = null })
    return this.flushing
  }
  async drain() {
    let c
    try {
      c = await this.pool.connect()
      await c.query(`SELECT id FROM ${S}.sync_events LIMIT 0`)
      for (;;) {
        const op = await this.serial(() => this.queue.data.operations[0])
        if (!op) break
        await c.query('BEGIN')
        try { await this.apply(c,op); await c.query('COMMIT') }
        catch(e) { await c.query('ROLLBACK').catch(() => {}); throw e }
        await this.serial(async () => {
          this.queue.data.operations.shift(); await this.queue.save()
        })
      }
      this.health = { enabled:true,connected:true,lastSuccessAt:Date.now(),errorCode:null }
    } catch(e) { this.failed(e) }
    finally { c?.release() }
  }
  async readRange(from,to) {
    const local = await this.local.readRange(from,to)
    let cloud = []
    try {
      const result = await this.pool.query(`SELECT payload FROM ${S}.records WHERE occurred_at >= $1 AND occurred_at < $2 AND app_id=$3 ORDER BY occurred_at`,[new Date(from),new Date(to),this.appId])
      cloud = result.rows.map(r => r.payload)
      this.succeeded()
    } catch(e) { this.failed(e) }
    const merged = new Map(cloud.map(r => [r.id,r]))
    for (const r of local) merged.set(r.id,r)
    for (const op of this.queue.data.operations) if (op.type === 'record' && op.payload.ts >= from && op.payload.ts < to) merged.set(op.payload.id,op.payload)
    return [...merged.values()].sort((a,b) => a.ts-b.ts)
  }
  async readUsers() {
    try {
      const result = await this.pool.query(`SELECT external_user_id AS "openId",display_name AS name,avatar_url AS avatar,
        profile_status AS status,extract(epoch FROM profile_updated_at)*1000 AS at
        FROM ${S}.users WHERE app_id=$1 AND platform='feishu'`,[this.appId])
      this.succeeded(); return result.rows.map(r => ({...r,at:Number(r.at) || 0}))
    } catch(e) { this.failed(e); return [] }
  }
  async adminUsers({ search = '', limit = 100, offset = 0 } = {}) {
    const q = String(search).trim()
    const result = await this.pool.query(`
      SELECT u.id, u.external_user_id AS "openId", u.display_name AS name,
        u.registration,
        u.avatar_url AS avatar, u.profile_status AS "profileStatus",
        u.created_at AS "createdAt", u.updated_at AS "updatedAt",
        COALESCE(s.conversations, 0)::int AS "conversationCount",
        COALESCE(s.messages, 0)::int AS "messageCount",
        COALESCE(s.attachments, 0)::int AS "attachmentCount",
        s.last_active_at AS "lastActiveAt"
      FROM ${S}.users u
      LEFT JOIN LATERAL (
        SELECT
          (SELECT count(*) FROM ${S}.conversations c WHERE c.user_id=u.id) AS conversations,
          (SELECT count(*) FROM ${S}.messages m WHERE m.user_id=u.id) AS messages,
          (SELECT count(*) FROM ${S}.attachments a WHERE a.user_id=u.id) AS attachments,
          (SELECT max(m.created_at) FROM ${S}.messages m WHERE m.user_id=u.id) AS last_active_at
      ) s ON true
      WHERE u.platform='feishu' AND u.app_id=$1
        AND ($2='' OR u.display_name ILIKE '%'||$2||'%' OR u.external_user_id ILIKE '%'||$2||'%')
      ORDER BY COALESCE(s.last_active_at,u.updated_at) DESC
      LIMIT $3 OFFSET $4
    `, [this.appId, q, Math.min(Math.max(Number(limit)||100,1),500), Math.max(Number(offset)||0,0)])
    const total = await this.pool.query(`SELECT count(*)::int AS count FROM ${S}.users
      WHERE platform='feishu' AND app_id=$1
        AND ($2='' OR display_name ILIKE '%'||$2||'%' OR external_user_id ILIKE '%'||$2||'%')`, [this.appId, q])
    this.succeeded(); return { users: result.rows, total: total.rows[0].count }
  }
  async adminUserDetails(openId) {
    const user = (await this.pool.query(`SELECT id,external_user_id AS "openId",display_name AS name,
      registration,
      avatar_url AS avatar,profile_status AS "profileStatus",profile_updated_at AS "profileUpdatedAt",
      created_at AS "createdAt",updated_at AS "updatedAt"
      FROM ${S}.users WHERE platform='feishu' AND app_id=$1 AND external_user_id=$2`, [this.appId, openId])).rows[0]
    if (!user) return null
    const conversations = await this.pool.query(`SELECT c.id,c.chat_id AS "chatId",c.project_id AS "projectId",
      p.name AS "projectName",c.backend,c.codex_thread_id AS "codexThreadId",c.status,
      c.created_at AS "createdAt",c.updated_at AS "updatedAt",
      count(m.id)::int AS "messageCount",max(m.created_at) AS "lastActiveAt"
      FROM ${S}.conversations c LEFT JOIN ${S}.projects p ON p.id=c.project_id
      LEFT JOIN ${S}.messages m ON m.conversation_id=c.id
      WHERE c.user_id=$1 GROUP BY c.id,p.name ORDER BY COALESCE(max(m.created_at),c.updated_at) DESC`, [user.id])
    const attachments = await this.pool.query(`SELECT id,conversation_id AS "conversationId",kind,filename,
      mime_type AS "mimeType",size_bytes AS "sizeBytes",parse_status AS "parseStatus",created_at AS "createdAt"
      FROM ${S}.attachments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [user.id])
    this.succeeded(); return { user, conversations: conversations.rows, attachments: attachments.rows }
  }
  async adminConversations({ userId = '', limit = 100, offset = 0 } = {}) {
    const result = await this.pool.query(`SELECT c.id,c.chat_id AS "chatId",c.project_id AS "projectId",
      p.name AS "projectName",c.backend,c.status,c.created_at AS "createdAt",c.updated_at AS "updatedAt",
      u.external_user_id AS "openId",u.display_name AS "userName",u.avatar_url AS avatar,
      COALESCE(s.messages,0)::int AS "messageCount",COALESCE(a.attachments,0)::int AS "attachmentCount",
      s.last_active_at AS "lastActiveAt",s.last_message AS "lastMessage"
      FROM ${S}.conversations c JOIN ${S}.users u ON u.id=c.user_id
      LEFT JOIN ${S}.projects p ON p.id=c.project_id
      LEFT JOIN LATERAL (
        SELECT count(*) AS messages,max(created_at) AS last_active_at,
          (array_agg(content ORDER BY created_at DESC,sequence_no DESC))[1] AS last_message
        FROM ${S}.messages WHERE conversation_id=c.id
      ) s ON true
      LEFT JOIN LATERAL (SELECT count(*) AS attachments FROM ${S}.attachments WHERE conversation_id=c.id) a ON true
      WHERE u.platform='feishu' AND u.app_id=$1 AND ($2='' OR u.external_user_id=$2)
      ORDER BY COALESCE(s.last_active_at,c.updated_at) DESC LIMIT $3 OFFSET $4`,
    [this.appId, String(userId), Math.min(Math.max(Number(limit)||100,1),500), Math.max(Number(offset)||0,0)])
    this.succeeded(); return { conversations: result.rows.map(row => ({ ...row, attachmentCount: Number(row.attachmentCount ?? 0) })) }
  }
  async adminConversationDetails(id) {
    const conversation = (await this.pool.query(`SELECT c.id,c.chat_id AS "chatId",c.project_id AS "projectId",
      p.name AS "projectName",c.backend,c.codex_thread_id AS "codexThreadId",c.status,
      c.created_at AS "createdAt",c.updated_at AS "updatedAt",u.external_user_id AS "openId",
      u.display_name AS "userName",u.avatar_url AS avatar
      FROM ${S}.conversations c JOIN ${S}.users u ON u.id=c.user_id
      LEFT JOIN ${S}.projects p ON p.id=c.project_id
      WHERE c.id=$1 AND u.platform='feishu' AND u.app_id=$2`, [id, this.appId])).rows[0]
    if (!conversation) return null
    const messages = await this.pool.query(`SELECT id,role,content,external_message_id AS "externalMessageId",
      status,usage,metadata,created_at AS "createdAt" FROM ${S}.messages
      WHERE conversation_id=$1 ORDER BY created_at,sequence_no LIMIT 1000`, [id])
    const attachments = await this.pool.query(`SELECT id,kind,filename,mime_type AS "mimeType",size_bytes AS "sizeBytes",
      parse_status AS "parseStatus",message_id AS "messageId",task_id AS "taskId",created_at AS "createdAt"
      FROM ${S}.attachments WHERE conversation_id=$1 ORDER BY created_at`, [id])
    this.succeeded(); return { conversation, messages: messages.rows, attachments: attachments.rows }
  }
  async adminAttachments({ userId = '', limit = 200 } = {}) {
    const result = await this.pool.query(`SELECT a.id,a.conversation_id AS "conversationId",a.kind,a.filename,
      a.mime_type AS "mimeType",a.size_bytes AS "sizeBytes",a.parse_status AS "parseStatus",
      a.storage_provider AS "storageProvider",a.created_at AS "createdAt",
      u.external_user_id AS "openId",u.display_name AS "userName",c.chat_id AS "chatId"
      FROM ${S}.attachments a JOIN ${S}.users u ON u.id=a.user_id
      JOIN ${S}.conversations c ON c.id=a.conversation_id
      WHERE u.platform='feishu' AND u.app_id=$1 AND ($2='' OR u.external_user_id=$2)
      ORDER BY a.created_at DESC LIMIT $3`, [this.appId, String(userId), Math.min(Math.max(Number(limit)||200,1),500)])
    this.succeeded(); return { attachments: result.rows }
  }
  async adminAttachment(id) {
    const item = (await this.pool.query(`SELECT a.id,a.filename,a.mime_type AS "mimeType",a.storage_provider AS "storageProvider",
      a.storage_key AS "storageKey" FROM ${S}.attachments a JOIN ${S}.users u ON u.id=a.user_id
      WHERE a.id=$1 AND u.platform='feishu' AND u.app_id=$2`, [id, this.appId])).rows[0] ?? null
    this.succeeded(); return item
  }
  async assignedProject(msg) {
    if (!msg.userId) return null
    try {
      const result = await this.pool.query(`SELECT p.project_id FROM ${S}.user_packages p
        JOIN ${S}.users u ON u.id=p.user_id
        WHERE p.status='active' AND u.platform=$1 AND u.app_id=$2 AND u.external_user_id=$3
        ORDER BY p.bound_at DESC LIMIT 1`,[msg.platform || 'feishu',this.appId,msg.userId])
      this.succeeded(); return result.rows[0]?.project_id ?? null
    } catch(e) { this.failed(e); return null }
  }
  async historyFor(msg, project, before = Date.now(), limit = 40) {
    if (!msg.userId) return []
    try {
      const uid=this.userId(msg.userId,msg.platform)
      const result=await this.pool.query(`SELECT role,content FROM (
        SELECT m.role,m.content,m.created_at,m.sequence_no FROM ${S}.messages m
        JOIN ${S}.conversations c ON c.id=m.conversation_id
        WHERE m.user_id=$1 AND (c.project_id=$2 ${this.enterpriseMode ? `OR EXISTS(SELECT 1 FROM ${S}.project_legacy_conversations l WHERE l.conversation_id=c.id AND l.project_id=$2)` : ''}) AND m.created_at < $3
          AND m.role IN ('user','assistant')
        ORDER BY m.created_at DESC,m.sequence_no DESC LIMIT $4
      ) h ORDER BY created_at,sequence_no`,[uid,project || '',new Date(before),Math.min(Math.max(limit,1),100)])
      this.succeeded(); return result.rows
    } catch(e) { this.failed(e); return [] }
  }
  async close() {
    this.closing = true; clearInterval(this.timer)
    await this.tail; await this.flush(); await this.pool.end()
  }
}
