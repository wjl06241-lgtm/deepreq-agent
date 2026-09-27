import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export async function replaceStateFile(source, target, move = rename, wait = delay) {
  for (let attempt = 0; ; attempt++) {
    try { await move(source, target); return }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 8) throw e
      await wait(Math.min(50 * 2 ** attempt, 500))
    }
  }
}

// One serialized atomic writer per state file. Corruption fails closed.
export class AtomicState {
  constructor(file, initial) { this.file = file; this.data = initial; this.tail = Promise.resolve() }
  async init() {
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    return this
  }
  save() {
    const snapshot = JSON.stringify(this.data, null, 2)
    const job = this.tail.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = this.file + '.' + process.pid + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temp, snapshot, { encoding: 'utf8', flag: 'wx' })
        await replaceStateFile(temp, this.file)
      } finally { await unlink(temp).catch(() => {}) }
    })
    this.tail = job.catch(() => {})
    return job
  }
}
