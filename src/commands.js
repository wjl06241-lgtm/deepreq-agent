// 斜杠命令解析（不包含执行逻辑，执行在 server.js）

/**
 * 解析命令文本。
 * @returns {null | {name: string, args: string[]}}
 */
export function parseCommand(text) {
  const t = String(text ?? '').trim()
  if (!t.startsWith('/')) return null
  const m = /^\/([A-Za-z0-9_-]+)\s*(.*)$/s.exec(t)
  if (!m) return null
  const name = m[1].toLowerCase()
  const rest = (m[2] ?? '').trim()
  return { name, args: rest ? rest.split(/\s+/).filter(Boolean) : [] }
}

/** 帮助文本。 */
export function helpText() {
  return [
    '📋 **需求助手 · 命令**',
    '',
    '项目由后台统一创建和分配；没有项目可直接普通聊天。',
    '/project leave        返回普通聊天（也可发送“返回普通聊天”）',
    '/project use <名称|id>  切换项目（原项目对话保留，切回可继续）',
    '/project list          列出全部项目（* = 当前）',
    '/project current       查看当前项目与所用模型',
    '/new                   清空当前项目对话，重新开始',
    '/prompt view           查看当前系统提示词（前 300 字）',
    '/prompt set <文本>     修改系统提示词（写 config.json，即时生效）',
    '/status                连接与会话状态',
    '/whoami                查看自己的用户ID及姓名获取状态',
    '/task status           查看当前项目任务',
    '/task resend [任务号]   补发未送达结果（不重新执行）',
    '/cancel [任务号]        取消自己的任务',
    '/help                  本帮助',
    '',
    '直接发消息即可对话；每条提问与回答都会记录入库，超时未回答会告警。',
  ].join('\n')
}
