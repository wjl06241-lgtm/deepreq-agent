// Switch credentials only after the current local supervisor has stopped.
// Keeps all old test data intact; the original app gets its own runtime directory.
import { readFile, writeFile, mkdir, copyFile, access, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile, loadRuntimeConfig } from '../src/config.js'
const root=fileURLToPath(new URL('../',import.meta.url))
const envFile=join(root,'.env')
loadEnvFile(envFile)
const previous=loadRuntimeConfig()
const supplied=JSON.parse(await readFile(join(root,'data','legacy-feishu.json'),'utf8'))
if(supplied.appId!=='cli_aaacd41b28f9dbfd'||!supplied.appSecret)throw new Error('Original app credential missing')
try { await access(join(previous.dataDir,'service','supervisor.pid')); throw new Error('Stop the running supervisor before switching') }
catch(e){if(e.code!=='ENOENT')throw e}
if(previous.feishu.appId!==supplied.appId){
  const pending=JSON.parse(await readFile(join(previous.dataDir,'postgres-outbox.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return '{"operations":[]}';throw e}))
  if(pending.operations.length)throw new Error('Flush the old application outbox before switching')
}
const nextDir=join(root,'data','apps',supplied.appId)
await mkdir(nextDir,{recursive:true})
const projectsFile=join(nextDir,'projects.json')
try{await access(projectsFile)}catch(e){
  if(e.code!=='ENOENT')throw e
  const registry=JSON.parse(await readFile(join(previous.dataDir,'projects.json'),'utf8'))
  await writeFile(projectsFile,JSON.stringify({...registry,active:{}},null,2),'utf8')
}
const backupDir=join(root,'data','backups');await mkdir(backupDir,{recursive:true})
const backup=join(backupDir,'before-original-app.env')
try{await copyFile(envFile,backup,1)}catch(e){if(e.code!=='EEXIST')throw e}
let env=await readFile(envFile,'utf8')
for(const [key,value] of Object.entries({FEISHU_APP_ID:supplied.appId,FEISHU_APP_SECRET:supplied.appSecret,DATA_DIR:nextDir})){
  const re=new RegExp('^'+key+'=.*$','gm')
  env=re.test(env)?env.replace(re,()=>key+'='+value):env.trimEnd()+'\n'+key+'='+value+'\n'
}
await writeFile(envFile+'.tmp',env,'utf8');await rename(envFile+'.tmp',envFile)
console.log(JSON.stringify({configured:true,appId:supplied.appId,isolatedData:true,backupCreated:true}))
