import {AtomicState} from './state.js'

export function parseRegistration(text) {
  const fields = {}
  for (const line of String(text).trim().split(/\r?\n/)) {
    const m = /^(姓名|公司|医院|公司或医院|职位|职务)\s*[:：]\s*(.*?)\s*$/.exec(line.trim())
    if (!m) continue
    const key = m[1] === '姓名' ? 'name' : ['职位','职务'].includes(m[1]) ? 'position' : 'organization'
    if (fields[key] !== undefined) throw new Error('同一项请只填写一次')
    if (!m[2] || m[2].length > (key === 'organization' ? 120 : 60)) throw new Error('请填写有效的姓名、公司或医院、职位；每项不要超过规定长度')
    fields[key] = m[2]
  }
  if (!fields.name || !fields.organization || !fields.position) throw new Error('请按模板填写姓名、公司或医院、职位三项；没有单位或职位可填“无”')
  return {...fields, source:'self_reported', updatedAt:Date.now()}
}

export const registrationPrompt = '欢迎使用需求助手。请先登记基本资料，方便区分用户和项目。\n\n请复制下面三行并填写后发送：\n姓名：\n公司或医院：\n职位：\n\n资料将保存到需求助手后台，仅作为您本人填写的信息，不代表身份认证。没有单位或职位可填“无”。填写后请继续发送您的问题。以后发送 /profile 可查看资料，发送 /profile edit 可修改。'

export class Registration {
  constructor(file) { this.state = new AtomicState(file,{users:{}}); this.tail=Promise.resolve(); this.existing=new Set() }
  async init(){await this.state.init()}
  serial(fn){const job=this.tail.then(fn);this.tail=job.catch(()=>{});return job}
  async handle(msg, send, save, read) {
    if (msg.chatType !== 'private') return false
    // Preserve old files; Feishu identity and configured enterprise replace manual onboarding.
    const text=String(msg.text||'').trim()
    if (!/^\/profile(?:\s+edit)?$/i.test(text)) return false
    await send(msg.chatId,'飞书用户资料\n姓名：'+(msg.userProfile?.name||'暂未获取（仍按飞书用户 ID 识别）')
      +'\n所属企业：'+(msg.enterpriseName||'尚未绑定，请联系管理员')+'\n用户 ID：'+msg.userId
      +'\n\n用户信息自动从飞书获取，企业归属由后台配置，无需手动登记。'
      +(/\s+edit$/i.test(text)?'如需修改姓名，请在飞书中修改。':''))
    return true
  }
  // Retained only to read historical behavior; no production caller invokes manual registration.
  async legacyHandle(msg, send, save, read) {
    if (msg.chatType !== 'private') return false
    return this.serial(async()=>{
      const key=msg.userId, text=String(msg.text||'').trim()
      if(this.existing.has(key) && !this.state.data.users[key] && !/^\/profile\b/i.test(text)) return false
      let entry=this.state.data.users[key]
      if (!entry) {
        const existing=await read(key)
        entry=this.state.data.users[key]={profile:existing||null}
        await this.state.save()
      }
      if (/^\/profile\s+edit$/i.test(text)) { entry.editing=true;await this.state.save();await send(msg.chatId,registrationPrompt);return true }
      if (/^\/profile$/i.test(text)&&entry.profile) {const p=entry.profile;await send(msg.chatId,`本人填写资料\n姓名：${p.name}\n公司或医院：${p.organization}\n职位：${p.position}\n\n发送 /profile edit 修改。`);return true}
      if (!entry.profile||entry.editing) {
        if (text.includes('姓名：')||text.includes('姓名:')) {
          let profile
          try {profile=parseRegistration(text)} catch(e){await send(msg.chatId,e.message);return true}
          await save(key,profile)
          entry.profile=profile;entry.editing=false;await this.state.save()
          await send(msg.chatId,'资料已保存（本人填写）。现在可以继续发送问题或上传文件。');return true
        }
        await send(msg.chatId,registrationPrompt);return true
      }
      return false
    })
  }
}
