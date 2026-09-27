// Kept self-contained so the same validation runs in the browser and tests.
export function decodeConfigurationFile(name,bytes,maxChars){
  if(!/\.(md|txt)$/i.test(name))throw new Error('配置文档仅支持 MD / TXT，请将其他格式导出为 UTF-8 文本')
  if(!Number.isInteger(maxChars)||maxChars<=0)throw new Error('配置长度上限无效')
  if(!bytes.byteLength||bytes.byteLength>maxChars*4)throw new Error('文件为空或超过 '+maxChars.toLocaleString()+' 字符限制，未导入')
  let text
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'')}catch{throw new Error('文件不是有效的 UTF-8 文本，请转换编码后重试')}
  if(!text.trim()||text.length>maxChars||text.includes('\u0000'))throw new Error('内容为空、含无效字符或超过 '+maxChars.toLocaleString()+' 字符，未导入')
  return text
}

export function mountConfigurationImport(input,label,maxChars,decode){
  const host=document.createElement('div')
  host.className='pc-import'
  const picker=document.createElement('input');picker.type='file';picker.accept='.md,.txt';picker.hidden=true
  const button=document.createElement('button');button.type='button';button.className='refresh';button.textContent='上传 / 导入'+label+'文档（MD / TXT）'
  const note=document.createElement('p');note.className='pc-note';note.textContent='UTF-8 文本，最多 '+maxChars.toLocaleString()+' 字符。导入到下方编辑框，检查并保存配置后才生效；原文件不会加入背景资料库。'
  const status=document.createElement('p');status.className='pc-status';status.setAttribute('role','status')
  host.append(picker,button,note,status);input.parentElement.before(host)
  button.onclick=()=>picker.click()
  picker.onchange=async()=>{
    const file=picker.files[0];if(!file)return
    const original=input.value
    button.disabled=true
    try{
      if(file.size>maxChars*4)throw new Error('文件超过配置文本限制，请精简后导入；大文件请上传至背景资料')
      const content=decode(file.name,await file.arrayBuffer(),maxChars)
      if(!host.isConnected)return
      if(input.value!==original)throw new Error('读取文件期间编辑内容已变化，请重新导入，未覆盖当前草稿')
      if(original.trim()&&!confirm('导入将替换当前'+label+'编辑草稿，保存后才生效。是否继续？')){status.textContent='已取消导入，原内容保留';return}
      input.value=content;status.textContent='已导入 '+file.name+'，尚未保存。请检查后点击“保存配置”。'
    }catch(e){status.textContent=e.message}finally{button.disabled=false;picker.value=''}
  }
}

export function configurationImportScript(){return `<script>window.mountConfigurationImport=(input,label,maxChars)=>(${mountConfigurationImport.toString()})(input,label,maxChars,${decodeConfigurationFile.toString()});</script>`}
