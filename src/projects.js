// 项目注册表：data/projects.json
// 结构：{ version:1, active: { "<chatId>": projectId }, projects: { <id>: { id, name, createdAt } } }
// 模型/提示词覆盖在 config.json（projects.<id>），此处只管项目与当前激活关系。

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const VERSION = 1

export class ProjectRegistry {
  constructor(file) {
    this.file = file
    this.data = { version: VERSION, active: {}, projects: {} }
    this._saveTimer = null
    this._saving = null
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (parsed.version !== VERSION) return
      this.data = {
        version: VERSION,
        active: parsed.active ?? {},
        projects: parsed.projects ?? {},
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.error('[projects] load failed (starting fresh):', err.message)
      }
    }
  }

  activeFor(chatId) {
    const id = this.data.active[chatId]
    return id ? this.get(id) : null
  }

  setActive(chatId, projectId) {
    if (projectId !== null && projectId !== undefined) this.data.active[chatId] = projectId
    else delete this.data.active[chatId]
    this._scheduleSave()
  }

  selectionFor(chatId) { return this.data.active[chatId] }

  create(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name)) {
      throw new Error('项目名应为1到60个字符，不能包含路径分隔符或特殊文件名字符。')
    }
    const id = 'p' + createHash('sha1').update(String(name) + ':' + Date.now()).digest('hex').slice(0, 10)
    const project = { id, name: String(name).slice(0, 60), createdAt: Date.now() }
    this.data.projects[id] = project
    this._scheduleSave()
    return project
  }

  get(id) {
    return (this.catalog ?? this.data.projects)[id] ?? null
  }

  find(query) {
    const q = String(query ?? '').trim()
    if (!q) return null
    if (this.get(q)) return this.get(q)
    for (const p of this.list()) {
      if (p.name === q) return p
    }
    return null
  }

  list() {
    return Object.values(this.catalog ?? this.data.projects).sort((a, b) => a.createdAt - b.createdAt)
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      void this.save()
    }, 300)
  }

  async save() {
    if (this._saving) return this._saving
    this._saving = (async () => {
      await mkdir(join(this.file, '..'), { recursive: true })
      const tmp = this.file + '.tmp'
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      await rename(tmp, this.file)
    })().finally(() => {
      this._saving = null
    })
    return this._saving
  }

  async dispose() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    await this.save()
  }
}
