// Records the private DACCA package without assigning it by display name.
import { Client } from 'pg'
import { readdir, readFile, stat, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/config.js'

const root=fileURLToPath(new URL('../dacca-项目资料/',import.meta.url))
loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)))
const files=[]
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
  if(e.isSymbolicLink()||e.name.startsWith('.'))continue
  const path=join(dir,e.name);if(e.isDirectory())await walk(path);else if(e.isFile()){
    const body=await readFile(path),s=await stat(path)
    files.push({path:relative(root,path).replaceAll('\\','/'),size:s.size,sha256:createHash('sha256').update(body).digest('hex')})
  }
}}
await walk(await realpath(root));files.sort((a,b)=>a.path.localeCompare(b.path,'zh-CN'))
const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:15000})
try{await c.connect();await c.query('BEGIN')
  await c.query(`INSERT INTO requirement_assistant.projects(id,name) VALUES('pdaccaf9b1c','dacca') ON CONFLICT(id) DO UPDATE SET name=excluded.name`)
  await c.query(`INSERT INTO requirement_assistant.user_packages
    (id,expected_owner_name,project_id,source_key,local_materials_path,prompt_relative_path,materials_manifest)
    VALUES('wang-xiaodong-dacca','汪晓东','pdaccaf9b1c','hermes_carter:maxiao',$1,$2,$3::jsonb)
    ON CONFLICT(id) DO UPDATE SET expected_owner_name=excluded.expected_owner_name,
      local_materials_path=excluded.local_materials_path,prompt_relative_path=excluded.prompt_relative_path,
      materials_manifest=excluded.materials_manifest`,[root,'角色提示词/DACCA_战略顾问_最终版提示词_v4.md',JSON.stringify(files)])
  await c.query('COMMIT');console.log(JSON.stringify({package:'wang-xiaodong-dacca',owner:'汪晓东',status:'pending_identity',files:files.length,bytes:files.reduce((n,f)=>n+f.size,0)}))
}catch(e){await c.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({errorCode:e.code||'STAGING_FAILED'}));process.exitCode=1}finally{await c.end().catch(()=>{})}
