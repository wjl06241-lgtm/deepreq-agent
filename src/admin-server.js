import { createServer } from 'node:http'
import { join, resolve, relative, isAbsolute, basename } from 'node:path'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dashboardHtml } from './dashboard.js'
import { enterpriseDashboard } from './enterprise-dashboard.js'
import { createSession, parseCookies, readSession, sessionCookie, verifyPassword } from './admin-auth.js'
import { loadAssistantConfig } from './config.js'
import { resolveProjectPrompt } from './context.js'
import { MATERIAL_LIMIT } from './project-configuration.js'
import { COMMAND_RE, isAnswered, resolveQuestion } from './monitor.js'

/** Shared HTTP management surface; callers own runtime and database lifecycles. */
export function createAdminServer({
  cfg, root: ROOT, configFile, appVersion, startedAt, store, projects,
  enterprises, enterpriseMode, projectConfiguration, assistant, users, apiClient,
  feishuReady, log = () => {}, standalone = false, sharedMaterials = false,
  beforeRequest = async () => {},
}) {
  // ── HTTP 运营看板 ──────────────────────────────────────────────────
  const sendJson = (res, data, status = 200, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
    res.end(JSON.stringify(data))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => {
      chunks.push(c)
      if (chunks.reduce((n, b) => n + b.length, 0) > 512*1024) req.destroy(new Error('request body too large'))
    })
    req.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })

  const apiStatus = async () => {
    const now = Date.now()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const dayStartTs = dayStart.getTime()
    const records = await store.readRange(dayStartTs - 6 * 86400000, now)
    const names = assistant.projectNames()
    const open = await assistant.openQuestions()

    const today = records.filter(r => r.ts >= dayStartTs)
    const todayUser = today.filter(r => r.kind === 'user_message' && !COMMAND_RE.test(r.text ?? ''))
    const todayAnswered = todayUser.filter(u => isAnswered(u, today)).length
    const todayErrors = today.filter(r => r.kind === 'error').length

    const byProject = new Map()
    for (const r of today) {
      const key = r.project ?? ''
      let e = byProject.get(key)
      if (!e) {
        e = {
          projectId: key,
          projectName: key ? (names[key] ?? key) : '默认会话',
          userMessages: 0, answered: 0, errors: 0,
        }
        byProject.set(key, e)
      }
      if (r.kind === 'user_message' && !COMMAND_RE.test(r.text ?? '')) e.userMessages += 1
      if (r.kind === 'error') e.errors += 1
    }
    for (const e of byProject.values()) {
      e.answered = todayUser.filter(u =>
        (u.project ?? '') === e.projectId && isAnswered(u, today)).length
      e.unanswered = e.userMessages - e.answered
      e.rate = e.userMessages > 0 ? Math.round((e.answered / e.userMessages) * 100) : null
    }
    const perProject = [...byProject.values()].sort((a, b) => b.userMessages - a.userMessages)

    const days = []
    for (let i = 6; i >= 0; i--) {
      const start = dayStartTs - i * 86400000
      const end = start + 86400000
      const recs = records.filter(r => r.ts >= start && r.ts < end)
      const user = recs.filter(r => r.kind === 'user_message' && !COMMAND_RE.test(r.text ?? ''))
      const answered = user.filter(u => isAnswered(u, recs)).length
      const errors = recs.filter(r => r.kind === 'error').length
      days.push({
        day: new Date(start).toLocaleDateString('zh-CN'),
        userMessages: user.length,
        answered,
        unanswered: user.length - answered,
        errors,
        rate: user.length > 0 ? Math.round((answered / user.length) * 100) : null,
      })
    }

    return {
      now,
      system: {
        version: appVersion,
        startedAt,
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: `${process.platform} ${process.arch}`,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        mode: standalone ? 'standalone-admin' : 'integrated',
        backend: standalone ? '独立管理平台' : cfg.backend,
        model: standalone ? '本地执行端（未接入实时状态）' : cfg.backend === 'codex' ? (cfg.codex.model || 'Codex 默认') : cfg.llm.model,
        feishuConfigured: feishuReady,
      },
      database: store.status?.() ?? { enabled: false },
      timeoutSec: cfg.unansweredTimeoutSec,
      tasks: assistant.runtime.tasks.list().slice(0,20).map(t => ({ id: t.id, status: t.status, delivery: t.delivery, project: t.project })),
      today: {
        userMessages: todayUser.length,
        answered: todayAnswered,
        unanswered: todayUser.length - todayAnswered,
        errors: todayErrors,
        totalRecords: today.length,
      },
      open: open.map(q => ({
        ...q,
        projectName: q.project ? (names[q.project] ?? q.project) : '默认会话',
      })),
      perProject,
      days,
    }
  }

  const apiChats = async () => {
    const now = Date.now()
    const records = await store.readRange(now - 7 * 86400000, now)
    const names = assistant.projectNames()
    const byChat = new Map()
    for (const r of records) {
      if (!r.chatId) continue
      const key = JSON.stringify([r.platform ?? 'feishu',r.chatId,r.userId ?? '',r.project ?? ''])
      let c = byChat.get(key)
      if (!c) {
        c = {
          platform: r.platform ?? 'feishu', chatId: r.chatId, userId: r.userId ?? '', project: r.project ?? '', lastTs: 0,
          userCount: 0, assistantCount: 0, lastText: '', lastProject: '', userName: '',
        }
        byChat.set(key, c)
      }
      if (r.ts > c.lastTs) {
        c.lastTs = r.ts
        c.lastText = String(r.text ?? r.status ?? r.error ?? '').slice(0, 80)
        c.lastProject = r.project ?? ''
      }
      if (r.userName) c.userName = r.userName
      if (r.kind === 'user_message') c.userCount += 1
      else if (r.kind === 'assistant_message') c.assistantCount += 1
    }
    const chats = [...byChat.values()].sort((a, b) => b.lastTs - a.lastTs)
    for (const c of chats) {
      c.projectName = c.lastProject ? (names[c.lastProject] ?? c.lastProject) : '默认会话'
    }
    return { chats }
  }

  const apiRecords = (url) => {
    return (async () => {
      const now = Date.now()
      const chatId = url.searchParams.get('chatId') ?? undefined
      const userId = url.searchParams.get('userId')
      const platform = url.searchParams.get('platform')
      const project = url.searchParams.get('project')
      const kind = url.searchParams.get('kind') ?? undefined
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
      const from = Number(url.searchParams.get('from') ?? now - 7 * 86400000)
      const records = await store.readRange(from, now)
      const list = records
        .filter(r => !chatId || r.chatId === chatId)
        .filter(r => userId === null || (r.userId ?? '') === userId)
        .filter(r => platform === null || (r.platform ?? 'feishu') === platform)
        .filter(r => project === null || (r.project ?? '') === project)
        .filter(r => !kind || r.kind === kind)
        .slice(-limit)
        .reverse()
      return { records: list }
    })()
  }

  const readSystemLog = async (limit = 400) => {
    const dir = process.env.SERVICE_LOG_DIR || join(cfg.dataDir, 'service')
    const files = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter(item => item.isFile() && /^service-\d{4}-\d{2}-\d{2}\.log$/.test(item.name))
      .map(item => item.name).sort().reverse()
    const lines = []
    for (const name of files.slice(0, 7)) {
      const raw = await readFile(join(dir, name), 'utf8').catch(() => '')
      for (const line of raw.split(/\r?\n/).filter(Boolean).reverse()) {
        lines.push({ file: name, text: line.slice(0, 4000) })
        if (lines.length >= limit) return lines
      }
    }
    return lines
  }

  const loginFailures = new Map()
  const loginWindowMs = 10 * 60_000
  const adminReady = Boolean(cfg.admin.passwordHash && cfg.admin.sessionSecret)
  const getSession = req => readSession(parseCookies(req.headers.cookie).ra_admin, cfg.admin.sessionSecret)
  const isSecure = req => req.socket.encrypted || String(req.headers['x-forwarded-proto']).toLowerCase() === 'https'
  const requireCsrf = (req, session) => req.method === 'GET' || req.method === 'HEAD' || req.headers['x-csrf-token'] === session.csrf

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(enterpriseDashboard(dashboardHtml({ standalone })))
        return
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        if (!adminReady) return sendJson(res, { error: '管理后台尚未设置登录密码' }, 503)
        const ip = req.socket.remoteAddress || 'unknown'
        const recent = (loginFailures.get(ip) || []).filter(ts => Date.now() - ts < loginWindowMs)
        if (recent.length >= 8) return sendJson(res, { error: '尝试次数过多，请十分钟后再试' }, 429)
        const body = await readBody(req)
        if (String(body.username) !== cfg.admin.username || !verifyPassword(String(body.password || ''), cfg.admin.passwordHash)) {
          recent.push(Date.now()); loginFailures.set(ip, recent)
          return sendJson(res, { error: '账号或密码错误' }, 401)
        }
        loginFailures.delete(ip)
        const token = createSession(cfg.admin.username, cfg.admin.sessionSecret, cfg.admin.sessionHours)
        const session = readSession(token, cfg.admin.sessionSecret)
        return sendJson(res, { ok: true, username: session.username, csrf: session.csrf }, 200, {
          'set-cookie': sessionCookie(token, cfg.admin.sessionHours * 3600, isSecure(req)),
        })
      }
      if (url.pathname === '/api/session') {
        const session = getSession(req)
        return session ? sendJson(res, { authenticated: true, username: session.username, csrf: session.csrf })
          : sendJson(res, { authenticated: false, configured: adminReady }, 401)
      }
      const session = getSession(req)
      if (!session) return sendJson(res, { error: '请先登录' }, 401)
      if (!requireCsrf(req, session)) return sendJson(res, { error: '安全校验失败，请刷新页面重试' }, 403)
      if (standalone) {
        const unavailable = url.pathname === '/api/resolve'
          || (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/refresh$/.test(url.pathname))
          || /^\/api\/admin\/attachments\/[^/]+\/download$/.test(url.pathname)
        if (unavailable) return sendJson(res, { error: '此操作依赖本地执行端，独立管理平台尚未接入；请使用本地后台。' }, 409)
        if (url.pathname === '/api/admin/logs') return sendJson(res, { lines: [{ file: '独立管理平台', text: '本地执行端日志尚未上报云端，请在本地后台查看。' }] })
        if (!sharedMaterials && /\/api\/enterprise\/(materials\/|global-materials)/.test(url.pathname)
          && ((req.method === 'POST' && !url.pathname.endsWith('/toggle')) || url.pathname.endsWith('/download'))) {
          return sendJson(res, { error: '尚未配置双方共享的项目资料目录；文件上传、下载请使用本地后台。' }, 409)
        }
      }
      await beforeRequest(url)
      const configurationRoute=/^\/api\/enterprise\/project-config\/([^/]+)$/.exec(url.pathname)
      if(url.pathname==='/api/enterprise/global-config'){
        if(!projectConfiguration)return sendJson(res,{error:'全局配置需要数据库支持'},503)
        try{
          if(req.method==='GET')return sendJson(res,await projectConfiguration.global())
          if(req.method==='POST')return sendJson(res,await projectConfiguration.saveGlobal(await readBody(req),session.username))
          return sendJson(res,{error:'不支持的操作'},405)
        }catch(e){return sendJson(res,{error:e.status?e.message:'全局配置操作失败'},e.status||500)}
      }
      const materialsRoute=/^\/api\/enterprise\/materials\/([^/]+)(?:\/([a-f0-9-]{36})(?:\/(toggle|download))?)?$/.exec(url.pathname)
      const globalMaterialsRoute=/^\/api\/enterprise\/global-materials(?:\/([a-f0-9-]{36})(?:\/(toggle|download))?)?$/.exec(url.pathname)
      if(configurationRoute || materialsRoute || globalMaterialsRoute){
        if(!projectConfiguration)return sendJson(res,{error:'项目配置未启用'},503)
        try{
          if(configurationRoute){
            const id=decodeURIComponent(configurationRoute[1])
            if(req.method==='GET'){
              const p=await projectConfiguration.project(id),legacy=loadAssistantConfig(configFile).projects[id]||{}
              const inheritedPrompt=standalone ? '本地文件提示词不在云数据库中，请在本地后台查看；显式设置项目提示词后以数据库配置为准。' : resolveProjectPrompt(ROOT,{...p,contextDir:legacy.contextDir||join(cfg.dataDir,'materials',p.id),promptFile:legacy.promptFile})||legacy.prompt||loadAssistantConfig(configFile).systemPrompt
              return sendJson(res,{...p,inheritedPrompt,legacyMaterials:Boolean(legacy.contextDir)})
            }
            if(req.method==='POST')return sendJson(res,await projectConfiguration.save(id,await readBody(req),session.username))
          }else{
            const [,encoded,id,operation]=globalMaterialsRoute ? [null,null,globalMaterialsRoute[1],globalMaterialsRoute[2]] : materialsRoute,projectId=globalMaterialsRoute ? null : decodeURIComponent(encoded)
            if(!id&&req.method==='GET')return sendJson(res,{files:await projectConfiguration.list(projectId)})
            if(!id&&req.method==='POST'){
              if(projectId!==null)await projectConfiguration.project(projectId)
              if(req.headers['content-type']!=='application/octet-stream')return sendJson(res,{error:'文件须以二进制上传'},415)
              if(Number(req.headers['content-length'])>MATERIAL_LIMIT)return sendJson(res,{error:'文件不能超过 50 MB'},413)
              const chunks=[];let length=0
              for await(const chunk of req){length+=chunk.length;if(length>MATERIAL_LIMIT){sendJson(res,{error:'文件不能超过 50 MB'},413);return}chunks.push(chunk)}
              return sendJson(res,await projectConfiguration.upload(projectId,url.searchParams.get('name'),Buffer.concat(chunks),url.searchParams.get('replacesId'),session.username))
            }
            if(id&&req.method==='POST'&&operation==='toggle')return sendJson(res,await projectConfiguration.toggle(projectId,id,(await readBody(req)).enabled,session.username))
            if(id&&req.method==='GET'){
              const row=(await projectConfiguration.list(projectId)).find(f=>f.id===id)
              if(!row)return sendJson(res,{error:'文件不属于此项目'},404)
              if(operation==='download'){
                const {bytes}=await projectConfiguration.file(row)
                res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(row.name),'content-length':bytes.length,'x-content-type-options':'nosniff','cache-control':'no-store'});res.end(bytes);return
              }
              return sendJson(res,row)
            }
          }
          return sendJson(res,{error:'不支持的操作'},405)
        }catch(e){return sendJson(res,{error:e.status?e.message:'项目配置服务暂时不可用'},e.status||500)}
      }
      if (url.pathname === '/api/enterprise/catalog' && req.method === 'GET') {
        if (!enterpriseMode) return sendJson(res,{error:'请先完成企业数据库迁移'},503)
        return sendJson(res,await enterprises.catalog())
      }
      if (/^\/api\/enterprise\/(enterprise|project|members)$/.test(url.pathname) && req.method === 'POST') {
        if (!enterpriseMode) return sendJson(res,{error:'企业管理未启用'},503)
        try {
          const result=await enterprises.mutate(url.pathname.split('/').at(-1),await readBody(req),session.username)
          await enterprises.refresh(projects)
          return sendJson(res,result)
        } catch(e) { return sendJson(res,{error:e.status?e.message:'保存失败，请检查数据或连接'},e.status||500) }
      }
      if (url.pathname === '/api/enterprise/history' && req.method === 'GET') {
        if (!enterpriseMode) return sendJson(res,{error:'企业管理未启用'},503)
        const id=url.searchParams.get('projectId')||''
        const page=Math.max(0,Math.min(Number(url.searchParams.get('page'))||0,100000))
        const rows=(await store.pool.query(`SELECT c.id,c.project_id AS "projectId",u.display_name AS name,u.app_id AS "appId",u.external_user_id AS "openId",c.updated_at AS "updatedAt",(SELECT count(*)::int FROM requirement_assistant.messages m WHERE m.conversation_id=c.id) AS "messageCount" FROM requirement_assistant.conversations c JOIN requirement_assistant.users u ON u.id=c.user_id WHERE c.project_id=$1 OR EXISTS(SELECT 1 FROM requirement_assistant.project_legacy_conversations l WHERE l.conversation_id=c.id AND l.project_id=$1) ORDER BY c.updated_at DESC,c.id LIMIT 51 OFFSET $2`,[id,page*50])).rows
        return sendJson(res,{conversations:rows.slice(0,50),hasMore:rows.length>50})
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        return sendJson(res, { ok: true }, 200, { 'set-cookie': sessionCookie('', 0, isSecure(req)) })
      }
      if (url.pathname === '/api/status') return sendJson(res, await apiStatus())
      if (url.pathname === '/api/chats') return sendJson(res, await apiChats())
      if (url.pathname === '/api/records') return sendJson(res, await apiRecords(url))
      if (url.pathname === '/api/users') {
        const merged = new Map((await store.readUsers?.() ?? []).map(u => [u.openId,u]))
        for (const u of users.list()) if (!merged.has(u.openId) || u.at >= merged.get(u.openId).at) merged.set(u.openId,u)
        return sendJson(res, { users: [...merged.values()] })
      }
      if (url.pathname === '/api/admin/users') {
        if (!store.adminUsers) return sendJson(res, { error: '用户详情需要启用 PostgreSQL' }, 503)
        return sendJson(res, await store.adminUsers({ search: url.searchParams.get('search') || '', limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }))
      }
      if (url.pathname.startsWith('/api/admin/users/') && url.pathname.endsWith('/refresh') && req.method === 'POST') {
        const openId = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length, -'/refresh'.length))
        if (!/^ou_[a-zA-Z0-9]+$/.test(openId)) return sendJson(res, { error: '飞书用户 ID 无效' }, 400)
        const profile = await users.profile(apiClient, openId, log, { force: true })
        await store.flush?.()
        return sendJson(res, { profile })
      }
      if (url.pathname.startsWith('/api/admin/users/') && url.pathname.endsWith('/note') && req.method === 'POST') {
        const openId = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length, -'/note'.length))
        const requestedAppId = standalone ? url.searchParams.get('appId') : null
        if (!/^ou_[a-zA-Z0-9]+$/.test(openId)) return sendJson(res, { error: '飞书用户 ID 无效' }, 400)
        if (requestedAppId && !/^cli_[a-zA-Z0-9]+$/.test(requestedAppId)) return sendJson(res, { error: '应用 ID 无效' }, 400)
        const body = await readBody(req)
        if (typeof body.note !== 'string' || body.note.length > 2000 || body.note.includes('\0')) return sendJson(res, { error: '备注不能超过 2000 字' }, 400)
        const scopedStore = requestedAppId ? Object.assign(Object.create(store), { appId: requestedAppId }) : store
        if (!scopedStore.adminSaveUserNote) return sendJson(res, { error: '用户备注需要启用 PostgreSQL' }, 503)
        const saved = await scopedStore.adminSaveUserNote(openId, body.note, session.username)
        return saved ? sendJson(res, saved) : sendJson(res, { error: '用户不存在' }, 404)
      }
      if (url.pathname.startsWith('/api/admin/users/')) {
        const openId = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length))
        const requestedAppId = standalone ? url.searchParams.get('appId') : null
        if (requestedAppId && !/^cli_[a-zA-Z0-9]+$/.test(requestedAppId)) return sendJson(res, { error: '应用 ID 无效' }, 400)
        const scopedStore = requestedAppId ? Object.assign(Object.create(store), { appId: requestedAppId }) : store
        const detail = await scopedStore.adminUserDetails?.(openId)
        return detail ? sendJson(res, detail) : sendJson(res, { error: '用户不存在' }, 404)
      }
      if (url.pathname === '/api/admin/conversations') {
        if (!store.adminConversations) return sendJson(res, { error: '会话详情需要启用 PostgreSQL' }, 503)
        return sendJson(res, await store.adminConversations({ userId: url.searchParams.get('userId') || '', limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }))
      }
      if (url.pathname.startsWith('/api/admin/conversations/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/admin/conversations/'.length))
        let scopedStore=store
        if (enterpriseMode) {
          const owner=(await store.pool.query(`SELECT u.app_id FROM requirement_assistant.conversations c JOIN requirement_assistant.users u ON u.id=c.user_id WHERE c.id=$1`,[id])).rows[0]
          if(owner){scopedStore=Object.create(store);scopedStore.appId=owner.app_id}
        }
        const detail = await scopedStore.adminConversationDetails?.(id)
        return detail ? sendJson(res, detail) : sendJson(res, { error: '会话不存在' }, 404)
      }
      if (url.pathname === '/api/admin/attachments') {
        if (!store.adminAttachments) return sendJson(res, { error: '附件详情需要启用 PostgreSQL' }, 503)
        return sendJson(res, await store.adminAttachments({ userId: url.searchParams.get('userId') || '', limit: url.searchParams.get('limit') }))
      }
      if (url.pathname.startsWith('/api/admin/attachments/') && url.pathname.endsWith('/download')) {
        const id = decodeURIComponent(url.pathname.slice('/api/admin/attachments/'.length, -'/download'.length))
        const item = await store.adminAttachment?.(id)
        if (!item || item.storageProvider !== 'local') return sendJson(res, { error: '文件不存在或不支持下载' }, 404)
        const file = resolve(cfg.dataDir, item.storageKey)
        const rel = relative(cfg.dataDir, file)
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) return sendJson(res, { error: '文件路径无效' }, 400)
        const info = await stat(file).catch(() => null)
        if (!info?.isFile()) return sendJson(res, { error: '本地文件已不存在' }, 404)
        res.writeHead(200, {
          'content-type': item.mimeType || 'application/octet-stream',
          'content-length': info.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(item.filename))}`,
          'cache-control': 'private, no-store',
        })
        createReadStream(file).pipe(res)
        return
      }
      if (url.pathname === '/api/admin/logs') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 400, 20), 2000)
        return sendJson(res, { lines: await readSystemLog(limit) })
      }
      if (url.pathname === '/api/admin/changes') {
        const content = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8').catch(() => '# 更新日志\n\n暂无记录。')
        return sendJson(res, { content, version: appVersion })
      }
      if (url.pathname === '/api/tasks') return sendJson(res, { tasks: assistant.runtime.tasks.list().slice(0,100).map(({result, ...task}) => task) })
      if (url.pathname === '/api/projects') {
        return sendJson(res, { projects: projects.list() })
      }
      if (url.pathname === '/api/resolve' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.qid) return sendJson(res, { error: 'qid is required' }, 400)
        await resolveQuestion(store, String(body.qid), body.note)
        return sendJson(res, { ok: true })
      }
      return sendJson(res, { error: 'not found' }, 404)
    } catch (err) {
      return sendJson(res, { error: standalone ? '管理服务暂时不可用，请检查数据库连接或服务器日志。' : String(err?.message ?? err) }, 500)
    }
  })
  return server
}
