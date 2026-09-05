// 需求助手 · 服务入口（飞书长连接 + DeepSeek API + 记录/监控/看板）

import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadEnvFile, loadRuntimeConfig } from './config.js'
import { JsonlStore, newRecordId } from './store.js'
import { ProjectRegistry } from './projects.js'
import { MemoryStore } from './memory.js'
import { createAssistant, isTextFile, buildFileMessageText, decodeTextBuffer, extractPdfText } from './assistant.js'
import { chatCompletionVision, detectImageMime } from './llm.js'
import { COMMAND_RE, scanUnanswered, resolveQuestion, isAnswered } from './monitor.js'
import { startFeishu, createApiClient, sendToChat, sendToUser, downloadResource } from './feishu.js'
import { UserResolver } from './users.js'
import { dashboardHtml } from './dashboard.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  loadEnvFile(join(ROOT, '.env'))
  const cfg = loadRuntimeConfig()
  const configFile = join(ROOT, 'config.json')
  const log = (msg) => console.log('[需求助手] ' + msg)

  mkdirSync(cfg.dataDir, { recursive: true })
  const store = new JsonlStore(cfg.dataDir)
  await store.init()
  const projects = new ProjectRegistry(join(cfg.dataDir, 'projects.json'))
  await projects.load()
  const memory = new MemoryStore(join(cfg.dataDir, 'memory'), cfg.maxHistoryTurns)
  await memory.init()
  const users = new UserResolver(join(cfg.dataDir, 'users.json'))
  await users.init()

  const feishuReady = Boolean(cfg.feishu.appId && cfg.feishu.appSecret)
  const apiClient = feishuReady ? createApiClient(cfg.feishu.appId, cfg.feishu.appSecret) : null

  // 启动自检：读取应用信息，确认 .env 的 App ID 对应正确的应用
  if (apiClient) {
    try {
      const res = await apiClient.application.v6.application.get({
        path: { app_id: cfg.feishu.appId },
        params: { lang: 'zh_cn' },
      })
      const app = res?.data?.app ?? {}
      log('飞书应用: ' + (app.app_name ?? '(无名称)') + ' | 状态: ' + (app.app_status ?? '未知') + ' | appId: ' + cfg.feishu.appId)
    } catch (err) {
      log('飞书应用信息读取失败: ' + (err?.message ?? err) + '（不影响收发，仅自检提示）')
    }
  }

  const sendReply = async (chatId, text) => {
    if (!apiClient) {
      log('（未配飞书凭据，回复仅打印）' + String(text).slice(0, 120).replace(/\n/g, ' '))
      return
    }
    log('回复 ' + chatId + ': ' + String(text).slice(0, 60).replace(/\n/g, ' '))
    await sendToChat(apiClient, chatId, text)
  }

  const alertAdmins = async (text) => {
    if (!apiClient || cfg.alertChats.length === 0) return
    for (const target of cfg.alertChats) {
      const openId = target.startsWith('feishu:') ? target.slice(7) : target
      try {
        await sendToUser(apiClient, openId, text)
      } catch (err) {
        log('告警发送失败 ' + target + ': ' + (err?.message ?? err))
      }
    }
  }

  const assistant = createAssistant({
    cfg, configFile, root: ROOT, store, projects, memory,
    sendReply, alertAdmins, log,
  })

  // ── 入站处理（按聊天串行 + 幂等） ──────────────────────────────────
  const seen = new Map()
  const queues = new Map()

  const inboxDir = join(cfg.dataDir, 'inbox')

  /** 附件处理：下载落盘 → 记录 → 文本类抽取进对话，图片/二进制回复说明。 */
  const handleAttachment = async (msg) => {
    if (!apiClient) {
      await sendReply(msg.chatId, '📎 未配置飞书凭据，无法下载附件。')
      return
    }
    const chatInbox = join(inboxDir, String(msg.chatId).replace(/[^A-Za-z0-9._-]/g, '-'))
    await mkdir(chatInbox, { recursive: true })
    const stamp = Date.now()
    const isImage = msg.kind === 'image'
    const type = isImage ? 'image' : 'file'
    const rawName = isImage ? ('图片-' + stamp + '.img') : (msg.fileName || ('文件-' + stamp))
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, '_')
    const dest = join(chatInbox, stamp + '-' + safeName)
    try {
      await downloadResource(apiClient, msg.msgId, isImage ? msg.imageKey : msg.fileKey, type, dest)
    } catch (err) {
      // 飞书错误体可能是流（SDK 用 responseType:stream），需要读出；其次是 JSON/文本
      let feishuMsg = err?.response?.data?.msg ?? err?.cause?.message ?? ''
      const data = err?.response?.data
      if (!feishuMsg && data && typeof data.on === 'function') {
        feishuMsg = await new Promise((resolve) => {
          const chunks = []
          data.on('data', c => chunks.push(c))
          data.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            try {
              const j = JSON.parse(raw)
              resolve(j.msg ?? j.message ?? raw)
            } catch {
              resolve(raw)
            }
          })
          data.on('error', () => resolve(''))
        })
      }
      if (!feishuMsg) feishuMsg = err?.message ?? String(err)
      log('附件下载失败: ' + feishuMsg)
      await sendReply(msg.chatId, '❌ 附件下载失败：' + String(feishuMsg).slice(0, 200)
        + '\n常见原因：① 未开通 im:resource 权限或未重新发布版本；② 资源已过期（重发一次试试）。')
      return
    }
    const projectId = projects.activeFor(msg.chatId)?.id ?? ''
    await store.append({
      v: 1, id: newRecordId(), ts: Date.now(), kind: 'attachment', platform: 'feishu',
      chatId: msg.chatId, userId: msg.userId, userName: msg.userName, project: projectId,
      text: '[附件] ' + safeName, status: type, note: dest,
    })
    log('附件已保存 ' + dest)
    if (isImage) {
      if (!cfg.vision.model) {
        await sendReply(msg.chatId, '🖼️ 已收到图片并保存：\n' + dest + '\n未配置视觉模型（.env 填 VISION_MODEL 即启用识别）。')
        return
      }
      let buf
      try {
        buf = readFileSync(dest)
      } catch {
        await sendReply(msg.chatId, '🖼️ 图片已保存，但读取失败。')
        return
      }
      if (buf.length > cfg.vision.maxBytes) {
        await sendReply(msg.chatId, '🖼️ 图片已保存，但超过视觉模型大小上限（' + Math.round(cfg.vision.maxBytes / 1024 / 1024) + 'MB），未识别。')
        return
      }
      const mime = detectImageMime(buf)
      if (!mime) {
        await sendReply(msg.chatId, '🖼️ 图片已保存，但格式无法识别（支持 png/jpeg/gif/webp）。')
        return
      }
      const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64')
      try {
        const { text, usage } = await chatCompletionVision({
          baseUrl: cfg.vision.baseUrl,
          apiKey: cfg.vision.apiKey,
          model: cfg.vision.model,
          prompt: cfg.vision.prompt,
          imageDataUrl: dataUrl,
          maxTokens: cfg.llm.maxTokens,
        })
        await memory.push(msg.chatId, projectId, 'user', '【飞书图片：' + safeName + '】请识别其中内容')
        await memory.push(msg.chatId, projectId, 'assistant', text)
        await store.append({
          v: 1, id: newRecordId(), ts: Date.now(), kind: 'assistant_message', platform: 'feishu',
          chatId: msg.chatId, userId: msg.userId, userName: msg.userName, project: projectId,
          text: '（图片识别）' + text, usage,
        })
        await sendReply(msg.chatId, text)
      } catch (err) {
        const message = err?.message ?? String(err)
        log('图片识别失败: ' + message)
        await store.append({
          v: 1, id: newRecordId(), ts: Date.now(), kind: 'error', platform: 'feishu',
          chatId: msg.chatId, userId: msg.userId, userName: msg.userName, project: projectId,
          error: message.slice(0, 2000), text: '[图片识别失败] ' + safeName,
        })
        await sendReply(msg.chatId, '❌ 图片识别失败：' + message.slice(0, 200) + '（检查 VISION_MODEL / VISION_API_KEY / VISION_BASE_URL 配置）')
      }
      return
    }
    if (/\.pdf$/i.test(safeName)) {
      let content = ''
      try {
        content = await extractPdfText(readFileSync(dest))
      } catch (err) {
        log('PDF 解析失败: ' + (err?.message ?? err))
        await sendReply(msg.chatId, '📎 PDF 已保存，但解析失败（文件可能损坏或加密）。')
        return
      }
      if (!content.trim()) {
        await sendReply(msg.chatId, '📎 PDF 已保存，但它是扫描件/图片型、没有文本层，无法抽取文字。\n如需识别：可把关键页截图发我（配好视觉模型后），或先 OCR 转文字再发。')
        return
      }
      await assistant.processMessage({ ...msg, kind: 'text', text: buildFileMessageText(safeName, content) })
      return
    }
    if (!isTextFile(safeName)) {
      await sendReply(msg.chatId, '📎 已收到文件「' + safeName + '」并保存：\n' + dest + '\n当前支持解析：文本类（txt/md/csv/json 等）与 PDF；Word/Excel 等请转为文本，或放入工作区目录。')
      return
    }
    let content = ''
    try {
      content = decodeTextBuffer(readFileSync(dest))
    } catch {
      await sendReply(msg.chatId, '📎 文件已保存，但读取内容失败。')
      return
    }
    if (!content.trim()) {
      await sendReply(msg.chatId, '📎 文件已保存（内容为空）。')
      return
    }
    // 文本类文件：内容进对话，让模型基于文件回答
    await assistant.processMessage({ ...msg, kind: 'text', text: buildFileMessageText(safeName, content) })
  }

  const handleInbound = async (msg) => {
    const name = await users.resolve(apiClient, msg.userId, log)
    if (name && name !== msg.userId) msg.userName = name
    const preview = msg.kind === 'text' ? msg.text.slice(0, 60) : ('[' + msg.kind + '] ' + (msg.fileName ?? ''))
    log('收到消息 ' + msg.chatId + ' [' + (msg.userName || msg.userId) + ']: ' + preview)
    if (msg.msgId && seen.has(msg.msgId)) return
    if (msg.msgId) {
      seen.set(msg.msgId, Date.now())
      if (seen.size > 2000) seen.delete(seen.keys().next().value)
    }
    const prev = queues.get(msg.chatId) ?? Promise.resolve()
    const task = msg.kind === 'text'
      ? () => assistant.processMessage(msg)
      : () => handleAttachment(msg)
    const next = prev
      .then(task)
      .catch(err => log('处理消息失败: ' + (err?.message ?? err)))
    queues.set(msg.chatId, next)
  }

  // ── 飞书通道 ───────────────────────────────────────────────────────
  startFeishu({
    appId: cfg.feishu.appId,
    appSecret: cfg.feishu.appSecret,
    onMessage: handleInbound,
    log,
  })

  // ── 未回答扫描（每分钟） ───────────────────────────────────────────
  const scan = () => {
    scanUnanswered(store, cfg.unansweredTimeoutSec, async (q) => {
      const projName = assistant.projectNames()[q.project] ?? '默认会话'
      await alertAdmins('🔔 未回答告警\n'
        + '项目: ' + projName + '\n'
        + '用户: ' + (q.userName || q.userId || q.chatId) + '\n'
        + '时间: ' + new Date(q.ts).toLocaleString('zh-CN', { hour12: false }) + '\n'
        + '问题: ' + q.text.slice(0, 120) + '\n'
        + '处理: 运营看板 http://127.0.0.1:' + cfg.adminPort + '/')
    }).catch(err => log('未回答扫描失败: ' + (err?.message ?? err)))
  }
  void scan()
  const scanTimer = setInterval(scan, 60_000)

  // ── HTTP 运营看板 ──────────────────────────────────────────────────
  const sendJson = (res, data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
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
      timeoutSec: cfg.unansweredTimeoutSec,
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
      let c = byChat.get(r.chatId)
      if (!c) {
        c = {
          platform: r.platform ?? 'feishu', chatId: r.chatId, lastTs: 0,
          userCount: 0, assistantCount: 0, lastText: '', lastProject: '', userName: '',
        }
        byChat.set(r.chatId, c)
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
      const kind = url.searchParams.get('kind') ?? undefined
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
      const from = Number(url.searchParams.get('from') ?? now - 7 * 86400000)
      const records = await store.readRange(from, now)
      const list = records
        .filter(r => !chatId || r.chatId === chatId)
        .filter(r => !kind || r.kind === kind)
        .slice(-limit)
        .reverse()
      return { records: list }
    })()
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // 访问令牌校验（未配置 adminToken 时跳过）：?token= 或 Authorization: Bearer <token>
    if (cfg.adminToken) {
      const token = url.searchParams.get('token') ?? String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (token !== cfg.adminToken) {
        return sendJson(res, { error: 'unauthorized: pass ?token=<adminToken>' }, 401)
      }
    }
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(dashboardHtml())
        return
      }
      if (url.pathname === '/api/status') return sendJson(res, await apiStatus())
      if (url.pathname === '/api/chats') return sendJson(res, await apiChats())
      if (url.pathname === '/api/records') return sendJson(res, await apiRecords(url))
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
      return sendJson(res, { error: String(err?.message ?? err) }, 500)
    }
  })
  server.listen(cfg.adminPort, cfg.adminHost, () => {
    const displayHost = cfg.adminHost === '0.0.0.0' ? '<服务器IP>' : cfg.adminHost
    log('运营看板: http://' + displayHost + ':' + cfg.adminPort + '/' + (cfg.adminToken ? '?token=<adminToken>' : ''))
  })

  // ── 优雅退出 ───────────────────────────────────────────────────────
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    log('正在退出…')
    clearInterval(scanTimer)
    server.close()
    await memory.dispose()
    await projects.dispose()
    await users.dispose()
    await store.saveState()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  log('需求助手已启动 v2026-09-05.2 | 模型: ' + cfg.llm.model
    + ' | 推理强度: ' + (cfg.llm.reasoningEffort || '未设置')
    + ' | 数据目录: ' + cfg.dataDir)
}

main().catch((err) => {
  console.error('[需求助手] 启动失败:', err)
  process.exit(1)
})
