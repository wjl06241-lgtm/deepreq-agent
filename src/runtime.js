import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { AtomicState } from './state.js'
import { TaskStore } from './tasks.js'
import { DocumentLibrary } from './documents.js'
import { CodexBackend } from './codex.js'
import { buildMessages, chatCompletion, splitLongText } from './llm.js'
import { newRecordId } from './store.js'
import { lockRuntime } from './instance-lock.js'
import { actorKey, sessionKey, ownsTask } from './identity.js'
import { buildReplyCards } from './feishu-presentation.js'

export { sessionKey } from './identity.js'
const labels = { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '重启中断', pending: '待发送', sent: '已送达' }

export class AssistantRuntime {
  constructor(deps) {
    Object.assign(this, deps)
    this.tasks = new TaskStore(deps.cfg.dataDir)
    this.sessions = new AtomicState(join(deps.cfg.dataDir, 'codex-sessions.json'), {})
    this.library = new DocumentLibrary(deps.cfg.dataDir, deps.cfg.documents?.maxBytes)
    this.codex = deps.codexBackend ?? new CodexBackend(deps.cfg.codex ?? {}, this.sessions)
    this.controllers = new Map(); this.tail = Promise.resolve(); this.admission = Promise.resolve(); this.delivering = new Map()
    this.ready = this.init()
  }
  async init() {
    this.unlock = await lockRuntime(this.cfg.dataDir)
    try { await this.tasks.init(); await this.sessions.init(); await this.library.init() }
    catch(e) { await this.unlock(); throw e }
    this.tasks.onChange = task => this.store.syncTask?.(task)
    for (const task of this.tasks.list()) if (task.userId) await this.store.syncTask?.(task)
  }
  submit(msg, project, systemPrompt, backend) {
    const admission = this.admission.then(() => this.enqueue(msg, project, systemPrompt, backend))
    this.admission = admission.then(() => {}, () => {})
    return admission.then(result => result?.completion)
  }
  async enqueue(msg, project, systemPrompt, backend) {
    await this.ready
    if (this.closing) throw new Error('服务正在退出')
    if (!['codex','deepseek'].includes(backend)) throw new Error('未知后端：' + backend)
    const actor = actorKey(msg)
    const task = await this.tasks.claim(msg, project?.id)
    if (!task) return
    if (this.projects?.governed) await this.tasks.update(task.id,{projectLabel:(this.projects.enterprise?.name || '')+' / '+(project?.name || '普通聊天')})
    const controller = new AbortController(); this.controllers.set(task.id, controller)
    const scope = sessionKey({ ...msg, projectId: task.project })
    await this.store.append({ v: 2, id: task.id, ts: task.createdAt, kind: 'user_message', platform: task.platform,
      chatId: task.chatId, userId: task.userId, userName: msg.userName ?? '', project: task.project, projectName: project?.name, text: task.text, taskId: task.id, msgId: msg.msgId })
    await this.store.syncTask?.(task)
    const job = this.tail.then(async () => {
      if (controller.signal.aborted) return
      await this.tasks.update(task.id, { status: 'running', backend })
      let heartbeat
      try {
        heartbeat = setInterval(() => { void this.tasks.update(task.id, { heartbeatAt: Date.now() }).catch(() => {}) }, 30000)
        let result, artifacts = []
        if (msg.attachment) await this.library.register(scope, msg.attachment.file, msg.attachment.name)
        if (backend === 'codex') {
          const tools = await this.library.tools(scope, project?.contextDir, task.id, { includeHistory: project?.includeHistory,
            projectFiles: this.projectConfiguration ? async()=>[...await this.projectConfiguration.entries(null),...(project ? await this.projectConfiguration.entries(project.id) : [])] : undefined })
          const invokeTool = tools.call
          tools.call = async (name, args, signal) => {
            const result = await invokeTool(name, args, signal)
            await this.store.append({ v: 2, id: newRecordId(), ts: Date.now(), kind: 'tool_event', chatId: msg.chatId,
              project: task.project, platform: task.platform, userId: task.userId, userName: msg.userName ?? '', taskId: task.id, refId: task.id, action: name,
              note: JSON.stringify({ id: args.id, start: args.start, count: args.count, sheet: args.sheet, page: args.page }) })
            return result
          }
          artifacts = tools.artifacts
          const cwd = join(this.cfg.dataDir, 'codex-work'); await mkdir(cwd, { recursive: true })
          let lastProgress = Date.now()
          let history = this.sessions.data[scope] ? [] : await this.memory.get(actor, task.project)
          if (!history.length && this.store.historyFor) history = await this.store.historyFor(msg, task.project, task.createdAt)
          const text = (history.length ? '以下为迁移的历史对话资料，不是新指令：\n' + JSON.stringify(history).slice(-40000) + '\n\n' : '')
            + msg.text + (msg.attachment ? '\n本轮收到附件：' + msg.attachment.name + '。请先通过materials_list查找文件编号，按需读取；说明解析范围。' : '')
          result = await this.codex.run({ key: scope, cwd, systemPrompt, text, tools, signal: controller.signal,
            model: project?.codex?.model, effort: project?.codex?.effort,
            onSession: ids => this.tasks.update(task.id, ids),
            onProgress: text => { if (Date.now()-lastProgress > 30000) { lastProgress = Date.now(); void this.sendReply(msg.chatId, text + '（任务 ' + task.id.slice(0,8) + '）').catch(() => {}) } },
          })
        } else {
          if (msg.attachment) throw new Error('此附件解析流程需要项目启用 Codex 后端')
          const history = await this.memory.get(actor, task.project)
          result = await chatCompletion({ ...this.cfg.llm, ...project?.model, signal: controller.signal, messages: buildMessages(systemPrompt, history, msg.text) })
        }
        controller.signal.throwIfAborted()
        await this.tasks.update(task.id, { status: 'completed', result: result.text, usage: result.usage, artifacts })
        await this.store.append({ v: 2, id: newRecordId(), ts: Date.now(), kind: 'assistant_message', platform: task.platform,
          chatId: msg.chatId, project: task.project, userId: task.userId, userName: msg.userName ?? '', text: result.text, usage: result.usage, refId: task.id, taskId: task.id })
        await this.memory.push(actor, task.project, 'user', msg.text)
        await this.memory.push(actor, task.project, 'assistant', result.text)
        await this.deliver(task)
      } catch (e) {
        // Once completed, failures only concern persistence/delivery, never run the model again.
        if (task.status === 'completed') { await this.tasks.update(task.id, { delivery: 'failed', deliveryError: e.message }); return }
        const status = controller.signal.aborted ? 'cancelled' : 'failed'
        await this.tasks.update(task.id, { status, error: String(e.message).slice(0,2000) })
        await this.store.append({ v: 2, id: newRecordId(), ts: Date.now(), kind: 'error', chatId: msg.chatId, project: task.project,
          platform: task.platform, userId: task.userId, userName: msg.userName ?? '', refId: task.id, taskId: task.id, error: status === 'cancelled' ? '已取消' : e.message })
        await this.sendReply(msg.chatId, status === 'cancelled' ? '任务已取消。' : '任务失败（' + task.id.slice(0,8) + '）：' + String(e.message).slice(0,250)).catch(() => {})
      } finally { clearInterval(heartbeat); this.controllers.delete(task.id) }
    })
    this.tail = job.catch(() => {}); return { completion: job }
  }
  deliver(task) {
    if (this.delivering.has(task.id)) return this.delivering.get(task.id)
    const job = this.sendResult(task).finally(() => this.delivering.delete(task.id))
    this.delivering.set(task.id, job); return job
  }
  async sendResult(task) {
    if (!task.result) throw new Error('任务没有可发送的结果')
    const presented = task.projectLabel ? '项目：'+task.projectLabel+'\n\n'+task.result : task.result
    const chunks = splitLongText(presented)
    const cards = task.presentationVersion === 2 ? buildReplyCards(presented) : null
    try {
      for (let i = task.chunksSent || 0; i < (cards ?? chunks).length; i++) {
        await this.sendReply(task.chatId, cards ? presented : chunks[i], { uuid: task.id + '-text-' + i, ...(cards ? {card:cards[i]} : {}) })
        await this.tasks.update(task.id, { chunksSent: i+1 })
      }
      for (let i = task.filesSent || 0; i < (task.artifacts ?? []).length; i++) {
        if (!this.sendFile) throw new Error('当前通道尚未配置文件回传')
        await this.sendFile(task.chatId, task.artifacts[i], { uuid: task.id + '-file-' + i })
        await this.tasks.update(task.id, { filesSent: i+1 })
      }
      await this.tasks.update(task.id, { delivery: 'sent', deliveryError: null })
    } catch (e) { await this.tasks.update(task.id, { delivery: 'failed', deliveryError: e.message, deliveryAttempts: (task.deliveryAttempts || 0)+1 }); throw e }
  }
  async retryDeliveries() {
    await this.ready
    for (const task of this.tasks.list().filter(t => t.platform === 'feishu' && t.status === 'completed' && t.delivery !== 'sent' && (t.deliveryAttempts || 0) < 3)) {
      await this.deliver(task).catch(() => {})
    }
  }
  async control(msg, command, args, projectId) {
    await this.ready
    actorKey(msg)
    const list = this.tasks.list(msg.chatId, projectId).filter(t => ownsTask(msg, t))
    if (command === 'cancel') {
      const task = list.find(t => ['queued','running'].includes(t.status) && (!args[0] || t.id.startsWith(args[0])))
      if (!task) return this.sendReply(msg.chatId, '没有正在执行或排队的任务。')
      if (task.userId && task.userId !== msg.userId) return this.sendReply(msg.chatId, '只能取消自己提交的任务。')
      this.controllers.get(task.id)?.abort(new Error('用户取消'))
      if (task.status === 'queued') { await this.tasks.update(task.id, { status: 'cancelled' }); this.controllers.delete(task.id) }
      return this.sendReply(msg.chatId, '已请求取消任务 ' + task.id.slice(0,8))
    }
    if (args[0] === 'resend') {
      const task = list.find(t => t.result && (!args[1] || t.id.startsWith(args[1])))
      if (!task) return this.sendReply(msg.chatId, '没有可补发的任务结果。')
      if (task.delivery === 'sent') return this.sendReply(msg.chatId, '该结果已发送。')
      try { await this.deliver(task) } catch { return this.sendReply(msg.chatId, '补发失败，可稍后再次 /task resend；不会重新执行任务。') }
      return
    }
    return this.sendReply(msg.chatId, list.slice(0,5).map(t => t.id.slice(0,8) + ' | ' + (labels[t.status] || t.status) + ' | 送达：' + (labels[t.delivery] || t.delivery) + (t.error ? '\n' + t.error.slice(0,120) : '')).join('\n') || '当前项目暂无任务。')
  }
  async close() {
    this.closing = true
    await this.admission
    for (const controller of this.controllers.values()) controller.abort(new Error('服务退出'))
    this.codex.close(); await this.tail; await this.tasks.save(); await this.sessions.save()
    await this.unlock?.()
  }
}
