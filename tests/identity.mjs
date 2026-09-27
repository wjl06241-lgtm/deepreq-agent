import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { actorKey, sessionKey } from '../src/identity.js'
import { UserResolver } from '../src/users.js'
import { createAssistant } from '../src/assistant.js'
import { JsonlStore } from '../src/store.js'
import { MemoryStore } from '../src/memory.js'
import { ProjectRegistry } from '../src/projects.js'

const root=await mkdtemp(join(tmpdir(),'req-identity-test-'))
const a={platform:'feishu',chatId:'group',userId:'alice',userName:'同名用户'}
const b={...a,userId:'bob'}
assert.notEqual(actorKey(a),actorKey(b))
assert.notEqual(sessionKey(a),sessionKey({...a,chatId:'private'}))
assert.throws(()=>actorKey({chatId:'group'}))
const users=new UserResolver(join(root,'users.json'));await users.init()
let fetches=0
const api={contact:{v3:{user:{get:async()=>{fetches++;return {code:0,data:{user:{name:'姓名',avatar:{avatar_72:'https://example.test/avatar'},email:'do-not-store',mobile:'do-not-store'}}}}}}}}
const profiles=await Promise.all([users.profile(api,'ou_a'),users.profile(api,'ou_a')])
assert.equal(fetches,1);assert.equal(profiles[0].name,'姓名');assert(!('email' in profiles[0]));assert(!('mobile' in profiles[0]))
await users.profile(api,'ou_a');assert.equal(fetches,1)
const failure={contact:{v3:{user:{get:async()=>{fetches++;return {code:999,msg:'denied'}}}}}}
assert.equal((await users.profile(failure,'ou_b')).status,'unavailable')
await users.profile(failure,'ou_b');assert.equal(fetches,2)
await users.dispose();const users2=new UserResolver(join(root,'users.json'));await users2.init();assert.equal(users2.list().length,2)

const store=new JsonlStore(root);await store.init()
const memory=new MemoryStore(join(root,'memory'));await memory.init()
const projects=new ProjectRegistry(join(root,'projects.json'));await projects.load()
const p1=projects.create('项目一'),p2=projects.create('项目二');projects.setActive('group',p1.id)
await memory.push('group',p1.id,'user','LEGACY-GROUP-SECRET')
const calls=[],replies=[],resets=[]
const assistant=createAssistant({root,cfg:{dataDir:root,backend:'codex',codex:{},llm:{},unansweredTimeoutSec:600},configFile:join(root,'config.json'),store,projects,memory,
  sendReply:async(chat,text)=>replies.push(text),alertAdmins:async()=>{},log:()=>{},
  codexBackend:{run:async opts=>{calls.push(opts);return {text:'answer for '+opts.text}},reset:async key=>resets.push(key),close:()=>{}}})
await assistant.ready
let sequence=0
const send=(who,text)=>assistant.processMessage({...who,text,msgId:'m'+(++sequence)})
await send(a,'ALICE-SECRET');await send(b,'BOB-SECRET')
assert.notEqual(calls[0].key,calls[1].key)
assert(!calls[0].text.includes('LEGACY-GROUP-SECRET'));assert(!calls[1].text.includes('ALICE-SECRET'))
await send(a,'continue')
assert.equal(calls[0].key,calls[2].key);assert(calls[2].text.includes('ALICE-SECRET'));assert(!calls[2].text.includes('BOB-SECRET'))
await send(a,'/project use '+p2.id)
assert.equal(assistant.projectFor(a).id,p2.id);assert.equal(assistant.projectFor(b).id,p1.id)
await send(a,'/project use '+p1.id);await send(a,'/new')
assert.equal((await memory.get(actorKey(a),p1.id)).length,0)
assert((await memory.get(actorKey(b),p1.id)).length>0)
assert.equal(resets[0],sessionKey({...a,projectId:p1.id}))
const bobTask=assistant.runtime.tasks.list().find(t=>t.userId==='bob')
await send(a,'/task resend '+bobTask.id)
assert.equal(replies.at(-1),'没有可补发的任务结果。')
await send(a,'/task status');assert(!replies.at(-1).includes(bobTask.id.slice(0,8)))
const privateProject=projects.create('私有项目')
await writeFile(join(root,'config.json'),JSON.stringify({projects:{[privateProject.id]:{ownerOpenIds:['alice']}}}))
await send(b,'/project use '+privateProject.id)
assert.notEqual(assistant.projectFor(b)?.id,privateProject.id)
await send(a,'/project use '+privateProject.id)
assert.equal(assistant.projectFor(a).id,privateProject.id)
await send(b,'/project list')
assert(!replies.at(-1).includes(privateProject.id))
const file=join(root,'private.txt');await writeFile(file,'attachment-secret')
const common=join(root,'common');await mkdir(join(common,'历史聊天'),{recursive:true})
await writeFile(join(common,'历史聊天','old.json'),'old-private')
await writeFile(join(common,'对话记录.md'),'old-private')
await writeFile(join(common,'项目规范.md'),'shared-doc')
assert.equal((await assistant.runtime.library.catalog(sessionKey({...a,projectId:p1.id}),common)).size,1)
await assistant.runtime.library.register(sessionKey({...b,projectId:p1.id}),file,'private.txt')
assert.equal((await assistant.runtime.library.catalog(sessionKey({...a,projectId:p1.id}),null)).size,0)
assert.equal((await assistant.runtime.library.catalog(sessionKey({...b,projectId:p1.id}),null)).size,1)
assert.equal((await assistant.runtime.library.catalog('owner',common,{includeHistory:true})).size,3)
await assistant.dispose();await memory.dispose();await projects.dispose();await users2.dispose()
console.log('USER-ISOLATION-OK: profiles, permissions fallback, same-name users, project selection, history, reset, tasks, attachments, legacy isolation')
