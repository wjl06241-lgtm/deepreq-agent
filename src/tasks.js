import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AtomicState } from './state.js'

export class TaskStore extends AtomicState {
  constructor(dir) { super(join(dir, 'tasks.json'), { version: 1, tasks: {}, inbound: {} }); this.claimTail = Promise.resolve() }
  async init() {
    await super.init()
    for (const task of Object.values(this.data.tasks)) {
      if (['queued', 'running'].includes(task.status)) {
        task.status = 'interrupted'; task.error = '服务重启，执行状态需要核对；未自动重跑。'; task.updatedAt = Date.now()
      }
    }
    await this.save(); return this
  }
  claim(msg, project) {
    const job = this.claimTail.then(async () => {
      const key = msg.msgId ? JSON.stringify([msg.platform ?? 'feishu', msg.chatId, msg.msgId]) : null
      if (key && this.data.inbound[key]) return null
      const task = { id: randomUUID(), msgId: msg.msgId, platform: msg.platform ?? 'feishu', chatId: msg.chatId,
        userId: msg.userId ?? '', userName: msg.userName ?? '', project: project ?? '', text: msg.text ?? '[附件]', status: 'queued',
        delivery: 'pending', presentationVersion: 2, createdAt: Date.now(), updatedAt: Date.now(), chunksSent: 0 }
      this.data.tasks[task.id] = task
      if (key) this.data.inbound[key] = task.id
      await this.save(); return task
    })
    this.claimTail = job.catch(() => {}); return job
  }
  async update(id, patch) { const task = this.data.tasks[id]; Object.assign(task, patch, { updatedAt: Date.now() }); await this.save(); await this.onChange?.(task); return task }
  list(chatId, project) { return Object.values(this.data.tasks).filter(t => (!chatId || t.chatId === chatId) && (project === undefined || t.project === project)).sort((a,b) => b.createdAt-a.createdAt) }
  get(id) { return this.data.tasks[id] }
}
