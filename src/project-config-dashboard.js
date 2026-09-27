import { globalMaterialDashboard } from './global-material-dashboard.js'
import { configurationImportScript } from './configuration-import.js'
export function projectConfigDashboard(){return `${globalMaterialDashboard()}${configurationImportScript()}<style>
.drawer:has(.pc-shell){width:min(960px,96vw)}.pc-tabs{display:flex;gap:6px;border-bottom:1px solid #e1e6ef;padding-bottom:12px;margin-bottom:20px;flex-wrap:wrap}.pc-tabs button{border:0;background:#f0f3f9;border-radius:8px;padding:11px 17px;color:#53607a}.pc-tabs button.active{background:#3157d5;color:white}.pc-pane{display:none}.pc-pane.active{display:block}.pc-editor{min-height:280px;line-height:1.7}.pc-note{font-size:13px;line-height:1.7;color:#6b7891;margin:0 0 16px}.pc-footer{display:flex;align-items:center;gap:15px;border-top:1px solid #e1e6ef;margin-top:22px;padding-top:17px}.pc-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;background:#f6f8fb;padding:16px;border-radius:8px;font-size:13px}.pc-file{border:1px solid #e2e7ef;border-radius:12px;padding:16px;margin:12px 0}.pc-file-head{display:flex;justify-content:space-between;gap:12px}.pc-file-actions{display:flex;gap:12px;align-items:center;margin-top:13px;flex-wrap:wrap}.pc-status{font-size:13px;line-height:1.6}.pc-empty{padding:28px;text-align:center;background:#f8faff;border:1px dashed #cbd7ec;border-radius:10px;color:#6c7991}
</style><script>(${projectConfigUI.toString()})();</script>`}
function projectConfigUI(){
  const $=id=>document.getElementById(id)
  const globalButton=document.createElement('button')
  globalButton.textContent='⚙ 全局助手配置'
  document.querySelector('.nav').prepend(globalButton)
  globalButton.onclick=async()=>{
    try{
      const config=await api('/api/enterprise/global-config')
      openDrawer('全局助手配置','<div class="pc-shell"><div class="org-notice">作用于全部企业、全部飞书应用、全部项目以及普通聊天。全局规则优先于项目提示词、Soul 和行为边界；项目配置作为补充。保存后从后续提问生效，已提交任务不变，无需重启。</div><label class="org-field"><span>顶层提示词（最多 30,000 字符）</span><textarea id="globalPrompt" class="org-textarea pc-editor" maxlength="30000" placeholder="填写所有需求助手都必须遵守的身份、原则、行为要求和工作规范。"></textarea></label><p class="pc-note">留空表示不附加顶层规则，原有项目配置和默认提示词继续保留。文字规则由模型遵循，不能替代程序权限控制。</p><div class="pc-footer"><button id="globalSave" class="org-primary">保存全局配置</button><span id="globalStatus" role="status" class="pc-status"></span></div></div>')
      $('globalPrompt').value=config.prompt
      $('globalStatus').textContent=config.updatedAt?'上次修改：'+fmt(config.updatedAt)+(config.updatedBy?' · '+config.updatedBy:''):'尚未设置顶层提示词'
      const input=$('globalPrompt'),save=$('globalSave'),status=$('globalStatus')
      const importTools=document.createElement('div')
      importTools.innerHTML='<input type="file" accept=".md,.txt" hidden><button type="button" class="refresh">导入提示词文档（MD / TXT）</button><p class="pc-note">UTF-8 文本，最多 30,000 字符。导入替换下方编辑草稿，检查后点击“保存全局配置”才生效；不会自动拼接多份指令。</p>'
      input.parentElement.before(importTools)
      const picker=importTools.querySelector('input')
      importTools.querySelector('button').onclick=()=>picker.click()
      picker.onchange=async()=>{
        const file=picker.files[0];if(!file)return
        try{
          if(!/\.(md|txt)$/i.test(file.name)||!file.size||file.size>120000)throw new Error('提示词仅支持非空 MD / TXT，最多 30,000 字符')
          const content=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()).replace(/^\uFEFF/,'')
          if(!content.trim()||content.length>30000||content.includes('\u0000'))throw new Error('内容为空、含无效字符或超过 30,000 字符，未导入')
          if(input.value.trim()&&!confirm('导入将替换当前编辑草稿，保存后才影响全部应用。是否继续？'))return
          input.value=content;status.textContent='已导入 '+file.name+'，请检查后保存'
        }catch(e){status.textContent=e.message}finally{picker.value=''}
      }
      const materialHost=document.createElement('section')
      materialHost.style.marginTop='28px';input.closest('.pc-shell').append(materialHost)
      window.mountGlobalMaterials(materialHost)
      save.onclick=async()=>{
        save.disabled=true;status.textContent='正在保存…'
        try{
          const result=await api('/api/enterprise/global-config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:input.value,version:config.version})})
          config.version=result.version;status.textContent='已保存 · 全部应用后续提问生效'
        }catch(e){status.textContent=e.message}finally{save.disabled=false}
      }
    }catch(e){showError(e)}
  }
  window.openProjectConfiguration=async function(id){
    try{
      const p=await api('/api/enterprise/project-config/'+encodeURIComponent(id))
      const base='/api/enterprise/materials/'+encodeURIComponent(id)
      const editor=(label,id,value,placeholder,max)=>'<label class="org-field"><span>'+esc(label)+'</span><textarea id="'+id+'" class="org-textarea pc-editor" maxlength="'+max+'" placeholder="'+esc(placeholder)+'">'+esc(value)+'</textarea></label>'
      openDrawer('项目配置 · '+p.name,'<div class="pc-shell"><div class="org-notice">本配置仅用于「'+esc(p.name)+'」。保存后从后续提问开始加载，已提交任务使用提交时的配置；普通聊天不会读取这里的配置和资料。</div><div class="pc-tabs" role="tablist">'+[['soul','Soul'],['prompt','提示词'],['boundaries','行为边界'],['materials','背景资料']].map(([key,name],i)=>'<button type="button" role="tab" aria-selected="'+(!i)+'" class="'+(!i?'active':'')+'" data-pc-tab="'+key+'">'+name+'</button>').join('')+'</div>'
      +'<section class="pc-pane active" data-pc-pane="soul"><p class="pc-note">定义助手是谁、坚持什么原则，以及怎样与用户沟通。留空沿用原有角色设定。</p>'+editor('Soul · 人格与核心原则','pcSoul',p.soul,'例如：你是严谨、坦诚的需求顾问。尊重事实，主动澄清不确定性，帮助用户形成可执行的需求。',20000)+'</section>'
      +'<section class="pc-pane" data-pc-pane="prompt"><p class="pc-note">定义职责、步骤和输出格式。填写后优先使用本配置；留空继续使用原有文件或全局提示词。</p>'+editor('项目提示词','pcPrompt',p.prompt,'例如：先确认目标和使用者，再梳理流程、功能、异常场景和验收标准。',20000)+'<details><summary>查看当前兼容提示词（只读）</summary><pre class="pc-preview">'+esc(p.inheritedPrompt||'未配置')+'</pre></details></section>'
      +'<section class="pc-pane" data-pc-pane="boundaries"><p class="pc-note">填写允许、禁止以及需要先确认的事项。行为边界优先于项目人格和工作提示词；资料内容不能改变这些规则。文字约束由模型遵循，跨项目资料访问由程序隔离。</p>'+editor('行为边界','pcBoundaries',p.boundaries,'例如：未经用户确认，不将讨论当成最终需求；资料不足时先提问；不得读取或引用其他项目的资料。',20000)+'</section>'
      +'<section class="pc-pane" data-pc-pane="materials"><p class="pc-note">上传项目背景、术语和业务规范。支持 TXT、MD、CSV、TSV、JSON、PDF、DOCX、XLSX，单文件最大 50 MB。文件上传后立即生效，适用于本项目所有已授权成员。</p>'+(p.legacyMaterials?'<div class="org-notice">此项目已有资料目录，继续兼容读取。这里上传的文件是新增资料，不会覆盖旧目录。</div>':'')+'<div class="project-actions"><input id="pcUploadFile" type="file" accept=".txt,.md,.csv,.tsv,.json,.pdf,.docx,.xlsx" hidden><button id="pcUpload" class="org-primary" type="button">＋ 上传背景资料</button><span id="pcUploadStatus" class="pc-status" role="status"></span></div><div id="pcFiles"></div>'+editor('补充共享文本','pcNotes',p.sharedNotes,'可以在这里补充背景、术语或业务规则。',30000)+'</section>'
      +'<div class="pc-footer"><button id="pcSave" type="button" class="org-primary">保存配置</button><span id="pcSaveStatus" class="pc-status" role="status">'+(p.updatedAt?'上次修改：'+fmt(p.updatedAt):'尚未保存独立配置')+'</span></div></div>')
      for(const [field,label,max] of [['pcSoul','Soul',20000],['pcPrompt','提示词',20000],['pcBoundaries','行为边界',20000],['pcNotes','共享文本',30000]]){
        window.mountConfigurationImport($(field),label,max)
      }
      document.querySelectorAll('[data-pc-tab]').forEach(b=>b.onclick=()=>{
        document.querySelectorAll('[data-pc-tab]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-selected',String(x===b))})
        document.querySelectorAll('[data-pc-pane]').forEach(x=>x.classList.toggle('active',x.dataset.pcPane===b.dataset.pcTab))
      })
      $('pcSave').onclick=async()=>{
        $('pcSave').disabled=true;$('pcSaveStatus').textContent='正在保存…'
        try{const r=await api('/api/enterprise/project-config/'+encodeURIComponent(id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:p.version,soul:$('pcSoul').value,prompt:$('pcPrompt').value,boundaries:$('pcBoundaries').value,sharedNotes:$('pcNotes').value})});p.version=r.version;$('pcSaveStatus').textContent='已保存 · 后续提问生效 · '+fmt(Date.now())}
        catch(e){$('pcSaveStatus').textContent=e.message}finally{if($('pcSave'))$('pcSave').disabled=false}
      }
      let replacement=null,busy=false
      const refreshFiles=async()=>{
        const result=await api(base)
        if(!$('pcFiles'))return
        $('pcFiles').innerHTML=result.files.length?result.files.map(f=>'<div class="pc-file"><div class="pc-file-head"><strong>'+esc(f.name)+'</strong><span class="badge '+(f.enabled?'ok':'warn')+'">'+(f.enabled?'已启用':'已停用')+'</span></div><div class="small">'+size(f.sizeBytes)+' · 上传于 '+fmt(f.createdAt)+(f.replacesId?' · 更新版本':'')+'</div><div class="pc-file-actions"><button type="button" class="refresh" data-pc-preview="'+f.id+'">查看预览</button><a class="file-link" href="'+base+'/'+f.id+'/download">下载原文件</a><button type="button" class="refresh" data-pc-replace="'+f.id+'">上传新版本</button><button type="button" class="refresh" data-pc-toggle="'+f.id+'" data-enabled="'+f.enabled+'">'+(f.enabled?'停用':'启用')+'</button></div><div id="preview-'+f.id+'"></div></div>').join(''):'<div class="pc-empty">暂未上传背景资料</div>'
        document.querySelectorAll('[data-pc-preview]').forEach(b=>b.onclick=async()=>{
          try{const f=await api(base+'/'+b.dataset.pcPreview);const target=$('preview-'+f.id);target.innerHTML='<p class="pc-note" style="margin-top:14px">有限解析预览，不代表已读取全文。扫描 PDF 可在项目对话中使用视觉资料工具。</p><pre class="pc-preview"></pre>';target.querySelector('pre').textContent=f.excerpt}catch(e){$('pcUploadStatus').textContent=e.message}
        })
        document.querySelectorAll('[data-pc-replace]').forEach(b=>b.onclick=()=>{if(busy)return;replacement=b.dataset.pcReplace;$('pcUploadFile').click()})
        document.querySelectorAll('[data-pc-toggle]').forEach(b=>b.onclick=async()=>{
          if(busy)return;b.disabled=true
          try{await api(base+'/'+b.dataset.pcToggle+'/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:b.dataset.enabled!=='true'})});await refreshFiles();$('pcUploadStatus').textContent='文件状态已更新。停用不删除文件，也不清除历史对话。'}catch(e){$('pcUploadStatus').textContent=e.message;b.disabled=false}
        })
      }
      $('pcUpload').onclick=()=>{replacement=null;$('pcUploadFile').click()}
      $('pcUploadFile').onchange=async event=>{
        const file=event.target.files[0];if(!file||busy)return
        if(!file.size||file.size>50*1024*1024){$('pcUploadStatus').textContent='请选择不超过 50 MB 的非空文件';event.target.value='';return}
        busy=true;$('pcUpload').disabled=true;$('pcUploadStatus').textContent='正在上传并解析…'
        try{await api(base+'?name='+encodeURIComponent(file.name)+(replacement?'&replacesId='+replacement:''),{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});await refreshFiles();$('pcUploadStatus').textContent='上传成功，已供后续项目对话使用。更新前的版本仍保留。'}catch(e){$('pcUploadStatus').textContent=e.message}
        finally{busy=false;replacement=null;if($('pcUpload'))$('pcUpload').disabled=false;event.target.value=''}
      }
      await refreshFiles()
    }catch(e){showError(e)}
  }
}
