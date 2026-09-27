import assert from 'node:assert/strict'
import { loadEnvFile,loadRuntimeConfig } from '../src/config.js'
import { createSession } from '../src/admin-auth.js'
import { Client } from 'pg'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
loadEnvFile('.env');const cfg=loadRuntimeConfig(),base='http://127.0.0.1:'+cfg.adminPort
const cookie='ra_admin='+encodeURIComponent(createSession(cfg.admin.username,cfg.admin.sessionSecret,1))
const get=async path=>{const res=await fetch(base+path,{headers:{cookie}});assert.equal(res.status,200,path);return res.json()}
assert.equal((await fetch(base+'/api/enterprise/catalog')).status,401)
assert.equal((await fetch(base+'/api/enterprise/project',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).status,403)
const catalog=await get('/api/enterprise/catalog'),p=catalog.projects.find(p=>p.id==='pdaccaf9b1c')
assert.equal(p.enterpriseId,'huaxi-hospital');assert.equal(p.name,'DACCA');assert(p.messageCount>=211)
const history=await get('/api/enterprise/history?projectId=pdaccaf9b1c');assert.equal(history.conversations.length,5)
let total=0
for(const conv of history.conversations){const d=await get('/api/admin/conversations/'+conv.id);total+=d.messages.length;assert.equal(d.conversation.openId,'ou_9eb7cd9d78b2bdb1d0e06c22c8bc11c1')}
assert(total>=211)
const db=new Client({connectionString:cfg.database.url});await db.connect()
try{
  const backup=process.argv[2];if(!backup)throw new Error('Pass the verified backup directory')
  for(const table of ['messages','attachments']){
    const before=JSON.parse(await readFile(backup+'/'+table+'.json','utf8'))
    const after=(await db.query('SELECT * FROM requirement_assistant.'+table)).rows
    const normalize=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))
    const hash=r=>createHash('sha256').update(JSON.stringify(normalize(r))).digest('hex')
    const current=new Map(after.map(r=>[r.id,hash(r)]))
    for(const r of before)assert.equal(current.get(r.id),hash(r),'original '+table+' row changed: '+r.id)
  }
}finally{await db.end()}
console.log(JSON.stringify({authenticatedApi:true,csrf:true,enterprise:'华西医院',project:'DACCA',messages:total,conversations:5,originalMessagesAndAttachmentsUnchanged:true}))
