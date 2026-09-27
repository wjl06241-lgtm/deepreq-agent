import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {loadEnvFile,loadRuntimeConfig} from '../src/config.js'
import {PostgresStore} from '../src/store-postgres.js'
import {JsonlStore} from '../src/store.js'
import {MemoryStore} from '../src/memory.js'
import {ProjectRegistry} from '../src/projects.js'
import {createAssistant} from '../src/assistant.js'
import {Pool} from 'pg'
const root=join(import.meta.dirname,'..');loadEnvFile(join(root,'.env'))
const original=loadRuntimeConfig(),cloud=new PostgresStore(original.dataDir,{pool:new Pool({connectionString:original.database.url,connectionTimeoutMillis:20000}),appId:original.feishu.appId})
const userId='ou_9eb7cd9d78b2bdb1d0e06c22c8bc11c1'
const requestedId=process.argv.find(a=>a.startsWith('--message='))?.slice(10)||null
const row=(await cloud.pool.query(`SELECT m.*,c.chat_id,c.project_id FROM requirement_assistant.messages m JOIN requirement_assistant.users u ON u.id=m.user_id JOIN requirement_assistant.conversations c ON c.id=m.conversation_id WHERE u.app_id=$1 AND u.external_user_id=$2 AND m.role='user' AND ($3::uuid IS NULL OR m.id=$3::uuid) ORDER BY m.created_at DESC,m.sequence_no DESC LIMIT 1`,[original.feishu.appId,userId,requestedId])).rows[0]
if(!row)throw Error('Original message missing')
console.log(JSON.stringify({sourceMessage:row.id,question:row.content,createdAt:row.created_at,project:row.project_id}))
if(process.argv.includes('--inspect')) {await cloud.pool.end();process.exit(0)}
const dir=await mkdtemp(join(root,'data','dacca-replay-')),cfg={...original,dataDir:dir}
const store=new JsonlStore(dir);await store.init();store.historyFor=(msg,p)=>cloud.historyFor(msg,p,new Date(row.created_at).getTime())
const memory=new MemoryStore(join(dir,'memory'),cfg.maxHistoryTurns);await memory.init()
const projects=new ProjectRegistry(join(original.dataDir,'projects.json'));await projects.load()
const msg={platform:'feishu',userId,userName:'汪晓东',chatId:row.chat_id,text:row.content,msgId:'local-replay-'+Date.now(),boundProjectId:await cloud.assignedProject({userId,platform:'feishu'})}
const replies=[]
const assistant=createAssistant({cfg,root,configFile:join(root,'config.json'),store,memory,projects,sendReply:async(_,text)=>{replies.push(text)},alertAdmins:async()=>{},log:()=>{}})
try{await assistant.ready;await assistant.processMessage(msg);const tasks=assistant.runtime.tasks.list();const records=await store.readRange(0,Date.now()+1);const result={source:row,question:row.content,project:msg.boundProjectId,tasks:tasks.map(t=>({status:t.status,error:t.error,result:t.result})),tools:records.filter(r=>r.kind==='tool_event').map(r=>({action:r.action,note:r.note})),replies};await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({dir,status:result.tasks.map(t=>({status:t.status,error:t.error})),replies:replies.length}))}finally{await assistant.dispose();await memory.dispose();await cloud.pool.end()}
