// Live DB validation inside an outer transaction, always rolled back. No Feishu/model calls.
import assert from 'node:assert/strict'
import { Client } from 'pg'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from '../src/config.js'
import { PostgresStore } from '../src/store-postgres.js'

loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)))
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for live rollback test')
const client = new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000})
let store
try {
  await client.connect(); await client.query('BEGIN')
  let offline = false, uncertain = false
  const query = async (sql,args) => {
    if (sql === 'BEGIN') return client.query('SAVEPOINT sync_operation')
    if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT sync_operation').catch(() => {})
    if (sql === 'COMMIT') {
      const result = await client.query('RELEASE SAVEPOINT sync_operation')
      if (uncertain) { uncertain=false; await client.query('SAVEPOINT sync_operation'); throw Object.assign(new Error('lost commit response'),{code:'ECONNRESET'}) }
      return result
    }
    return client.query(sql,args)
  }
  const pool = { on() {}, query, end:async()=>{}, connect:async()=>{
    if (offline) throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'})
    return {query,release(){}}
  } }
  const dir = await mkdtemp(join(tmpdir(),'req-postgres-'))
  const appId = 'test-' + randomUUID()
  const options = {appId,pool}
  store = new PostgresStore(dir,options); await store.init()
  const ts = Date.now()
  const msg = (user,text) => ({ id:randomUUID(),ts,kind:'user_message',platform:'feishu',userId:user,
    userName:'同名测试用户',chatId:'test-group',project:'',text,msgId:randomUUID() })
  const alice=msg('alice','Alice private'),bob=msg('bob','Bob private')
  await store.syncProfile({openId:'alice',name:'同名测试用户',avatar:'',status:'available',at:ts})
  await store.append(alice); await store.append(bob); await store.flush()
  assert.equal(store.status().pending,0)
  const rows = await client.query(`SELECT id,user_id,conversation_id FROM requirement_assistant.messages WHERE id=ANY($1::uuid[])`,[[alice.id,bob.id]])
  assert.equal(rows.rowCount,2)
  assert.notEqual(rows.rows[0].user_id,rows.rows[1].user_id)
  assert.notEqual(rows.rows[0].conversation_id,rows.rows[1].conversation_id)
  await store.append(alice); await store.flush()
  assert.equal((await client.query('SELECT count(*)::int AS n FROM requirement_assistant.messages WHERE id=$1',[alice.id])).rows[0].n,1)
  const duplicateId=randomUUID()
  await store.append({...alice,id:duplicateId}); await store.flush()
  assert.equal((await client.query('SELECT id FROM requirement_assistant.messages WHERE id=$1',[duplicateId])).rowCount,0)
  await store.syncTask({...alice,id:alice.id,createdAt:ts,updatedAt:ts,status:'completed',result:'answer',delivery:'sent',artifacts:[]})
  await store.resetConversation(alice)
  const next=msg('alice','New conversation'); await store.append(next)
  const reply={...alice,id:randomUUID(),kind:'assistant_message',text:'late answer',refId:alice.id}
  await store.append(reply); await store.flush()
  assert.equal((await client.query('SELECT status FROM requirement_assistant.tasks WHERE id=$1',[alice.id])).rows[0].status,'completed')
  const mapping=await client.query('SELECT id,conversation_id FROM requirement_assistant.messages WHERE id=ANY($1::uuid[])',[[alice.id,next.id,reply.id]])
  const ids=Object.fromEntries(mapping.rows.map(r=>[r.id,r.conversation_id]))
  assert.notEqual(ids[alice.id],ids[next.id]); assert.equal(ids[reply.id],ids[alice.id])
  // Real foreign-key enforcement: another user's message cannot join Alice's session.
  await client.query('SAVEPOINT invalid_owner')
  await assert.rejects(client.query(`INSERT INTO requirement_assistant.messages(id,conversation_id,user_id,role) VALUES($1,$2,$3,'user')`,[randomUUID(),ids[alice.id],store.userId('bob')]),e=>e.code==='23503')
  await client.query('ROLLBACK TO SAVEPOINT invalid_owner')
  offline=true
  const queued=msg('alice','Offline durable'); await store.append(queued); await store.flush()
  assert.equal(store.status().pending,1)
  await store.close()
  store=new PostgresStore(dir,options); await store.init()
  assert.equal(store.status().pending,1)
  offline=false; uncertain=true; await store.flush()
  assert.equal(store.status().pending,1)
  await store.flush(); assert.equal(store.status().pending,0)
  assert.equal((await client.query('SELECT count(*)::int AS n FROM requirement_assistant.messages WHERE id=$1',[queued.id])).rows[0].n,1)
  // Remove local read contribution to prove cloud read works, and app scoping holds.
  store.local.readRange=async()=>[]
  assert.ok((await store.readRange(ts-1,ts+1)).some(r=>r.id===queued.id))
  assert.equal((await store.readUsers()).length,2)
  store.appId='other-app'
  assert.equal((await store.readRange(ts-1,ts+1)).length,0)
  console.log('POSTGRES-OK: ownership, reset, late reply, dedup, task, durable restart, uncertain commit replay, cloud reads; all test rows rolled back')
} finally {
  await store?.close(); await client.query('ROLLBACK').catch(()=>{}); await client.end()
}
