// 飞书机器人：长连接收事件（免公网）+ 消息发送

import * as lark from '@larksuiteoapi/node-sdk'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildReplyCards, basicReplyCard } from './feishu-presentation.js'

function checkResponse(res) {
  if (res?.code && res.code !== 0) throw Object.assign(new Error('飞书发送失败：' + res.code + ' ' + (res.msg ?? '')), {code:res.code})
  return res
}

/**
 * 解析 im.message.receive_v1 事件为统一入站消息（支持文本/图片/文件）。
 * 注意：node-sdk 长连接模式的 EventDispatcher 会把事件的 event 字段解包提升到顶层
 * （RequestHandle.parse 的 ...event），因此优先读顶层 message/sender，
 * 同时兼容原始 {event:{...}} 包裹形态。
 * @returns {null | {chatId, userId, userName, msgId, chatType, mentions: Array<{key:string, openId:string, name:string}>, kind: 'text'|'image'|'file', text?, imageKey?, fileKey?, fileName?}}
 */
export function parseReceiveEvent(data) {
  try {
    const ev = data?.event ?? data ?? {}
    const msg = ev?.message
    if (!msg) return null
    const sender = ev?.sender?.sender_id ?? {}
    const mentions = (Array.isArray(msg.mentions) ? msg.mentions : []).map(item => ({
      key: String(item?.key ?? ''),
      openId: String(item?.id?.open_id ?? ''),
      name: String(item?.name ?? ''),
    }))
    const base = {
      chatId: String(msg.chat_id ?? ''),
      userId: String(sender.open_id ?? sender.user_id ?? ''),
      userName: String(ev?.sender?.sender_type === 'app' ? '机器人' : (sender.open_id ?? '')),
      msgId: String(msg.message_id ?? ''),
      chatType: msg.chat_type === 'p2p' ? 'private' : 'group',
      mentions,
    }
    if (msg.message_type === 'text') {
      let text = ''
      try {
        text = (JSON.parse(msg.content ?? '{}').text ?? '').trim()
      } catch {
        return null
      }
      if (!text) return null
      return { ...base, kind: 'text', text }
    }
    if (msg.message_type === 'post') {
      try {
        const parsed = JSON.parse(msg.content ?? '{}')
        const body = parsed.zh_cn ?? parsed.en_us ?? parsed.ja_jp ?? parsed
        const parts = []
        if (typeof body.title === 'string' && body.title.trim()) parts.push(body.title.trim())
        for (const row of Array.isArray(body.content) ? body.content : []) {
          const line = (Array.isArray(row) ? row : [])
            .map(item => typeof item?.text === 'string' ? item.text : (item?.tag === 'at' ? item.user_name ?? '' : ''))
            .join('').trim()
          if (line) parts.push(line)
        }
        const text = parts.join('\n').trim()
        if (text) return { ...base, kind: 'text', text }
      } catch {
        // 解析失败按不支持处理
      }
      return null
    }
    if (msg.message_type === 'image') {
      try {
        const key = JSON.parse(msg.content ?? '{}').image_key ?? ''
        if (key) return { ...base, kind: 'image', imageKey: key }
      } catch {
        // 解析失败按不支持处理
      }
      return null
    }
    if (msg.message_type === 'file') {
      try {
        const c = JSON.parse(msg.content ?? '{}')
        const key = c.file_key ?? ''
        if (key) return { ...base, kind: 'file', fileKey: key, fileName: c.file_name ?? '' }
      } catch {
        // 解析失败按不支持处理
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

/** 群消息必须明确 @ 当前机器人；身份未知时安全地不响应。 */
export function isMessageForBot(msg, botOpenId) {
  if (msg?.chatType !== 'group') return true
  return Boolean(botOpenId && msg.mentions?.some(item => item.openId === botOpenId))
}

/** 读取当前应用机器人的 open_id，用于区分 @机器人 与 @其他成员。 */
export async function getBotIdentity(apiClient) {
  const res = await apiClient.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
  const bot = res?.bot
  if (!bot?.open_id) throw new Error('飞书未返回机器人身份')
  return { openId: String(bot.open_id), name: String(bot.app_name ?? '') }
}

/**
 * 下载消息资源（图片/文件）到本地路径。
 * 前置：应用需开通 im:resource（获取消息中的资源文件）权限；仅支持 100MB 以内。
 * @param {object} apiClient 飞书 API 客户端
 * @param {string} messageId 消息 id
 * @param {string} fileKey image_key / file_key
 * @param {'image'|'file'} type 资源类型
 * @param {string} destPath 保存路径
 * @returns {Promise<string>}
 */
export async function downloadResource(apiClient, messageId, fileKey, type, destPath) {
  const res = await apiClient.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  })
  await res.writeFile(destPath)
  return destPath
}

/**
 * 启动飞书长连接。
 * @param {object} opts { appId, appSecret, onMessage, log }
 * @returns {null | object} 客户端句柄（凭据缺失返回 null）
 */
export function startFeishu(opts) {
  const { appId, appSecret, onMessage, log } = opts
  if (!appId || !appSecret) {
    log('feishu: FEISHU_APP_ID / FEISHU_APP_SECRET 未配置 —— 飞书通道未启动（服务其余功能正常）')
    return null
  }
  const eventDispatcher = new lark.EventDispatcher({})
    .register({
      'card.action.trigger': (data) => {
        const ev = data?.event ?? data
        const value = ev?.action?.value
        if (value?.kind !== 'project_route' || !opts.onCardAction) return {}
        if (typeof value.nonce !== 'string' || !value.nonce || typeof value.projectId !== 'string') return { toast: { type: 'error', content: '无效的项目选择。' } }
        const userId = ev?.operator?.open_id, chatId = ev?.context?.open_chat_id
        if (!userId || !chatId || ((data?.header?.app_id || data?.app_id) && (data?.header?.app_id || data?.app_id) !== appId)) return { toast: { type: 'error', content: '无法确认操作身份。' } }
        void Promise.resolve(opts.onCardAction({ platform: 'feishu', userId, chatId }, value)).catch(() => log('项目确认处理失败，请重新发送原问题。'))
        return { toast: { type: 'info', content: '已收到选择，正在核对项目权限。' } }
      },
      'im.message.receive_v1': (data) => {
        log('飞书事件到达: im.message.receive_v1')
        const msg = parseReceiveEvent(data)
        if (msg) {
          Promise.resolve(onMessage(msg)).catch(() => log('飞书消息处理失败，请查看任务状态或服务诊断。'))
        } else {
          log('事件解析为空（非文本消息或结构异常）: ' + JSON.stringify(data).slice(0, 300))
        }
        return Promise.resolve()
      },
    })
  const client = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel?.info ?? 'info',
  })
  client.start({ eventDispatcher })
  log('feishu: 长连接启动中（appId ' + appId.slice(0, 12) + '…）')
  return client
}

/** 向聊天发送排版卡片（自动按组件分片）。 */
export async function sendToChat(apiClient, chatId, text, options = {}) {
  const cards = options.card ? [options.card] : buildReplyCards(text)
  for (const [i, card] of cards.entries()) {
    const payload = {
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
        ...(options.uuid ? { uuid: createHash('sha256').update(options.uuid + ':' + i).digest('hex').slice(0,32) } : {}),
      },
    }
    try { checkResponse(await apiClient.im.message.create(payload)) }
    catch(e) {
      const code = e.response?.data?.code ?? e.code
      if (code !== 230099 || !card.body.elements.some(x=>['table','chart'].includes(x.tag))) throw e
      payload.data.content = JSON.stringify(basicReplyCard(card))
      checkResponse(await apiClient.im.message.create(payload))
    }
  }
}

export async function sendFileToChat(apiClient, chatId, artifact, options = {}) {
  const upload = checkResponse(await apiClient.im.file.create({ data: { file_type: 'stream', file_name: artifact.name, file: createReadStream(artifact.file) } }))
  const fileKey = upload?.data?.file_key ?? upload?.file_key
  if (!fileKey) throw new Error('飞书文件上传未返回文件编号')
  checkResponse(await apiClient.im.message.create({ params: { receive_id_type: 'chat_id' }, data: {
    receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }),
    ...(options.uuid ? { uuid: createHash('sha256').update(options.uuid).digest('hex').slice(0,32) } : {}),
  } }))
}

/** 向用户（open_id）私聊发送文本（告警用）。 */
export async function sendToUser(apiClient, openId, text) {
  const { splitLongText } = await import('./llm.js')
  const chunks = splitLongText(text)
  for (const chunk of chunks) {
    await apiClient.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      },
    })
  }
}

/** 创建用于发送的 API 客户端（长连接客户端与发送客户端分离，职责清晰）。 */
export function createApiClient(appId, appSecret) {
  return new lark.Client({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel?.error ?? 'error',
  })
}
