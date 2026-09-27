import { Client } from 'pg'
import { mkdir,writeFile,readFile,cp } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { loadEnvFile,loadRuntimeConfig } from '../src/config.js'
loadEnvFile('.env');const cfg=loadRuntimeConfig()
const dir=resolve('data/backups/enterprise-'+new Date().toISOString().replace(/[:.]/g,'-'))
const db=new Client({connectionString:cfg.database.url,connectionTimeoutMillis:10000,statement_timeout:120000})
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
try{
  await db.connect()
  const owner=(await db.query(`SELECT id,display_name FROM requirement_assistant.users WHERE app_id=$1 AND external_user_id=$2`,[cfg.feishu.appId,'ou_9eb7cd9d78b2bdb1d0e06c22c8bc11c1'])).rows[0]
  if(owner?.display_name!=='汪晓东')throw new Error('汪晓东身份核验失败，未执行迁移')
  await mkdir(dir,{recursive:true})
  await cp(cfg.dataDir,join(dir,'runtime'),{recursive:true,errorOnExist:true,force:false})
  await cp('config.json',join(dir,'config.json'))
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='requirement_assistant' ORDER BY tablename")).rows
  const manifest={tables:{},ownerId:owner.id}
  for(const {tablename} of tables){
    if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected table')
    const rows=(await db.query('SELECT * FROM requirement_assistant."'+tablename+'"')).rows
    await writeFile(join(dir,tablename+'.json'),JSON.stringify(rows),{flag:'wx',mode:0o600})
    manifest.tables[tablename]={count:rows.length,sha256:digest(rows)}
  }
  await db.query('COMMIT')
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest,null,2))
  await db.query(await readFile('docs/db/postgresql-v5.sql','utf8'))
  await db.query('BEGIN')
  await db.query('LOCK TABLE requirement_assistant.users,requirement_assistant.messages,requirement_assistant.conversations,requirement_assistant.attachments,requirement_assistant.tasks IN SHARE MODE')
  const protectedRows=async()=>{
    const result={}
    for(const table of ['messages','conversations','attachments','tasks'])result[table]=(await db.query(`SELECT * FROM requirement_assistant.${table} WHERE user_id=$1 ORDER BY id`,[owner.id])).rows
    return result
  }
  const before=await protectedRows()
  await db.query(`INSERT INTO requirement_assistant.enterprises(id,name) VALUES('huaxi-hospital','华西医院') ON CONFLICT(id) DO NOTHING`)
  const bound=(await db.query('SELECT enterprise_id FROM requirement_assistant.enterprise_apps WHERE app_id=$1',[cfg.feishu.appId])).rows[0]
  if(bound&&bound.enterprise_id!=='huaxi-hospital')throw new Error('App 已绑定其他企业')
  await db.query(`INSERT INTO requirement_assistant.enterprise_apps(app_id,enterprise_id) VALUES($1,'huaxi-hospital') ON CONFLICT DO NOTHING`,[cfg.feishu.appId])
  const update=await db.query(`UPDATE requirement_assistant.projects SET enterprise_id='huaxi-hospital',name='DACCA',description='华西医院 · 汪晓东团队' WHERE id='pdaccaf9b1c' AND (enterprise_id IS NULL OR enterprise_id='huaxi-hospital')`)
  if(update.rowCount!==1)throw new Error('原 DACCA 项目核验失败')
  await db.query(`INSERT INTO requirement_assistant.project_members(project_id,user_id) VALUES('pdaccaf9b1c',$1) ON CONFLICT DO NOTHING`,[owner.id])
  await db.query(`INSERT INTO requirement_assistant.project_legacy_conversations(conversation_id,project_id) SELECT id,'pdaccaf9b1c' FROM requirement_assistant.conversations WHERE user_id=$1 AND project_id='' ON CONFLICT DO NOTHING`,[owner.id])
  const after=await protectedRows()
  if(digest(before)!==digest(after))throw new Error('历史数据校验不一致，回滚')
  const verification={backup:dir,owner:'汪晓东',enterprise:'华西医院',project:'DACCA',projectId:'pdaccaf9b1c',counts:Object.fromEntries(Object.entries(after).map(([k,v])=>[k,v.length])),beforeHash:digest(before),afterHash:digest(after)}
  await db.query(`INSERT INTO requirement_assistant.enterprise_audit(action,payload) VALUES('migration',$1)`,[JSON.stringify(verification)])
  await db.query('COMMIT')
  await writeFile(join(dir,'verification.json'),JSON.stringify(verification,null,2))
  console.log(JSON.stringify(verification,null,2))
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1}finally{await db.end()}
