// Run only after the owner has contacted the bot and the displayed Open ID is confirmed.
import { Client } from 'pg'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/config.js'
import { databaseId } from '../src/store-postgres.js'

const openId=process.argv[2]
if(!/^ou_[A-Za-z0-9_-]{10,}$/.test(openId||''))throw new Error('用法：node scripts/bind-wang-xiaodong.mjs <已确认的飞书 open_id>')
const envFile=fileURLToPath(new URL('../.env',import.meta.url)),configFile=fileURLToPath(new URL('../config.json',import.meta.url))
loadEnvFile(envFile)
const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:30000,query_timeout:45000})
try{await c.connect();await c.query('BEGIN')
  const found=await c.query(`SELECT id,display_name FROM requirement_assistant.users
    WHERE platform='feishu' AND app_id=$1 AND external_user_id=$2 FOR UPDATE`,[process.env.FEISHU_APP_ID,openId])
  if(found.rowCount!==1)throw Object.assign(new Error('用户尚未给机器人发消息'),{code:'USER_NOT_FOUND'})
  if(found.rows[0].display_name!=='汪晓东')throw Object.assign(new Error('飞书姓名不匹配'),{code:'NAME_MISMATCH'})
  const uid=found.rows[0].id
  const pkg=await c.query(`SELECT * FROM requirement_assistant.user_packages WHERE id='wang-xiaodong-dacca' FOR UPDATE`)
  if(pkg.rowCount!==1)throw Object.assign(new Error('资料包不存在'),{code:'PACKAGE_NOT_FOUND'})
  if(pkg.rows[0].user_id && pkg.rows[0].user_id!==uid)throw Object.assign(new Error('资料包已绑定其他用户'),{code:'ALREADY_BOUND'})
  await c.query(`UPDATE requirement_assistant.user_packages SET user_id=$1,status='active',bound_at=coalesce(bound_at,now()) WHERE id='wang-xiaodong-dacca'`,[uid])
  await c.query(`UPDATE requirement_assistant.projects SET owner_user_id=$1 WHERE id='pdaccaf9b1c'`,[uid])
  await c.query(`UPDATE requirement_assistant.legacy_imports SET mapped_user_id=$1
    WHERE source_system='hermes_carter' AND source_table='public.messages' AND source_agent_id='maxiao'`,[uid])
  const legacy=(await c.query(`SELECT source_id,raw_record FROM requirement_assistant.legacy_imports
    WHERE source_system='hermes_carter' AND source_table='public.messages' AND source_agent_id='maxiao' ORDER BY source_id::bigint`)).rows
  if(legacy.length!==198)throw Object.assign(new Error('旧记录数量不符合预期'),{code:'LEGACY_COUNT_MISMATCH'})
  const convIds=new Map()
  for(const item of legacy){
    const r=item.raw_record,oldConv=String(r.conversation_id),cid=databaseId('legacy-conversation','hermes_carter','maxiao',oldConv)
    if(!convIds.has(oldConv)){
      const chatId=r._source_conversation?.chat_id||`legacy:hermes_carter:${oldConv}`
      await c.query(`INSERT INTO requirement_assistant.conversations(id,user_id,chat_id,project_id,agent_id,backend,title,status,created_at,updated_at)
        VALUES($1,$2,$3,'pdaccaf9b1c','requirement-assistant','codex',$4,'archived',$5,$6) ON CONFLICT(id) DO NOTHING`,
      [cid,uid,chatId,'DACCA 历史会话 '+oldConv,r._source_conversation?.created_at||r.created_at,r._source_conversation?.updated_at||r.created_at])
      convIds.set(oldConv,cid)
    }
    const mid=databaseId('legacy-message','hermes_carter','public.messages',item.source_id)
    const role=['user','assistant'].includes(r.role)?r.role:'system'
    await c.query(`INSERT INTO requirement_assistant.messages
      (id,conversation_id,user_id,role,content,external_message_id,status,metadata,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(id) DO NOTHING`,
    [mid,cid,uid,role,r.content||'',r.message_id||null,r.status||'completed',JSON.stringify({legacy:{database:'hermes_carter',table:'public.messages',id:item.source_id,agent_id:'maxiao'}}),r.created_at])
    const payload={v:2,id:mid,ts:new Date(r.created_at).getTime(),kind:role==='assistant'?'assistant_message':'user_message',platform:r.platform||'feishu',chatId:r._source_conversation?.chat_id||`legacy:hermes_carter:${oldConv}`,userId:openId,userName:'汪晓东',project:'pdaccaf9b1c',projectName:'dacca',text:r.content||'',status:r.status||'completed'}
    await c.query(`INSERT INTO requirement_assistant.records(id,occurred_at,kind,user_id,conversation_id,payload,app_id)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(id) DO NOTHING`,[mid,new Date(r.created_at),payload.kind,uid,cid,JSON.stringify(payload),process.env.FEISHU_APP_ID])
    await c.query(`UPDATE requirement_assistant.legacy_imports SET imported_message_ids=ARRAY[$2::uuid],status='imported',imported_at=coalesce(imported_at,now())
      WHERE source_system='hermes_carter' AND source_table='public.messages' AND source_id=$1`,[item.source_id,mid])
  }
  await c.query('COMMIT')
  const config=JSON.parse(await readFile(configFile,'utf8')),pc=config.projects.pdaccaf9b1c
  pc.ownerOpenIds=[openId]
  const tmp=configFile+'.tmp';await writeFile(tmp,JSON.stringify(config,null,2),'utf8');await rename(tmp,configFile)
  console.log(JSON.stringify({bound:true,user:'汪晓东',project:'dacca',daccaMessages:198,materialsFiles:pkg.rows[0].materials_manifest.length}))
}catch(e){await c.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({bound:false,errorCode:e.code||'BIND_FAILED'}));process.exitCode=1}finally{await c.end().catch(()=>{})}
