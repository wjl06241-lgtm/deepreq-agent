// 单元冒烟：node tests/smoke.mjs（不接网络、不启动服务）

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonlStore } from '../src/store.js'
import { ProjectRegistry } from '../src/projects.js'
import { MemoryStore } from '../src/memory.js'
import { buildMessages, splitLongText, detectImageMime } from '../src/llm.js'
import { buildSystemPrompt, projectContextDir } from '../src/context.js'
import { parseCommand } from '../src/commands.js'
import { isTextFile, buildFileMessageText, decodeTextBuffer, extractPdfText } from '../src/assistant.js'
import iconv from 'iconv-lite'
import { openQuestions, scanUnanswered, resolveQuestion, isAnswered } from '../src/monitor.js'
import { parseReceiveEvent } from '../src/feishu.js'
import { loadRuntimeConfig } from '../src/config.js'

let failed = 0
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name)
  if (!cond) failed += 1
}

// 命令解析
check('parse /project new', JSON.stringify(parseCommand('/project new 预约挂号')) === JSON.stringify({ name: 'project', args: ['new', '预约挂号'] }))
check('normal text is not command', parseCommand('你好，梳理需求') === null)

// 飞书事件解析
const evt = parseReceiveEvent({
  event: {
    message: { message_type: 'text', content: '{"text":"你好"}', chat_id: 'oc_x', message_id: 'om_1', chat_type: 'p2p' },
    sender: { sender_id: { open_id: 'ou_y' } },
  },
})
check('parse feishu event', evt && evt.chatId === 'oc_x' && evt.userId === 'ou_y' && evt.text === '你好')
check('empty-content image ignored', parseReceiveEvent({ event: { message: { message_type: 'image', content: '{}' } } }) === null)
// 图片/文件事件解析
const evtImg = parseReceiveEvent({ type: 'im.message.receive_v1', message: { message_type: 'image', content: '{"image_key":"img_abc"}', chat_id: 'oc_i', message_id: 'om_3', chat_type: 'p2p' }, sender: { sender_id: { open_id: 'ou_i' } } })
check('parse image event', evtImg && evtImg.kind === 'image' && evtImg.imageKey === 'img_abc')
const evtFile = parseReceiveEvent({ type: 'im.message.receive_v1', message: { message_type: 'file', content: '{"file_key":"file_xyz","file_name":"需求.txt"}', chat_id: 'oc_f', message_id: 'om_4', chat_type: 'p2p' }, sender: { sender_id: { open_id: 'ou_f' } } })
check('parse file event', evtFile && evtFile.kind === 'file' && evtFile.fileKey === 'file_xyz' && evtFile.fileName === '需求.txt')
// SDK 长连接模式把 event 解包到顶层（RequestHandle.parse 的 ...event）——回归用例
const evt2 = parseReceiveEvent({ type: 'im.message.receive_v1', message: { message_type: 'text', content: '{"text":"顶层消息"}', chat_id: 'oc_z', message_id: 'om_2', chat_type: 'p2p' }, sender: { sender_id: { open_id: 'ou_w' } } })
check('SDK-unwrapped event shape', evt2 && evt2.chatId === 'oc_z' && evt2.text === '顶层消息')

// 图片 MIME 识别
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const txt = Buffer.from('hello')
check('detectImageMime png/jpeg/other', detectImageMime(png) === 'image/png' && detectImageMime(jpg) === 'image/jpeg' && detectImageMime(txt) === null)

// 文本解码：UTF-8 直读 / GBK 回退
check('decodeTextBuffer utf8', decodeTextBuffer(Buffer.from('中文', 'utf8')) === '中文')
check('decodeTextBuffer gbk fallback', decodeTextBuffer(iconv.encode('中文', 'gbk')) === '中文')

// PDF 文本抽取（真实样例文件）
const pdfText = await extractPdfText(await (await import('node:fs/promises')).readFile(join(import.meta.dirname, 'fixtures', 'dummy.pdf')), 20000)
check('extractPdfText real pdf', typeof pdfText === 'string' && pdfText.length > 0 && /dummy/i.test(pdfText.slice(0, 400)))

// 附件文本判断与组装
check('isTextFile txt/md true', isTextFile('需求.txt') && isTextFile('a.MD') && !isTextFile('报告.pdf') && !isTextFile('x.xlsx'))
const fileMsg = buildFileMessageText('需求.txt', '内容123', 4)
check('buildFileMessageText', fileMsg.includes('【飞书上传文件：需求.txt】') && fileMsg.includes('截断'))

// llm helpers
check('buildMessages length/roles', buildMessages('SYS', [{ role: 'user', content: 'a' }], 'b').length === 3)
check('splitLongText chunks', splitLongText('x'.repeat(8000), 3500).length === 3)

// 记录 + 未回答检测
const dir = await mkdtemp(join(tmpdir(), 'req-assistant-test-'))
const store = new JsonlStore(dir)
await store.init()
const now = Date.now()
await store.append({ v: 1, id: 'q1', ts: now - 600000, kind: 'user_message', chatId: 'oc_1', project: 'p1', text: '项目A的问题没人回' })
await store.append({ v: 1, id: 'c1', ts: now - 599000, kind: 'user_message', chatId: 'oc_1', project: '', text: '/status' })
const open = await openQuestions(store, 60)
check('open detects unanswered, skips command', open.length === 1 && open[0].qid === 'q1')
let alerted = null
await scanUnanswered(store, 60, async (q) => { alerted = q.qid })
check('scan alerts once', alerted === 'q1')
await store.append({ v: 1, id: 'a1', ts: now - 1000, kind: 'assistant_message', chatId: 'oc_1', project: 'p1', text: '补回答' })
check('answered after reply', (await openQuestions(store, 60)).length === 0)
await store.append({ v: 1, id: 'q2', ts: now - 600000, kind: 'user_message', chatId: 'oc_1', project: 'p1', text: '再问一个' })
await resolveQuestion(store, 'q2', '线下处理')
check('resolved excluded', (await openQuestions(store, 60)).length === 0)
check('isAnswered same project', isAnswered({ chatId: 'x', project: 'p', ts: 1 }, [{ chatId: 'x', project: 'p', ts: 2, kind: 'assistant_message' }]))
check('isAnswered cross-project false', !isAnswered({ chatId: 'x', project: 'p', ts: 1 }, [{ chatId: 'x', project: 'q', ts: 2, kind: 'assistant_message' }]))

// 项目注册表
const reg = new ProjectRegistry(join(dir, 'projects.json'))
await reg.load()
const p = reg.create('预约挂号')
reg.setActive('oc_1', p.id)
check('project active', reg.activeFor('oc_1')?.name === '预约挂号')
await reg.dispose()
const reg2 = new ProjectRegistry(join(dir, 'projects.json'))
await reg2.load()
check('project persisted', reg2.activeFor('oc_1')?.id === p.id)
check('projectContextDir', projectContextDir('D:/root', p).endsWith(join('项目资料', p.name)))

// 会话记忆（按聊天+项目隔离、轮数裁剪）
const mem = new MemoryStore(join(dir, 'memory'), 2)
await mem.init()
await mem.push('oc_1', p.id, 'user', 'u1')
await mem.push('oc_1', p.id, 'assistant', 'a1')
await mem.push('oc_1', p.id, 'user', 'u2')
await mem.push('oc_1', p.id, 'assistant', 'a2')
await mem.push('oc_1', p.id, 'user', 'u3')
const hist = await mem.get('oc_1', p.id)
check('memory trimmed, pair-aligned', hist.length === 3 && hist[0].content === 'u2')
check('memory isolated per project', (await mem.get('oc_1', 'other')).length === 0)
await mem.clear('oc_1', p.id)
check('memory clear', (await mem.get('oc_1', p.id)).length === 0)
await mem.dispose()

// 系统提示词组装
const prompt = await buildSystemPrompt({
  root: dir,
  assistantConfig: { systemPrompt: '基础提示词', projects: {} },
  project: null,
})
check('system prompt base', prompt.includes('基础提示词'))

// 项目资料：提示词.md 覆盖全局 + 文档自动注入（按项目名的目录）
const { mkdirSync: mk2, writeFileSync: wf2 } = await import('node:fs')
const matDir = join(dir, '项目资料', p.name)
mk2(matDir, { recursive: true })
wf2(join(matDir, '提示词.md'), '项目专属提示词内容', 'utf8')
wf2(join(matDir, '项目文档.md'), '这是项目文档内容', 'utf8')
const prompt2 = await buildSystemPrompt({
  root: dir,
  assistantConfig: { systemPrompt: '基础提示词', projects: {} },
  project: p,
})
check('project prompt from 提示词.md overrides global', prompt2.includes('项目专属提示词内容') && !prompt2.includes('基础提示词'))
check('project docs injected', prompt2.includes('项目文档内容') && prompt2.includes('本项目资料'))

// 运行配置默认值
const cfg = loadRuntimeConfig({ dataDir: dir })
check('config defaults model/effort', cfg.llm.model === 'deepseek-v4-pro' && cfg.llm.reasoningEffort === 'max')
check('alertChats parse', loadRuntimeConfig({ dataDir: dir }).alertChats.length === 0)

await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? 'SMOKE-OK' : 'SMOKE-FAILED: ' + failed)
process.exit(failed === 0 ? 0 : 1)
