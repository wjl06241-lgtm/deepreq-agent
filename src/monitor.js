// 未回答检测：用户消息（非命令）在 timeoutSec 内无助手回复 → 未回答，落记录并告警。

import { newRecordId } from './store.js'

export const COMMAND_RE = /^\s*\//

/**
 * 计算当前未回答清单（只读）。
 * @param {object} store JsonlStore
 * @param {number} timeoutSec 判定超时（秒）
 * @returns {Promise<Array<{qid, chatId, userId, project, text, ts, ageSec, alertedAt}>>}
 */
export async function openQuestions(store, timeoutSec, tasks) {
  const now = Date.now()
  const windowStart = now - Math.max(timeoutSec * 4 * 1000, 6 * 3600 * 1000)
  const records = await store.readRange(windowStart, now)
  const userMessages = records.filter(r =>
    r.kind === 'user_message' && !COMMAND_RE.test(r.text ?? ''))
  const state = store.getState()
  const open = []
  for (const u of userMessages) {
    if (state.resolved[u.id]) continue
    const task = u.taskId && tasks?.get(u.taskId)
    if (task && (task.status === 'cancelled' || (['queued','running'].includes(task.status) && now - (task.heartbeatAt || task.updatedAt) < timeoutSec * 1000))) continue
    const ageSec = (now - u.ts) / 1000
    if (ageSec < timeoutSec) continue
    const answered = isAnswered(u, records)
    if (!answered) {
      open.push({
        qid: u.id, chatId: u.chatId, userId: u.userId ?? '', userName: u.userName ?? '',
        project: u.project ?? '', text: u.text, ts: u.ts, ageSec: Math.round(ageSec),
        alertedAt: state.alerted[u.id] ?? null,
      })
    }
  }
  open.sort((a, b) => a.ts - b.ts)
  return open
}

/**
 * 扫描：新发现的未回答问题 → 写 unanswered 记录 + 触发告警回调（一次一条，限流由回调方做）。
 */
export async function scanUnanswered(store, timeoutSec, onNewUnanswered, tasks) {
  const open = await openQuestions(store, timeoutSec, tasks)
  const state = store.getState()
  let changed = false
  for (const q of open) {
    if (state.alerted[q.qid]) continue
    await store.append({
      v: 1, id: newRecordId(), ts: Date.now(), kind: 'unanswered',
      chatId: q.chatId, userId: q.userId ?? '', userName: q.userName ?? '',
      project: q.project, refId: q.qid, text: q.text,
    })
    state.alerted[q.qid] = Date.now()
    changed = true
    await onNewUnanswered(q)
  }
  if (changed) await store.saveState()
  return open
}

/** 运营标记已处理。 */
export async function resolveQuestion(store, qid, note = '') {
  const state = store.getState()
  state.resolved[qid] = Date.now()
  await store.append({
    v: 1, id: newRecordId(), ts: Date.now(), kind: 'ops_note',
    refId: qid, action: 'resolved', note: String(note ?? '').slice(0, 500),
  })
  await store.saveState()
}

/** 记录是否已回答（同聊天同项目内其后存在助手回复或错误回复）。 */
export function isAnswered(userRecord, records) {
  return records.some(r =>
    r.chatId === userRecord.chatId && (r.project ?? '') === (userRecord.project ?? '') && r.ts >= userRecord.ts
    && (!userRecord.userId || r.userId === userRecord.userId)
    && (!userRecord.platform || (r.platform ?? 'feishu') === userRecord.platform)
    && (!userRecord.taskId || (r.refId === userRecord.id && r.taskId === userRecord.taskId))
    && (r.kind === 'assistant_message' || r.kind === 'error'))
}
