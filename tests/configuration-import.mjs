import assert from 'node:assert/strict'
import {decodeConfigurationFile,mountConfigurationImport} from '../src/configuration-import.js'
import {projectConfigDashboard} from '../src/project-config-dashboard.js'
const bytes=s=>new TextEncoder().encode(s)
assert.equal(decodeConfigurationFile('Soul.MD',bytes('\uFEFF# 人格\n严谨坦诚'),20000),'# 人格\n严谨坦诚')
assert.equal(decodeConfigurationFile('边界.txt',bytes('a'.repeat(20000)),20000).length,20000)
for(const [name,data] of [['bad.pdf',bytes('text')],['empty.md',bytes('  ')],['null.txt',bytes('a\0')],['long.md',bytes('a'.repeat(20001))],['gbk.txt',new Uint8Array([0xff,0xfe])]])assert.throws(()=>decodeConfigurationFile(name,data,20000))
class Element{
  value='';children=[];isConnected=true;files=[]
  append(...nodes){this.children.push(...nodes)}
  setAttribute(){}
  before(node){this.inserted=node}
  click(){this.clicked=true}
}
globalThis.document={createElement:()=>new Element()}
let accept=true;globalThis.confirm=()=>accept
for(const [label,max] of [['Soul',20000],['提示词',20000],['行为边界',20000],['共享文本',30000]]){
  const input=new Element();input.parentElement=new Element();input.value='原有配置'
  mountConfigurationImport(input,label,max,decodeConfigurationFile)
  const [picker,button,note,status]=input.parentElement.inserted.children
  assert(button.textContent.includes(label));assert(note.textContent.includes('保存配置后'))
  picker.files=[{name:'test.md',size:6,arrayBuffer:async()=>bytes('新内容').buffer}]
  accept=false;await picker.onchange();assert.equal(input.value,'原有配置')
  accept=true;await picker.onchange();assert.equal(input.value,'新内容');assert(status.textContent.includes('尚未保存'))
  picker.files=[{name:'bad.pdf',size:4,arrayBuffer:async()=>bytes('bad').buffer}]
  await picker.onchange();assert.equal(input.value,'新内容');assert.equal(button.disabled,false)
}
const html=projectConfigDashboard()
for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Function(m[1])
console.log('CONFIGURATION-IMPORT-OK: all four fields, UTF-8, boundary, invalid format, cancel preservation, draft-only import, generated script syntax')
