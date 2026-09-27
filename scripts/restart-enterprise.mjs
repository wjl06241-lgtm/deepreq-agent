import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { loadEnvFile,loadRuntimeConfig } from '../src/config.js'
import { supervisorDirectory,loadFeishuAppInstances } from '../src/app-instances.js'
const root=join(import.meta.dirname,'..');loadEnvFile(join(root,'.env'));const cfg=loadRuntimeConfig()
for(const instance of loadFeishuAppInstances(root).instances){
  const raw=await readFile(join(instance.dataDir,'tasks.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return '{"tasks":{}}';throw e})
  if(Object.values(JSON.parse(raw).tasks).some(t=>['queued','running'].includes(t.status)))throw new Error(instance.name+'仍有任务运行，暂不重启')
}
const dirs=[...new Set([join(cfg.dataDir,'service'),supervisorDirectory(root)])]
for(const dir of dirs){
  const raw=await readFile(join(dir,'supervisor.pid'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e})
  if(!raw)continue
  const pid=Number(raw);if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Invalid supervisor pid')
  const alive=()=>{try{process.kill(pid,0);return true}catch(e){if(e.code==='ESRCH')return false;throw e}}
  if(!alive())continue
  await writeFile(join(dir,'stop'),'stop')
  for(let i=0;i<40&&alive();i++)await delay(500)
  if(alive())throw new Error('旧服务未退出，停止部署')
}
await mkdir(supervisorDirectory(root),{recursive:true})
const child=spawn(process.execPath,[join(root,'scripts','background.mjs')],{cwd:root,windowsHide:true,detached:true,stdio:'ignore'})
child.unref()
let ready=false
for(let i=0;i<40;i++){
  try{const r=await fetch('http://127.0.0.1:'+cfg.adminPort+'/',{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break}}catch{}
  await delay(500)
}
if(!ready)throw new Error('启动后看板未就绪，请检查服务日志')
console.log('新后台已启动并就绪，PID '+child.pid)
