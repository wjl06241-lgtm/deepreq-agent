// 飞书机器人：长连接收事件（免公网）+ 消息发送

import * as lark from '@larksuiteoapi/node-sdk'

/**
 * 解析 im.message.receive_v1 事件为统一入站消息（支持文本/图片/文件）。
 * 注意：node-sdk 长连接模式的 EventDispatcher 会把事件的 event 字段解包提升到顶层
 * （RequestHandle.parse 的 ...event），因此优先读顶层 message/sender，
 * 同时兼容原始 {event:{...}} 包裹形态。
 * @returns {null | {chatId, userId, userName, msgId, chatType, kind: 'text'|'image'|'file', text?, imageKey?, fileKey?, fileName?}}
 */
export function parseReceiveEvent(data) {
  try {
    const ev = data?.event ?? data ?? {}
    const msg = ev?.message
    if (!msg) return null
    const sender = ev?.sender?.sender_id ?? {}
    const base = {
      chatId: String(msg.chat_id ?? ''),
      userId: String(sender.open_id ?? sender.user_id ?? ''),
      userName: String(ev?.sender?.sender_type === 'app' ? '机器人' : (sender.open_id ?? '')),
      msgId: String(msg.message_id ?? ''),
      chatType: msg.chat_type === 'p2p' ? 'private' : 'group',
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
      'im.message.receive_v1': (data) => {
        log('飞书事件到达: im.message.receive_v1')
        const msg = parseReceiveEvent(data)
        if (msg) {
          onMessage(msg)
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

/** 向聊天发送文本（自动分片）。 */
export async function sendToChat(apiClient, chatId, text) {
  const { splitLongText } = await import('./llm.js')
  const chunks = splitLongText(text)
  for (const chunk of chunks) {
    await apiClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      },
    })
  }
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
