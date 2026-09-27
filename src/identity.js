// Display names can change or collide. Never use them as identity keys.
// v2 deliberately does not load legacy group-shared memory or Codex threads.
export function actorKey(msg) {
  if (!msg.userId || !msg.chatId) throw new Error('无法确认消息发送者或聊天身份，未创建会话。')
  return JSON.stringify(['user-v2', msg.platform ?? 'feishu', msg.chatId, msg.userId])
}

export function sessionKey(msg) {
  return JSON.stringify([actorKey(msg), msg.projectId ?? ''])
}

export function ownsTask(msg, task) {
  return Boolean(msg.userId) && task.userId === msg.userId && task.chatId === msg.chatId
    && task.platform === (msg.platform ?? 'feishu')
}
