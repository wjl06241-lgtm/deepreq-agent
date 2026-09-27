import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { DocumentLibrary } from '../src/documents.js'
import { TaskStore } from '../src/tasks.js'
import { AssistantRuntime } from '../src/runtime.js'
import { MemoryStore } from '../src/memory.js'
import { JsonlStore } from '../src/store.js'
import { isAnswered } from '../src/monitor.js'
import { buildSystemPrompt } from '../src/context.js'
import { dashboardHtml } from '../src/dashboard.js'
import { lockRuntime } from '../src/instance-lock.js'
import { ProjectRegistry } from '../src/projects.js'
import { sendToChat, sendFileToChat } from '../src/feishu.js'

new Function(dashboardHtml().match(/<script>([\s\S]*?)<\/script>/)[1])
assert.throws(() => new ProjectRegistry('unused').create('../../secret'))
const sent=[]
const api={im:{message:{create:async x=>{sent.push(x);return {code:0}}},file:{create:async x=>{x.data.file.destroy();return {code:0,data:{file_key:'f'}}}}}}
await sendToChat(api,'chat','hello',{uuid:'stable'})
await sendToChat(api,'chat','hello',{uuid:'stable'})
assert.equal(sent[0].data.uuid,sent[1].data.uuid)
await assert.rejects(sendToChat({im:{message:{create:async()=>({code:999,msg:'denied'})}}},'c','hello'),/飞书发送失败/)

const dir = await mkdtemp(join(tmpdir(), 'req-codex-tests-'))
const root = join(dir,'materials'); await mkdir(join(root,'nested'),{recursive:true})
await writeFile(join(root,'nested','资料.md'),'第一行\n第二行\n第三行')
const library = await new DocumentLibrary(dir).init()
const catalog = await library.catalog('a',root)
assert.equal(catalog.size,1)
const entry = [...catalog.values()][0]
const result = await library.read(entry,{start:2,count:1})
assert.equal(result.lines[0].text,'第二行'); assert.equal(result.next,3)
await assert.rejects(library.checked(undefined))
const outside = join(dir,'outside.txt'); await writeFile(outside,'private')
await library.register('other',outside,'outside.txt')
assert.equal((await library.catalog('a',root)).size,1)
await assert.rejects(library.checked({...entry,file:outside,root}))
await assert.rejects(library.read(entry,{start:-1}))
const wb = new ExcelJS.Workbook(), sheet = wb.addWorksheet('字段表')
sheet.addRow(['字段','值']); sheet.getCell('B2').value={formula:'1+2',result:3}; sheet.getCell('A2').value='年龄'
const xlsx = join(root,'字段.xlsx'); await wb.xlsx.writeFile(xlsx)
const xe = await library.register('a',xlsx,'字段.xlsx')
const xr = await library.read(xe,{sheet:'字段表',start:2,count:1})
assert.equal(xr.rows[0].cells[1].address,'B2'); assert.equal(xr.rows[0].cells[1].value.formula,'1+2')
// Generate a minimal real DOCX with headings and a table using ExcelJS's ZIP dependency.
const JSZip = (await import('jszip')).default, zip = new JSZip()
zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题示例</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格示例</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
const docx = join(root,'文档.docx'); await writeFile(docx,await zip.generateAsync({type:'nodebuffer'}))
const de = await library.register('a',docx,'文档.docx'), dr = await library.read(de)
assert.match(JSON.stringify(dr),/表格示例/); assert.match(JSON.stringify(dr),/<table>/)
const pe = await library.register('a',join(import.meta.dirname,'fixtures','dummy.pdf'),'样例.pdf')
const pr = await library.read(pe,{count:1}); assert.equal(pr.pages[0].page,1); assert.match(pr.pages[0].text,/dummy/i)
const pi = await library.image(pe,1); assert.match(pi.contentItems[1].imageUrl,/^data:image\/png;base64,/)
const tools = await library.tools('a',root,'test-artifact')
await tools.call('deliver_document',{name:'审阅.md',content:'# 审阅\n内容'})
assert.equal(tools.artifacts.length,1); assert.match(await readFile(tools.artifacts[0].file,'utf8'),/审阅/)
await sendFileToChat(api,'chat',tools.artifacts[0],{uuid:'stable-file'})
assert.equal(JSON.parse(sent.at(-1).data.content).file_key,'f')
const workerRead=await tools.call('materials_read',{id:entry.id,start:1,count:1})
assert.match(workerRead.contentItems[0].text,/第一行/)
const prompt = await buildSystemPrompt({root:dir,assistantConfig:{systemPrompt:'角色',projects:{}},project:{name:'test',contextDir:root},indexOnly:true})
assert.match(prompt,/materials_list/)

const tasks = await new TaskStore(join(dir,'task-tests')).init()
const msg = {chatId:'c',msgId:'m',text:'test'}
const claims = await Promise.all([tasks.claim(msg,'p'),tasks.claim(msg,'p')]); assert.equal(claims.filter(Boolean).length,1)
const restarted = await new TaskStore(join(dir,'task-tests')).init()
assert.equal(restarted.get(claims[0].id).status,'interrupted'); assert.equal(await restarted.claim(msg,'p'),null)
assert.equal(isAnswered({id:'q',taskId:'q',chatId:'c',ts:1},[{kind:'assistant_message',chatId:'c',ts:2,taskId:'other',refId:'other'}]),false)

const runtimeDir = join(dir,'runtime'), store = new JsonlStore(runtimeDir), memory = new MemoryStore(join(runtimeDir,'memory'))
await store.init(); await memory.init()
let runs=0, failSend=true, release
const codexBackend = {reset:async()=>{},close:()=>{}, run:async({text,signal})=>{
  runs++
  if(text.endsWith('slow')) await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})
  return {text:'ANSWER',usage:null}
}}
const rt = new AssistantRuntime({cfg:{dataDir:runtimeDir,codex:{}},store,memory,codexBackend,
  sendReply:async(c,text)=>{if(text==='ANSWER'&&failSend)throw new Error('offline')},sendFile:async()=>{}})
await rt.submit({chatId:'c',msgId:'1',text:'hello',userId:'u'},null,'SYS','codex')
assert.equal(runs,1); assert.equal(rt.tasks.list()[0].status,'completed'); assert.equal(rt.tasks.list()[0].delivery,'failed')
await assert.rejects(lockRuntime(runtimeDir), /已有需求助手/)
failSend=false; await rt.control({chatId:'c',userId:'u'},'task',['resend'],'')
assert.equal(runs,1); assert.equal(rt.tasks.list()[0].delivery,'sent')
await rt.submit({chatId:'c',msgId:'1',text:'hello',userId:'u'},null,'SYS','codex'); assert.equal(runs,1)
const slow = rt.submit({chatId:'c',msgId:'2',text:'slow',userId:'u'},null,'SYS','codex')
const waitUntil=async(test)=>{const until=Date.now()+3000;while(!test()){if(Date.now()>until)throw new Error('test wait timeout');await new Promise(r=>setTimeout(r,5))}}
await waitUntil(()=>release)
await rt.control({chatId:'c',userId:'u'},'cancel',[],''); await slow
assert.equal(rt.tasks.list()[0].status,'cancelled')
const sequence=[];let unblock
codexBackend.run=async({text})=>{sequence.push(text.endsWith('first')?'first':'second');if(text.endsWith('first'))await new Promise(r=>{unblock=r});return {text:'ANSWER'}}
const first=rt.submit({chatId:'c',msgId:'3',text:'first',userId:'u'},null,'SYS','codex')
await waitUntil(()=>unblock)
const second=rt.submit({chatId:'c',msgId:'4',text:'second',userId:'u'},null,'SYS','codex')
await rt.admission
const queued=rt.tasks.list().find(t=>t.msgId==='4')
assert.equal(queued.status,'queued')
await rt.control({chatId:'c',userId:'someone-else'},'cancel',[queued.id],'')
assert.equal(queued.status,'queued')
await rt.control({chatId:'c',userId:'u'},'cancel',[queued.id],'')
unblock();await Promise.all([first,second])
assert.deepEqual(sequence,['first']);assert.equal(queued.status,'cancelled')
await rt.close(); await memory.dispose()
console.log('CODEX-TESTS-OK: documents, PDF rendering, isolation, persistence, dedup, resend, cancellation')
