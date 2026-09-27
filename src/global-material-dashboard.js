export function globalMaterialDashboard(){return `<script>(${globalMaterialUI.toString()})();</script>`}
function globalMaterialUI(){
  window.mountGlobalMaterials=function(host){
    const base='/api/enterprise/global-materials'
    host.innerHTML='<h3>全局参考资料</h3><div class="org-notice">启用后供全部企业、全部项目和普通聊天读取。请勿上传任何项目的专属资料、患者隐私或凭据。这里的文件只作参考，不作为顶层指令；提示词文档请使用上方“导入提示词文档”。</div><p class="pc-note">支持 MD、TXT、PDF、DOCX、XLSX、CSV、TSV、JSON，单文件最多 50 MB。上传后立即启用；更新保留旧版本，停用不删除文件或清除已引用的历史内容。</p><input type="file" accept=".md,.txt,.pdf,.docx,.xlsx,.csv,.tsv,.json" hidden><button class="org-primary" type="button" data-upload>＋ 上传全局参考资料</button><span class="pc-status" role="status" data-status></span><div data-files></div>'
    const input=host.querySelector('input'),upload=host.querySelector('[data-upload]'),status=host.querySelector('[data-status]'),list=host.querySelector('[data-files]')
    let replacement=null,busy=false
    const refresh=async()=>{
      const {files}=await api(base)
      if(!host.isConnected)return
      list.innerHTML=files.length?files.map(f=>'<div class="pc-file"><div class="pc-file-head"><strong>'+esc(f.name)+'</strong><span class="badge">'+(f.enabled?'已启用':'已停用')+'</span></div><p class="small">'+size(f.sizeBytes)+' · '+fmt(f.createdAt)+(f.replacesId?' · 更新版本':'')+'</p><div class="pc-file-actions"><button class="refresh" data-preview="'+f.id+'">查看预览</button><a href="'+base+'/'+f.id+'/download">下载原文件</a><button class="refresh" data-replace="'+f.id+'">上传新版本</button><button class="refresh" data-toggle="'+f.id+'" data-enabled="'+f.enabled+'">'+(f.enabled?'停用':'启用')+'</button></div><div data-preview-box="'+f.id+'"></div></div>').join(''):'<div class="pc-empty">暂未上传全局参考资料</div>'
      list.querySelectorAll('[data-preview]').forEach(b=>b.onclick=async()=>{
        try{const f=await api(base+'/'+b.dataset.preview),box=list.querySelector('[data-preview-box="'+f.id+'"]');if(!box)return;box.innerHTML='<p class="pc-note">有限解析预览，不代表全文已被读取。</p><pre class="pc-preview"></pre>';box.querySelector('pre').textContent=f.excerpt}catch(e){status.textContent=e.message}
      })
      list.querySelectorAll('[data-replace]').forEach(b=>b.onclick=()=>{if(busy)return;replacement=b.dataset.replace;input.click()})
      list.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=async()=>{
        if(busy)return;busy=true;b.disabled=true
        try{await api(base+'/'+b.dataset.toggle+'/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:b.dataset.enabled!=='true'})});await refresh();status.textContent='已更新，全局资料状态立即生效'}catch(e){status.textContent=e.message;b.disabled=false}finally{busy=false}
      })
    }
    upload.onclick=()=>{if(busy)return;replacement=null;input.click()}
    input.onchange=async()=>{
      const file=input.files[0];if(!file||busy)return
      if(!file.size||file.size>50*1024*1024){status.textContent='请选择不超过 50 MB 的非空文件';input.value='';return}
      busy=true;upload.disabled=true;status.textContent='正在上传并解析…'
      try{await api(base+'?name='+encodeURIComponent(file.name)+(replacement?'&replacesId='+replacement:''),{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});await refresh();status.textContent='上传成功，已对全部应用启用'}catch(e){status.textContent=e.message}
      finally{busy=false;replacement=null;upload.disabled=false;input.value=''}
    }
    refresh().catch(e=>{status.textContent=e.message})
  }
}
