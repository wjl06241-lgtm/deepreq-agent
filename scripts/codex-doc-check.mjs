import { mkdtemp, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { DocumentLibrary } from '../src/documents.js'
import { AtomicState } from '../src/state.js'
import { CodexBackend } from '../src/codex.js'
import { loadEnvFile, loadRuntimeConfig } from '../src/config.js'
loadEnvFile(join(import.meta.dirname,'..','.env'))
const cfg=loadRuntimeConfig(),dir=await mkdtemp(join(tmpdir(),'req-doc-live-'))
await copyFile(join(import.meta.dirname,'..','tests','fixtures','dummy.pdf'),join(dir,'sample.pdf'))
const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('测试表')
sheet.getCell('A1').value='REQ-DOC-318';await workbook.xlsx.writeFile(join(dir,'sample.xlsx'))
const library=await new DocumentLibrary(join(dir,'state')).init(),tools=await library.tools('check',dir,'check')
const seen=[];const call=tools.call;tools.call=async(name,args,signal)=>{seen.push(name);return call(name,args,signal)}
const sessions=await new AtomicState(join(dir,'sessions.json'),{}).init(),backend=new CodexBackend({...cfg.codex,timeoutMs:180000},sessions)
try{
  const result=await backend.run({key:'check',cwd:dir,systemPrompt:'测试预配置文档工具，不执行命令。',tools,
    text:'请先列出资料，读取 sample.xlsx 的测试表 A1，然后使用 materials_image 查看 sample.pdf 第1页。最后回复 A1 原文以及图片上的英文文字。必须实际调用这两个工具。'})
  assert(seen.includes('materials_read'));assert(seen.includes('materials_image'));assert.match(result.text,/REQ-DOC-318/)
  console.log('LIVE-DOCUMENTS-OK',JSON.stringify({tools:seen,answer:result.text}))
  const continued=await backend.run({key:'check',cwd:dir,systemPrompt:'测试持续对话。',tools,text:'上轮读到的A1是什么？只回复该值。'})
  assert.match(continued.text,/REQ-DOC-318/);console.log('LIVE-RESUME-OK')
}finally{backend.close()}
