import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRegistry } from '../src/projects.js'
import { JsonlStore } from '../src/store.js'
import { MemoryStore } from '../src/memory.js'
import { createAssistant } from '../src/assistant.js'
import { parseReceiveEvent } from '../src/feishu.js'
const root=await mkdtemp(join(tmpdir(),'enterprise-switch-'))
const projects=new ProjectRegistry(join(root,'projects.json'));await projects.load()
projects.governed=true;projects.enterprise={id:'enterprise-a',name:'测试企业'}
projects.catalog={a:{id:'a',name:'项目甲',enterpriseId:'enterprise-a',memberOpenIds:['alice','bob']},b:{id:'b',name:'项目乙',enterpriseId:'enterprise-a',memberOpenIds:['alice']},c:{id:'c',name:'外部项目',enterpriseId:'enterprise-b',memberOpenIds:['alice']}}
const store=new JsonlStore(root);await store.init();const memory=new MemoryStore(join(root,'memory'));await memory.init()
const calls=[],replies=[]
const assistant=createAssistant({root,cfg:{dataDir:root,backend:'codex',codex:{},llm:{}},configFile:join(root,'config.json'),store,projects,memory,sendReply:async(chat,text)=>replies.push({chat,text}),alertAdmins:async()=>{},log:()=>{},codexBackend:{run:async opts=>{calls.push(opts);return {text:'完成'}},reset:async()=>{},close:()=>{}}})
await assistant.ready;let seq=0
const send=(userId,text)=>assistant.processMessage({platform:'feishu',chatType:'private',chatId:'chat-'+userId,userId,text,msgId:String(++seq)})
const sendGroup=(userId,text)=>assistant.processMessage({platform:'feishu',chatType:'group',chatId:'group-1',userId,text,msgId:String(++seq)})
try{
  assert.equal(parseReceiveEvent({message:{message_type:'text',chat_type:'p2p',chat_id:'x',content:'{"text":"你好"}'},sender:{sender_id:{open_id:'alice'}}}).chatType,'private')
  assert.equal(parseReceiveEvent({message:{message_type:'text',chat_type:'group',chat_id:'g',content:'{"text":"@_user_1 你好"}'},sender:{sender_id:{open_id:'alice'}}}).chatType,'group')
  await send('alice','普通聊天秘密');assert.equal(calls.length,1);assert(replies.at(-1).text.includes('普通聊天'))
  await send('bob','切换项目');assert(!replies.at(-1).text.includes('项目乙'))
  await send('alice','选择项目 项目甲');await send('alice','甲的秘密');assert.equal(calls.length,2);assert(!calls.at(-1).text.includes('普通聊天秘密'))
  await send('alice','选择项目 项目乙');await send('alice','乙的提问');assert(!calls.at(-1).text.includes('甲的秘密'))
  await send('alice','选择项目 项目甲');await send('alice','继续');assert(calls.at(-1).text.includes('甲的秘密'))
  await send('bob','选择项目 项目甲');await send('bob','我是谁');assert(!calls.at(-1).text.includes('甲的秘密'))
  const count=calls.length;await send('alice','选择项目 外部项目');assert(!replies.at(-1).text.includes('已切换'))
  projects.catalog.a.memberOpenIds=['bob'];await send('alice','已经撤权');assert.equal(calls.length,count)
  await send('alice','返回普通聊天');await send('alice','普通续聊');assert(calls.at(-1).text.includes('普通聊天秘密'));assert(!calls.at(-1).text.includes('甲的秘密'))
  assert.equal(projects.selectionFor('["user-v2","feishu","chat-alice","alice"]'),'')
  const beforeNatural=calls.length
  await send('alice','我现在的是在哪个项目下')
  assert.equal(calls.length,beforeNatural)
  // Natural state query used in the actual chat.
  await send('alice','我现在是在哪个项目下');assert(replies.at(-1).text.includes('普通聊天'));assert(replies.at(-1).text.includes('项目乙'))
  const afterQuery=calls.length
  await send('alice','选择项目乙项目');assert(replies.at(-1).text.includes('已切换到'))
  await send('alice','我现在在哪个项目下？');assert(replies.at(-1).text.includes('当前项目：项目乙'));assert.equal(calls.length,afterQuery)
  await projects.save();const selected=new ProjectRegistry(projects.file);await selected.load();assert.equal(selected.selectionFor('["user-v2","feishu","chat-alice","alice"]'),'b')
  await send('bob','帮我切换到项目乙项目');assert(!replies.at(-1).text.includes('已切换到'));assert.equal(calls.length,afterQuery)
  await send('alice','返回普通聊天')
  await projects.save();const restored=new ProjectRegistry(projects.file);await restored.load();assert.equal(restored.selectionFor('["user-v2","feishu","chat-alice","alice"]'),'')
  projects.catalog={};await send('new-user','完全没有项目');assert(calls.at(-1).text.includes('完全没有项目'));assert(!calls.at(-1).text.includes('普通聊天秘密'))
  await sendGroup('alice','群聊问题');assert(calls.at(-1).text.includes('群聊问题'))
  await sendGroup('bob','群聊里的另一位用户');assert(!calls.at(-1).text.includes('群聊问题'))
  await send('bob','/project new 不该创建');assert.equal(projects.find('不该创建'),null)
  await send('bob','/prompt set 不该全局修改');assert(replies.at(-1).text.includes('管理员'))
  assert(assistant.runtime.tasks.list().every(t=>t.projectLabel?.startsWith('测试企业 / ')))
  console.log('ENTERPRISE-SWITCH-OK: private/group routing, selection, continuity, per-user isolation, cross-enterprise denial, revocation, project labels')
}finally{await assistant.dispose();await memory.dispose();await projects.dispose()}
