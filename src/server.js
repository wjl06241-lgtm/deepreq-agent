// 需求助手 · 服务入口（飞书长连接 + DeepSeek API + 记录/监控/看板）

import { createAdminServer } from './admin-server.js'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadEnvFile, loadRuntimeConfig } from './config.js'
import { JsonlStore, newRecordId } from './store.js'
import { PostgresStore } from './store-postgres.js'
import { ProjectRegistry } from './projects.js'
import { MemoryStore } from './memory.js'
import { createAssistant, isTextFile, buildFileMessageText, decodeTextBuffer, extractPdfText } from './assistant.js'
import { chatCompletionVision, detectImageMime } from './llm.js'
import { scanUnanswered } from './monitor.js'
import { startFeishu, createApiClient, sendToChat, sendToUser, downloadResource, sendFileToChat, getBotIdentity, isMessageForBot } from './feishu.js'
import { UserResolver } from './users.js'
import { actorKey } from './identity.js'
import { createHash } from 'node:crypto'
import { Registration } from './registration.js'
import { Enterprises } from './enterprises.js'
import { ProjectConfiguration } from './project-configuration.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  loadEnvFile(join(ROOT, '.env'))
  const cfg = loadRuntimeConfig()
  const configFile = join(ROOT, 'config.json')
  const appVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const startedAt = Date.now()
  const instanceName = process.env.INSTANCE_NAME || ''
  const log = (msg) => console.log('[需求助手' + (instanceName ? ':' + instanceName : '') + '] ' + msg)

  mkdirSync(cfg.dataDir, { recursive: true })
  const store = cfg.database.enabled
    ? new PostgresStore(cfg.dataDir, { url: cfg.database.url, appId: cfg.feishu.appId, log })
    : new JsonlStore(cfg.dataDir)
  await store.init()
  const projects = new ProjectRegistry(join(cfg.dataDir, 'projects.json'))
  await projects.load()
  const enterprises = cfg.database.enabled ? new Enterprises(store.pool,cfg.feishu.appId) : null
  const enterpriseMode = enterprises ? await enterprises.enabled() : false
  const projectConfiguration=enterpriseMode ? new ProjectConfiguration(store.pool,process.env.PROJECT_MATERIALS_DIR || join(ROOT,'data','project-materials')) : null
  store.enterpriseMode=enterpriseMode
  if (enterpriseMode) await enterprises.refresh(projects)
  const memory = new MemoryStore(join(cfg.dataDir, 'memory'), cfg.maxHistoryTurns)
  await memory.init()
  // 飞书 open_id 与应用绑定；不同应用必须使用不同的本地用户缓存。
  const appCacheKey = createHash('sha256').update(cfg.feishu.appId || 'local').digest('hex').slice(0, 16)
  const users = new UserResolver(join(cfg.dataDir, `users-${appCacheKey}.json`))
  const registration = new Registration(join(cfg.dataDir, `registration-${appCacheKey}.json`))
  await registration.init()
  await users.init()
  if (store.syncProfile) {
    for (const profile of await store.readUsers()) {
      const local = users.cache.get(profile.openId)
      if (!local || profile.at > local.at) users.cache.set(profile.openId, profile)
    }
    await users.save()
    users.onProfile = profile => store.syncProfile(profile)
    for (const profile of users.list()) await store.syncProfile(profile)
  }

  const feishuReady = Boolean(cfg.feishu.appId && cfg.feishu.appSecret)
  registration.existing = new Set(users.list().map(profile => profile.openId))
  const apiClient = feishuReady ? createApiClient(cfg.feishu.appId, cfg.feishu.appSecret) : null
  let botIdentity = null
  let botIdentityRequest = null
  const resolveBotIdentity = async () => {
    if (botIdentity) return botIdentity
    if (!apiClient) return null
    if (!botIdentityRequest) botIdentityRequest = getBotIdentity(apiClient)
      .then(value => { botIdentity = value; log('飞书机器人身份: ' + (value.name || value.openId)); return value })
      .finally(() => { botIdentityRequest = null })
    return botIdentityRequest
  }
  if (apiClient) await resolveBotIdentity().catch(err => log('飞书机器人身份读取失败: ' + (err?.message ?? err) + '（群聊暂不响应，避免误触发）'))

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

  const sendReply = async (chatId, text, options) => {
    if (!apiClient) {
      log('（未配飞书凭据，回复仅打印）' + String(text).slice(0, 120).replace(/\n/g, ' '))
      return
    }
    log('回复 ' + chatId + ': ' + String(text).slice(0, 60).replace(/\n/g, ' '))
    await sendToChat(apiClient, chatId, text, options)
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
    cfg, configFile, root: ROOT, store, projects, memory,projectConfiguration,
    sendReply, alertAdmins, log,
    sendFile: async (chatId, artifact, options) => {
      if (!apiClient) throw new Error('飞书通道未连接')
      await sendFileToChat(apiClient, chatId, artifact, options)
    },
  })

  await assistant.ready

  // ── 入站处理（按聊天串行 + 幂等） ──────────────────────────────────
  const seen = new Map()

  const inboxDir = join(cfg.dataDir, 'inbox')

  /** 附件处理：下载落盘 → 记录 → 文本类抽取进对话，图片/二进制回复说明。 */
  const handleAttachment = async (msg) => {
    if (!apiClient) {
      await sendReply(msg.chatId, '📎 未配置飞书凭据，无法下载附件。')
      return
    }
    const chatInbox = join(inboxDir, createHash('sha256').update(actorKey(msg)).digest('hex').slice(0,24))
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
    const projectId = assistant.projectFor(msg)?.id ?? ''
    await store.append({
      v: 1, id: newRecordId(), ts: Date.now(), kind: 'attachment', platform: 'feishu',
      chatId: msg.chatId, userId: msg.userId, userName: msg.userName, project: projectId,
      text: '[附件] ' + safeName, status: type, note: dest,
    })
    log('附件已保存 ' + safeName)
    if (assistant.backendFor(msg) === 'codex') {
      return assistant.processMessage({ ...msg, text: '请阅读本次附件，概述内容，并说明需要注意的问题。',
        attachment: { file: dest, name: safeName } })
    }
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
        await memory.push(actorKey(msg), projectId, 'user', '【飞书图片：' + safeName + '】请识别其中内容')
        await memory.push(actorKey(msg), projectId, 'assistant', text)
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
    actorKey(msg)
    if (msg.chatType === 'group') {
      const identity = botIdentity ?? await resolveBotIdentity().catch(() => null)
      if (!isMessageForBot(msg, identity?.openId)) {
        log('忽略未 @ 本机器人的群消息 ' + msg.chatId)
        return
      }
      for (const mention of msg.mentions) {
        if (mention.openId === identity.openId && mention.key && msg.kind === 'text') {
          msg.text = msg.text.split(mention.key).join(' ').replace(/[ \t]{2,}/g, ' ').trim()
        }
      }
      if (msg.kind === 'text' && !msg.text) return
    }
    if (enterpriseMode) {
      // 飞书只会把已授权的群聊 @机器人 消息投递到这里。群聊同样按
      // chatId + userId 隔离身份、项目选择、记忆与任务，不能在此整类丢弃。
      try { await enterprises.refresh(projects) }
      catch { await sendReply(msg.chatId,'项目权限暂时无法读取，请稍后重试。'); return }
    }
    msg.userProfile = await users.profile(apiClient, msg.userId, log)
    msg.enterpriseName = projects.enterprise?.name || ''
    msg.userName = msg.userProfile.name || msg.userId
    if (await registration.handle(msg, sendReply,
      (openId, profile) => store.syncRegistration?.(openId, profile),
      openId => store.readRegistration?.(openId) ?? null)) return
    const assignedProject = await store.assignedProject?.(msg)
    if (assignedProject && projects.selectionFor(actorKey(msg)) === undefined) projects.setActive(actorKey(msg), assignedProject)
    msg.boundProjectId = projects.selectionFor(actorKey(msg)) ?? projects.activeFor(msg.chatId)?.id ?? ''
    if (enterpriseMode && msg.kind !== 'text' && msg.boundProjectId && !assistant.projectFor(msg)) {
      await sendReply(msg.chatId,'当前项目已不可访问。请发送“返回普通聊天”或选择已授权项目后重新上传附件。'); return
    }
    const preview = msg.kind === 'text' ? msg.text.slice(0, 60) : ('[' + msg.kind + '] ' + (msg.fileName ?? ''))
    log('收到消息 ' + msg.chatId + ' [' + (msg.userName || msg.userId) + ']: ' + preview)
    if (msg.msgId && seen.has(msg.msgId)) return
    if (msg.msgId) {
      seen.set(msg.msgId, Date.now())
      if (seen.size > 2000) seen.delete(seen.keys().next().value)
    }
    if (msg.kind === 'text' && /^\s*\/(cancel|task)\b/i.test(msg.text)) {
      await assistant.processMessage(msg)
      return
    }
    const task = msg.kind === 'text' ? assistant.processMessage(msg) : handleAttachment(msg)
    void task.catch(err => log('处理消息失败: ' + (err?.message ?? err)))
  }

  // ── 飞书通道 ───────────────────────────────────────────────────────
  startFeishu({
    appId: cfg.feishu.appId,
    appSecret: cfg.feishu.appSecret,
    onMessage: handleInbound,
    onCardAction: async (msg, value) => {
      try {
        await enterprises.refresh(projects)
        await assistant.confirmProject(msg, { nonce: value.nonce, projectId: value.projectId })
      } catch {
        await sendReply(msg.chatId, '项目确认暂时失败，请重新发送原问题。')
      }
    },
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
    }, assistant.runtime.tasks).catch(err => log('未回答扫描失败: ' + (err?.message ?? err)))
  }
  void scan()
  const scanTimer = setInterval(scan, 60_000)
  const deliveryTimer = setInterval(() => { void assistant.runtime.retryDeliveries().catch(() => {}) }, 60000)

  const server = createAdminServer({
    cfg, root: ROOT, configFile, appVersion, startedAt, store, projects,
    enterprises, enterpriseMode, projectConfiguration, assistant, users, apiClient,
    feishuReady, log,
  })
  server.listen(cfg.adminPort, cfg.adminHost, () => {
    log('运营看板: http://' + cfg.adminHost + ':' + cfg.adminPort + '/')
  })

  // ── 优雅退出 ───────────────────────────────────────────────────────
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    log('正在退出…')
    clearInterval(scanTimer)
    clearInterval(deliveryTimer)
    server.close()
    await assistant.dispose()
    await memory.dispose()
    await projects.dispose()
    await users.dispose()
    await store.saveState()
    await store.close?.()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('message', message => { if (message?.type === 'shutdown') void shutdown() })

  log('需求助手已启动 v2 | 后端: ' + cfg.backend + ' | 模型: ' + (cfg.backend === 'codex' ? (cfg.codex.model || 'Codex 默认') : cfg.llm.model)
    + ' | 推理强度: ' + (cfg.llm.reasoningEffort || '未设置')
    + ' | 数据目录: ' + cfg.dataDir)
}

main().catch((err) => {
  console.error('[需求助手] 启动失败:', err)
  process.exit(1)
})
