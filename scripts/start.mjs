import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { loadEnvFile } from '../src/config.js'
import { instanceEnvironment, loadFeishuAppInstances } from '../src/app-instances.js'

const root = join(import.meta.dirname, '..')
loadEnvFile(join(root, '.env'))
const loaded = loadFeishuAppInstances(root)
const children = new Map()
let stopping = false
let finish
const done = new Promise(resolve => { finish = resolve })

const label = instance => `${instance.name} (${instance.appId.slice(0, 12)}…)`
console.log(`[多 App 启动器] ${loaded.mode === 'multi' ? '多应用' : '兼容单应用'}模式，共 ${loaded.instances.length} 个实例`)

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  for (const child of children.keys()) {
    if (child.connected) child.send({ type: 'shutdown' })
    else child.kill()
  }
  const timer = setTimeout(() => {
    for (const child of children.keys()) child.kill()
  }, 15000)
  timer.unref()
  if (children.size === 0) finish()
}

for (const instance of loaded.instances) {
  const child = spawn(process.execPath, [join(root, 'src', 'server.js')], {
    cwd: root,
    windowsHide: true,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: instanceEnvironment(instance),
  })
  children.set(child, instance)
  console.log(`[多 App 启动器] 已启动 ${label(instance)}，看板端口 ${instance.adminPort}`)
  child.once('error', error => {
    console.error(`[多 App 启动器] ${label(instance)} 启动失败：${error.message}`)
  })
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!stopping) {
      console.error(`[多 App 启动器] ${label(instance)} 意外退出（${signal || code || 0}）`)
      stop(code || 1)
    } else if (children.size === 0) finish()
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
process.on('message', message => { if (message?.type === 'shutdown') stop(0) })
await done
if (process.connected) process.disconnect()
