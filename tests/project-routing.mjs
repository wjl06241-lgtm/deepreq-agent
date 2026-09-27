import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRouter, validateRoute } from '../src/project-routing.js'
import { ProjectRegistry } from '../src/projects.js'
import { JsonlStore } from '../src/store.js'
import { MemoryStore } from '../src/memory.js'
import { createAssistant } from '../src/assistant.js'
import { actorKey } from '../src/identity.js'

const root=await mkdtemp(join(tmpdir(),'route-confirm-'))
const cfg={dataDir:root,backend:'codex',codex:{},llm:{},projectRouting:{enabled:true}}
const projects=new ProjectRegistry(join(root,'projects.json'));await projects.load()
projects.governed=true;projects.enterprise={id:'hospital',name:'医院'}
projects.catalog={a:{id:'a',name:'主动健康',description:'本院患者画像平台建设',soul:'项目专用人格',enterpriseId:'hospital',memberOpenIds:['alice']},b:{id:'b',name:'项目乙',enterpriseId:'other',memberOpenIds:['alice']}}
const store=new JsonlStore(root);await store.init()
const memory=new MemoryStore(join(root,'memory'));await memory.init()
const calls=[],replies=[],inputs=[]
const routeClassifier=async input=>{inputs.push(input);return JSON.stringify({recommend:true,projectId:'a',confidence:0.95,reason:'讨论本院平台建设'})}
const app=createAssistant({root,cfg,configFile:join(root,'config.json'),store,projects,memory,routeClassifier,
  sendReply:async(chat,text,options)=>replies.push({chat,text,options}),alertAdmins:async()=>{},log:()=>{},
  codexBackend:{run:async input=>{calls.push(input);return{text:'回答完成'}},close:()=>{}}})
await app.ready
let seq=0
const msg=(text,userId='alice')=>({platform:'feishu',chatType:'private',chatId:'chat-'+userId,userId,text,msgId:String(++seq)})
const choice=()=>replies.findLast(r=>r.options?.card).options.card.body.elements.find(e=>e.tag==='button').behaviors[0].value
try {
  const original=msg('本院平台一期建设怎么做？')
  await app.processMessage(original)
  assert.equal(inputs.length,0,'first contact must select before model inference')
  assert.equal(calls.length,0,'no answer or project Soul before confirmation')
  const card=replies.at(-1).options.card
  assert(!JSON.stringify(card).includes('项目乙'),'other organization excluded')
  const first=choice()
  await app.confirmProject({...original,userId:'mallory'},first)
  assert.equal(calls.length,0,'cannot click another user card')
  await app.confirmProject(original,{...first,projectId:'b'})
  assert.equal(calls.length,0,'forged choice rejected')
  await app.confirmProject(original,first)
  assert.equal(calls.length,1)
  assert(calls[0].systemPrompt.includes('项目专用人格'))
  assert(calls[0].text.includes(original.text))
  assert.equal(projects.selectionFor(actorKey(original)),'a')
  await app.confirmProject(original,first)
  assert.equal(calls.length,1,'duplicate click cannot run model twice')
  await app.processMessage(msg('返回普通聊天'))
  await app.processMessage(msg('我们患者画像平台预算怎么分？'))
  assert.equal(calls.length,1)
  assert.equal(inputs.length,1)
  assert.equal(inputs[0].projects.length,1)
  assert(!JSON.stringify(inputs[0]).includes('项目专用人格'),'router sees directory only')
  await app.processMessage(msg('确认归属 2'))
  assert.equal(calls.length,2)
  assert(!calls[1].systemPrompt.includes('项目专用人格'))
  await app.processMessage(msg('本院平台继续讨论'))
  assert.equal(calls.length,3,'decline suppresses repeated proposal')
  await app.processMessage(msg('你好','bob'))
  assert.equal(replies.at(-1).options.card.body.elements.filter(e=>e.tag==='button').length,1,'unassigned user can choose ordinary chat')
  await app.processMessage(msg('确认归属 1','bob'))
  assert.equal(calls.length,4)
  const r=new ProjectRouter({...cfg,dataDir:await mkdtemp(join(tmpdir(),'route-pending-'))},routeClassifier)
  await r.ready
  let selectedCard
  const m=msg('第一条')
  await r.suggest(m,'',[projects.catalog.a],[],async(c,t,o)=>{selectedCard=o.card})
  const nonce=selectedCard.body.elements.find(e=>e.tag==='button').behaviors[0].value.nonce
  const restarted=new ProjectRouter(r.cfg,routeClassifier);await restarted.ready
  await assert.rejects(()=>restarted.choose(m,{nonce,projectId:'a'},[]),/不可访问/,'revoked permissions rechecked')
  await restarted.suggest({...m,msgId:'new',text:'新的问题'},'',[projects.catalog.a],[],async()=>{})
  await assert.rejects(()=>restarted.choose(m,{nonce,projectId:'a'},[projects.catalog.a]),/失效/)
  restarted.state.data.pending[actorKey(m)].expiresAt=0
  await assert.rejects(()=>restarted.choose(m,{index:1},[projects.catalog.a]),/失效/)
  await r.close();await restarted.close()
  for(const text of ['bad','{}',JSON.stringify({recommend:true,projectId:'b',confidence:1,reason:'越权'}),JSON.stringify({recommend:true,projectId:'a',confidence:0.5,reason:'不确定'})]) assert.equal(validateRoute(text,[projects.catalog.a]),null)
  console.log('PROJECT-ROUTING-OK: onboarding, scoped Soul, confirmation replay, fallback, identity, revocation, cooldown, persistence, stale cards')
} finally {await app.dispose();await memory.dispose();await projects.dispose()}
