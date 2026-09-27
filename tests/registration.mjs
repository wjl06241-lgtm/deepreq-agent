import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Registration} from '../src/registration.js'
const file=join(await mkdtemp(join(tmpdir(),'registration-')),'state.json')
const r=new Registration(file);await r.init()
r.state.data.users.old={profile:{name:'原资料',organization:'原组织',position:'医生'},editing:true}
await r.state.save();const before=await readFile(file,'utf8')
const replies=[],send=async(c,t)=>replies.push(t)
const forbidden=async()=>{throw new Error('Must not read or overwrite manual registration')}
const msg={chatType:'private',userId:'new',chatId:'chat',text:'你好',enterpriseName:'成都市第一人民医院',userProfile:{name:'飞书姓名',status:'available'}}
for(const userId of ['new','old'])assert.equal(await r.handle({...msg,userId},send,forbidden,forbidden),false)
assert.equal(replies.length,0)
assert.equal(await r.handle({...msg,kind:'file',text:undefined},send,forbidden,forbidden),false)
for(const text of ['/profile','/profile edit']){
  assert.equal(await r.handle({...msg,text},send,forbidden,forbidden),true)
  assert(replies.at(-1).includes('飞书姓名'));assert(replies.at(-1).includes('成都市第一人民医院'))
  assert(!replies.at(-1).includes('职位：'))
}
await r.handle({...msg,text:'/profile',userProfile:{status:'unavailable'}},send,forbidden,forbidden)
assert(replies.at(-1).includes('暂未获取'));assert(replies.at(-1).includes('new'))
assert.equal(await readFile(file,'utf8'),before)
console.log('REGISTRATION-OK: Feishu identity, configured enterprise, no onboarding gate, missing-profile fallback, legacy data unchanged')
