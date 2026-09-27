import { spawn } from 'node:child_process'
import { open, mkdir, readFile, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { loadEnvFile } from '../src/config.js'
import { supervisorDirectory } from '../src/app-instances.js'

const root = join(import.meta.dirname,'..')
loadEnvFile(join(root,'.env'))
const dir = supervisorDirectory(root)
await mkdir(dir,{recursive:true})
const lock = join(dir,'supervisor.pid'), stopFile = join(dir,'stop')
try {
  const old = Number(await readFile(lock,'utf8'))
  try { process.kill(old,0); console.log('后台服务已经运行'); process.exit(0) } catch (e) { if (e.code !== 'ESRCH') throw e }
  await unlink(lock)
} catch(e) { if(e.code !== 'ENOENT') throw e }
const handle = await open(lock,'wx'); await handle.writeFile(String(process.pid)); await handle.close()
await unlink(stopFile).catch(e=>{if(e.code!=='ENOENT')throw e})
let stopping=false, child
const shutdown = () => { stopping=true; if(child?.connected) child.send({ type: 'shutdown' }); else child?.kill() }
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown)
const timer=setInterval(async()=>{if(await stat(stopFile).catch(()=>null))shutdown()},1000)
try {
  while(!stopping) {
    const stamp=new Date().toISOString().slice(0,10)
    const log=await open(join(dir,'service-'+stamp+'.log'),'a')
    child=spawn(process.execPath,[join(root,'scripts','start.mjs')],{
      cwd:root,windowsHide:true,stdio:['ignore',log.fd,log.fd,'ipc'],
      env:{...process.env,SERVICE_LOG_DIR:dir},
    })
    await new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve)})
    await log.close()
    if(!stopping)await new Promise(resolve=>setTimeout(resolve,5000))
  }
} finally {clearInterval(timer);await unlink(lock).catch(()=>{})}
