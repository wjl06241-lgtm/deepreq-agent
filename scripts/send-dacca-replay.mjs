import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {Pool} from 'pg'
import {loadEnvFile,loadRuntimeConfig} from '../src/config.js'
import {databaseId,PostgresStore} from '../src/store-postgres.js'
import {sendToChat,sendFileToChat} from '../src/feishu.js'
import {Client} from '@larksuiteoapi/node-sdk'
const root=resolve(import.meta.dirname,'..');loadEnvFile(join(root,'.env'))
const cfg=loadRuntimeConfig(),dir=resolve(process.argv[2]),result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'))
const task=result.tasks.find(t=>t.status==='completed'&&t.result)
if(!task)throw Error('No completed answer')
const pool=new Pool({connectionString:cfg.database.url,connectionTimeoutMillis:10000})
try {
  const source=(await pool.query(`SELECT m.*,c.chat_id FROM requirement_assistant.messages m JOIN requirement_assistant.users u ON u.id=m.user_id JOIN requirement_assistant.conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND u.app_id=$2 AND u.external_user_id=$3 AND m.role='user'`,[result.source.id,cfg.feishu.appId,'ou_9eb7cd9d78b2bdb1d0e06c22c8bc11c1'])).rows[0]
  if(!source||source.content!==result.question)throw Error('Source identity mismatch')
  const id=databaseId('authorized-replay',source.id,dir)
  await pool.query(`INSERT INTO requirement_assistant.messages(id,conversation_id,user_id,role,content,reply_to_id,metadata) VALUES($1,$2,$3,'assistant',$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[id,source.conversation_id,source.user_id,task.result,source.id,{delivery:'pending',source:'authorized_replay',replayDirectory:dir}])
  const saved=(await pool.query('SELECT content,metadata FROM requirement_assistant.messages WHERE id=$1',[id])).rows[0]
  if(saved.metadata.delivery==='sent'){console.log('ALREADY-SENT');process.exitCode=0}
  else {
    const api=new Client({...cfg.feishu,logger:{error(){},warn(){},info(){},debug(){},trace(){}}})
    await sendToChat(api,source.chat_id,saved.content,{uuid:id})
    const replayState=JSON.parse(await readFile(join(dir,'tasks.json'),'utf8'))
    const artifacts=Object.values(replayState.tasks||{}).find(t=>t.status==='completed')?.artifacts||[]
    const cloud=new PostgresStore(cfg.dataDir,{pool,appId:cfg.feishu.appId})
    const outputDir=join(cfg.dataDir,'outputs',id)
    await mkdir(outputDir,{recursive:true})
    for(const [i,a] of artifacts.entries()) {
      const file=join(outputDir,`${i+1}-`+a.name.replace(/[\\/]/g,'_'))
      await copyFile(a.file,file)
      await cloud.attachment(pool,{file,name:a.name,id:databaseId('replay-output',id,i),kind:'output'},source.conversation_id,source.user_id,id)
      await sendFileToChat(api,source.chat_id,{file,name:a.name},{uuid:id+'-file-'+i})
    }
    await writeFile(join(dir,'sent.json'),JSON.stringify({id,sentAt:new Date().toISOString()}))
    await pool.query(`UPDATE requirement_assistant.messages SET metadata=metadata||$2::jsonb WHERE id=$1`,[id,JSON.stringify({delivery:'sent',sentAt:new Date().toISOString()})])
    await pool.query('UPDATE requirement_assistant.conversations SET updated_at=now() WHERE id=$1',[source.conversation_id])
    console.log(JSON.stringify({sent:true,saved:true,messageId:id,sourceMessage:source.id,characters:saved.content.length}))
  }
}catch(e){console.error(JSON.stringify({sent:false,error:e.code||'REPLAY_DELIVERY_FAILED',message:String(e.message).slice(0,200)}));process.exitCode=1}finally{await pool.end()}
