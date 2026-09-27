// A real management page backed by authenticated API endpoints, sharing the existing login and drawer.
import { projectConfigDashboard } from './project-config-dashboard.js'
export function enterpriseDashboard(html) {
  return html.replaceAll('c.projectName||"默认项目"','c.projectId ? (c.projectName||c.projectId) : "普通聊天"').replace('loadPage("overview")','loadPage("workspace")').replace('</body>',`<style>
    .workspace-head{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:22px}.workspace-head h2{margin:0 0 8px;font-size:27px}.workspace-head p{margin:0;color:#6f7a90}.workspace-grid{display:grid;grid-template-columns:245px 1fr;gap:20px}.company-list{display:grid;gap:8px;align-content:start}.company-item{text-align:left;padding:17px;border:1px solid #e1e6ef;border-radius:12px;background:white;color:#24314c}.company-item.selected{border-color:#3157d5;background:#eef2ff;box-shadow:inset 3px 0 #3157d5}.company-item strong{display:block;font-size:15px;margin-bottom:7px}.company-item span{font-size:12px;color:#6f7a90}.project-grid{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:16px}.project-card{padding:22px;background:#fff;border:1px solid #e1e6ef;border-radius:15px}.project-card h3{margin:12px 0 9px;font-size:21px}.project-card p{color:#6f7a90;line-height:1.6;min-height:26px}.project-stats{display:flex;gap:24px;padding:16px 0;border-top:1px solid #edf0f4;border-bottom:1px solid #edf0f4;margin:16px 0}.project-stats strong{display:block;font-size:21px}.project-stats span{font-size:12px;color:#6f7a90}.project-actions{display:flex;gap:8px;flex-wrap:wrap}.org-primary{background:#3157d5;color:white;border:none;border-radius:9px;padding:11px 16px;font-weight:600}.org-input,.org-select,.org-textarea{width:100%;border:1px solid #d9deea;border-radius:9px;padding:11px;background:#fff;color:#24314c;font:inherit;box-sizing:border-box}.org-textarea{min-height:120px;resize:vertical}.org-field{display:block;margin-bottom:18px;font-size:13px;color:#546078}.org-field>span{display:block;margin-bottom:8px}.member-option{display:flex;gap:12px;padding:13px;border:1px solid #e7eaf0;border-radius:9px;margin-bottom:8px;align-items:center}.org-notice{padding:14px 17px;border-radius:10px;background:#eef5ff;color:#38557a;line-height:1.7;font-size:13px;margin-bottom:20px}.org-error{color:#c63838;min-height:22px;margin-top:12px}.workspace-empty{padding:45px;border:1px dashed #cbd4e4;border-radius:14px;text-align:center;background:#fff;color:#6f7a90}.company-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.company-toolbar h3{margin:0 0 6px}.org-users{margin-top:22px}.org-user-row{display:flex;justify-content:space-between;gap:12px;padding:13px 0;border-bottom:1px solid #edf0f4}@media(max-width:1000px){.workspace-grid{grid-template-columns:1fr}.company-list{grid-template-columns:repeat(2,1fr)}.project-grid{grid-template-columns:1fr}.workspace-head{align-items:start}}
    .org-user-note{margin-top:7px;max-width:520px;color:#49566d;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
    </style><script>(${workspaceUI.toString()})();</script>${projectConfigDashboard()}</body>`)
}

function workspaceUI(){
  let state=null,enterpriseId='',showArchived=false
  const $=id=>document.getElementById(id)
  const button=document.createElement('button');button.dataset.page='workspace';button.innerHTML='<span class="ico">▦</span>企业与项目'
  document.querySelector('.nav').prepend(button);button.onclick=()=>loadPage('workspace');titles.workspace='企业与项目'
  const section=document.createElement('section');section.id='page-workspace';section.className='page';document.querySelector('.content').prepend(section)
  const originalRefresh=refreshPage
  refreshPage=function(){if(currentPage==='workspace'){updated.textContent='更新于 '+fmt(Date.now());loadWorkspace()}else originalRefresh()}
  refresh.onclick=()=>refreshPage()
  const options=(values,selected)=>values.map(x=>'<option value="'+esc(x.id)+'"'+(x.id===selected?' selected':'')+'>'+esc(x.name)+'</option>').join('')
  const field=(text,id,value='',area=false)=>'<label class="org-field"><span>'+esc(text)+'</span><'+(area?'textarea':'input')+' id="'+id+'" class="'+(area?'org-textarea':'org-input')+'" '+(area?'':'maxlength="60" value="'+esc(value)+'"')+'>'+(area?esc(value)+'</textarea>':'')+'</label>'
  const post=(path,body)=>api('/api/enterprise/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  function saveForm(action,read){
    $('orgForm').onsubmit=async e=>{e.preventDefault();$('orgSave').disabled=true;$('orgError').textContent=''
      try{await post(action,read());closeDrawer();await loadWorkspace()}
      catch(err){$('orgError').textContent=err.message;$('orgSave').disabled=false}
    }
  }
  const form=(body)=>'<form id="orgForm">'+body+'<button id="orgSave" class="org-primary" type="submit">保存</button><div id="orgError" class="org-error" role="alert"></div></form>'
  async function loadWorkspace(){
    try{state=await api('/api/enterprise/catalog');if(!state.enterprises.some(e=>e.id===enterpriseId))enterpriseId=state.enterprises.find(e=>e.appIds.includes(state.currentAppId))?.id||state.enterprises[0]?.id||'';render()}
    catch(e){section.innerHTML='<div class="workspace-empty">'+esc(e.message)+'</div>'}
  }
  function render(){
    const company=state.enterprises.find(e=>e.id===enterpriseId),projects=state.projects.filter(p=>p.enterpriseId===enterpriseId),users=state.users.filter(u=>u.enterpriseId===enterpriseId)
    section.innerHTML='<div class="workspace-head"><div><h2>企业与项目</h2><p>按企业组织团队，在项目中沉淀需求。每个人的私聊独立保存。</p></div><button id="addCompany" class="org-primary">＋ 新建企业</button></div><div class="workspace-grid"><aside class="company-list">'+state.enterprises.map(e=>'<button class="company-item '+(e.id===enterpriseId?'selected':'')+'" data-company="'+esc(e.id)+'"><strong>'+esc(e.name)+'</strong><span>'+state.projects.filter(p=>p.enterpriseId===e.id&&!p.archived).length+' 个项目 · '+e.appIds.length+' 个应用</span></button>').join('')+'</aside><div>'+(company?'<div class="company-toolbar"><div><h3>'+esc(company.name)+'</h3><span class="small">'+company.appIds.length+' 个飞书入口 · '+users.length+' 位已识别成员</span></div><div class="project-actions"><button id="editCompany" class="refresh">企业设置</button><button id="addProject" class="org-primary">＋ 新建项目</button></div></div><div class="org-notice">私聊输入“切换项目”查看可用项目，再回复“选择项目 项目名称”。未分配的成员无法进入项目；切换项目不会清除历史记录。</div><label class="small"><input id="showArchived" type="checkbox" '+(showArchived?'checked':'')+'> 显示已归档项目</label><div class="project-grid" style="margin-top:14px">'+(projects.filter(p=>showArchived||!p.archived).map(p=>'<article class="project-card"><span class="badge '+(p.archived?'warn':'ok')+'">'+(p.archived?'已归档':'进行中')+'</span><h3>'+esc(p.name)+'</h3><p>'+esc(p.description||'暂无项目说明')+'</p><div class="project-stats"><div><strong>'+p.memberIds.length+'</strong><span>项目成员</span></div><div><strong>'+p.conversationCount+'</strong><span>独立会话</span></div><div><strong>'+p.messageCount+'</strong><span>历史消息</span></div></div><div class="project-actions"><button class="refresh" data-edit="'+esc(p.id)+'">项目设置</button><button class="refresh" data-members="'+esc(p.id)+'">分配成员</button><button class="refresh" data-history="'+esc(p.id)+'">查看记录</button></div></article>').join('')||'<div class="workspace-empty">还没有项目，点击“新建项目”开始。</div>')+'</div><div class="panel org-users"><div class="panel-head"><h2>企业成员</h2><span class="small">成员首次私聊机器人后会出现在这里</span></div><div class="panel-body">'+(users.map(u=>'<div class="org-user-row"><div><strong>'+esc(u.name)+'</strong><div class="small">'+esc(u.openId)+'</div></div><span class="small">'+esc(projects.filter(p=>p.memberIds.includes(u.id)).map(p=>p.name).join('、')||'待分配项目')+'</span></div>').join('')||'<div class="empty">暂无成员</div>')+'</div></div>':'<div class="workspace-empty">创建企业后可关联飞书应用、建立项目并分配成员。</div>')+'</div></div>'
    section.querySelectorAll('.org-user-row').forEach((row,index)=>{
      const note=users[index]?.adminNote
      if(!note)return
      const item=document.createElement('div');item.className='org-user-note';item.textContent='备注：'+note
      row.firstElementChild.append(item)
    })
    const notice=section.querySelector('.org-notice')
    if(notice)notice.textContent='无需项目即可普通聊天。发送“切换项目”查看已授权项目，发送“返回普通聊天”退出项目。项目由后台统一创建和分配；普通聊天和项目记录各自保留。'
    $('addCompany').onclick=()=>editCompany()
    section.querySelectorAll('[data-company]').forEach(b=>b.onclick=()=>{enterpriseId=b.dataset.company;render()})
    if(company){$('editCompany').onclick=()=>editCompany(company);$('addProject').onclick=()=>editProject();$('showArchived').onchange=e=>{showArchived=e.target.checked;render()}}
    section.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editProject(state.projects.find(p=>p.id===b.dataset.edit)))
    section.querySelectorAll('[data-edit]').forEach(b=>{const config=document.createElement('button');config.className='refresh';config.textContent='项目配置';config.onclick=()=>window.openProjectConfiguration(b.dataset.edit);b.after(config)})
    section.querySelectorAll('[data-members]').forEach(b=>b.onclick=()=>editMembers(state.projects.find(p=>p.id===b.dataset.members)))
    section.querySelectorAll('[data-history]').forEach(b=>b.onclick=()=>history(b.dataset.history,0))
  }
  function editCompany(company){
    openDrawer(company?'企业设置':'新建企业',form(field('企业名称','orgName',company?.name)+field('飞书 App ID（可留空稍后绑定）','orgApp')+'<div class="org-notice">'+(company?.appIds.length?'已绑定：'+esc(company.appIds.join('、'))+'<br>':'')+'这里设置企业归属。新 App 的凭据与连接需在服务器完成配置，App Secret 不在本页填写。</div>'))
    saveForm('enterprise',()=>({id:company?.id,name:$('orgName').value,appId:$('orgApp').value.trim()}))
  }
  function editProject(project){
    openDrawer(project?'项目设置':'新建项目',form(field('项目名称','orgName',project?.name)+field('项目说明','orgDescription',project?.description,true)+(project?'<label class="org-field"><input id="orgArchived" type="checkbox" '+(project.archived?'checked':'')+'> 归档项目（保留全部记录，停止新对话）</label>':'')+'<div class="org-notice">Soul、提示词、边界和背景资料请在项目卡片的“项目配置”中维护。成员权限通过“分配成员”设置。</div>'))
    saveForm('project',()=>({id:project?.id,enterpriseId,name:$('orgName').value,description:$('orgDescription').value,archived:$('orgArchived')?.checked||false}))
  }
  function editMembers(project){
    const users=state.users.filter(u=>u.enterpriseId===project.enterpriseId)
    openDrawer('分配成员 · '+project.name,form('<div class="org-notice">勾选可以访问此项目的成员。取消授权只影响后续访问，既有对话和文件继续保留。</div>'+users.map(u=>'<label class="member-option"><input type="checkbox" name="orgMember" value="'+esc(u.id)+'" '+(project.memberIds.includes(u.id)?'checked':'')+'><div><strong>'+esc(u.name)+'</strong><div class="small">'+esc(u.openId)+'</div></div></label>').join('')))
    saveForm('members',()=>({id:project.id,userIds:[...document.querySelectorAll('input[name="orgMember"]:checked')].map(x=>x.value)}))
  }
  async function history(id,page){
    try{const result=await api('/api/enterprise/history?projectId='+encodeURIComponent(id)+'&page='+page),p=state.projects.find(p=>p.id===id)
      openDrawer((p?.name||'项目')+' · 会话记录','<div class="org-notice">按成员保留的独立会话，包括迁移前的历史记录。</div><div class="table-wrap"><table><thead><tr><th>成员</th><th>消息数</th><th>更新时间</th></tr></thead><tbody>'+result.conversations.map(c=>'<tr class="clickable" data-conversation="'+esc(c.id)+'"><td>'+esc(c.name||c.openId)+'</td><td>'+c.messageCount+'</td><td>'+fmt(c.updatedAt)+'</td></tr>').join('')+'</tbody></table></div><div class="project-actions" style="margin-top:18px"><button id="orgPrev" class="refresh" '+(page?'':'disabled')+'>上一页</button><button id="orgNext" class="refresh" '+(result.hasMore?'':'disabled')+'>下一页</button></div>')
      $('orgPrev').onclick=()=>history(id,page-1);$('orgNext').onclick=()=>history(id,page+1)
      document.querySelectorAll('[data-conversation]').forEach(b=>b.onclick=()=>showConversation(b.dataset.conversation))
    }catch(e){showError(e)}
  }
}
