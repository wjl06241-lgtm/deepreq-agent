// 助手核心：消息处理与命令执行（与渠道无关）
// server.js（飞书）与 scripts/console-chat.mjs（本地终端模拟）共用同一套逻辑。

import { writeFileSync } from 'node:fs'
import {
  loadAssistantConfig, projectPromptOverride, projectModelOverride,
} from './config.js'
import { newRecordId } from './store.js'
import { chatCompletion, buildMessages } from './llm.js'
import { buildSystemPrompt, ensureProjectDir } from './context.js'
import { parseCommand, helpText } from './commands.js'
import { openQuestions } from './monitor.js'

import iconv from 'iconv-lite'

let unpdfMod = null

/**
 * 抽取 PDF 文本（pdfjs 引擎，经 unpdf 封装；扫描件/图片型 PDF 无文本层时返回空串）。
 * @param {Buffer} buf PDF 文件字节
 * @param {number} maxChars 文本截断上限
 * @returns {Promise<string>}
 */
export async function extractPdfText(buf, maxChars = 20000) {
  if (!unpdfMod) unpdfMod = await import('unpdf')
  const pdf = await unpdfMod.getDocumentProxy(new Uint8Array(buf))
  const { text } = await unpdfMod.extractText(pdf, { mergePages: true })
  const raw = String(text ?? '').replace(/\u0000/g, '').trim()
  if (!raw) return ''
  return raw.length > maxChars ? raw.slice(0, maxChars) + '\n\n（内容过长已截断，完整 PDF 在服务端 inbox 目录）' : raw
}

/** 文本文件解码：先按 UTF-8，出现替换符则回退 GBK（Windows 中文文件常见编码）。 */
export function decodeTextBuffer(buf) {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  const gbk = iconv.decode(buf, 'gbk')
  return gbk.includes('\uFFFD') ? utf8 : gbk
}

/** 文本类文件扩展名（可抽取内容进对话）。 */
const TEXT_FILE_RE = /\.(txt|md|markdown|csv|json|log|yml|yaml|sql|xml|html)$/i

/** 判断文件名是否属于可抽取文本的类型。 */
export function isTextFile(name) {
  return TEXT_FILE_RE.test(String(name ?? ''))
}

/** 把文件内容组装成给模型的用户消息文本（截断上限 20000 字符）。 */
export function buildFileMessageText(fileName, content, maxChars = 20000) {
  const raw = String(content ?? '')
  const clipped = raw.length > maxChars ? raw.slice(0, maxChars) + '\n\n（内容过长已截断，完整内容在服务端 inbox 目录）' : raw
  return '【飞书上传文件：' + fileName + '】\n内容如下：\n\n' + clipped
}

/**
 * 创建助手实例。
 * @param {object} deps { cfg, configFile, root, store, projects, memory, sendReply, alertAdmins, log }
 */
export function createAssistant(deps) {
  const { cfg, configFile, root, store, projects, memory, sendReply, alertAdmins, log } = deps

  const projectNames = () => {
    const map = {}
    for (const p of projects.list()) map[p.id] = p.name
    return map
  }

  /** 项目 + config.json 覆盖（提示词/模型/上下文目录）。 */
  const effectiveProject = (project) => {
    if (!project) return null
    const ac = loadAssistantConfig(configFile)
    const prompt = projectPromptOverride(ac, project.id)
    const model = projectModelOverride(ac, project.id)
    const contextDir = ac.projects[project.id]?.contextDir || ''
    return { ...project, ...(prompt ? { prompt } : {}), ...(model ? { model } : {}), contextDir }
  }

  /** 处理一条入站消息：记录 → 命令或模型问答 → 回复。 */
  async function processMessage(msg) {
    const project = projects.activeFor(msg.chatId)
    const projectId = project?.id ?? ''
    await store.append({
      v: 1, id: newRecordId(), ts: Date.now(), kind: 'user_message', platform: msg.platform ?? 'feishu',
      chatId: msg.chatId, userId: msg.userId ?? '', userName: msg.userName ?? '', project: projectId, text: msg.text,
    })

    const cmd = parseCommand(msg.text)
    if (cmd) {
      await runCommand(msg, cmd)
      return
    }

    const eff = effectiveProject(project)
    const history = await memory.get(msg.chatId, projectId)
    const systemPrompt = await buildSystemPrompt({
      root,
      assistantConfig: loadAssistantConfig(configFile),
      project: eff,
    })
    const llmOpts = {
      baseUrl: cfg.llm.baseUrl,
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      reasoningEffort: cfg.llm.reasoningEffort,
      maxTokens: cfg.llm.maxTokens,
      messages: buildMessages(systemPrompt, history, msg.text),
    }
    if (eff?.model) Object.assign(llmOpts, eff.model)

    try {
      const { text, usage } = await chatCompletion(llmOpts)
      await memory.push(msg.chatId, projectId, 'user', msg.text)
      await memory.push(msg.chatId, projectId, 'assistant', text)
      await store.append({
        v: 1, id: newRecordId(), ts: Date.now(), kind: 'assistant_message', platform: msg.platform ?? 'feishu',
        chatId: msg.chatId, userId: msg.userId ?? '', userName: msg.userName ?? '', project: projectId,
        text, usage,
      })
      await sendReply(msg.chatId, text)
    } catch (err) {
      const message = err?.message ?? String(err)
      await store.append({
        v: 1, id: newRecordId(), ts: Date.now(), kind: 'error', platform: msg.platform ?? 'feishu',
        chatId: msg.chatId, userId: msg.userId ?? '', userName: msg.userName ?? '', project: projectId,
        error: message.slice(0, 2000), text: msg.text,
      })
      await sendReply(msg.chatId, '❌ 出错了：' + message.slice(0, 300))
      await alertAdmins('❌ 需求助手回答失败\n'
        + '项目: ' + (project ? project.name : '默认会话') + '\n'
        + '会话: ' + msg.chatId + '\n'
        + '问题: ' + msg.text.slice(0, 100) + '\n'
        + '错误: ' + message.slice(0, 200))
    }
  }

  async function runCommand(msg, cmd) {
    const { name, args } = cmd
    const reply = (text) => sendReply(msg.chatId, text)

    if (name === 'help') return reply(helpText())
    if (name === 'new') {
      await memory.clear(msg.chatId, projects.activeFor(msg.chatId)?.id ?? '')
      return reply('🆕 已清空当前项目的对话记忆，开始新会话。')
    }
    if (name === 'status') {
      const proj = projects.activeFor(msg.chatId)
      const open = await openQuestions(store, cfg.unansweredTimeoutSec)
      return reply('📡 **状态**\n'
        + '· 模型: ' + cfg.llm.model + '（' + (cfg.llm.reasoningEffort || '默认推理') + '）\n'
        + '· 当前项目: ' + (proj ? proj.name + '（' + proj.id + '）' : '无（默认会话）') + '\n'
        + '· 项目总数: ' + projects.list().length + '\n'
        + '· 待处理未回答: ' + open.length)
    }
    if (name === 'project') {
      await runProjectCommand(msg, args, reply)
      return
    }
    if (name === 'prompt') {
      const sub = args[0] ?? ''
      if (sub === 'view') {
        const ac = loadAssistantConfig(configFile)
        return reply('📝 当前系统提示词（前 300 字）：\n' + ac.systemPrompt.slice(0, 300))
      }
      if (sub === 'set') {
        const text = args.slice(1).join(' ').trim()
        if (!text) return reply('用法：/prompt set <提示词文本>')
        const ac = loadAssistantConfig(configFile)
        writeFileSync(configFile, JSON.stringify({ ...ac, systemPrompt: text }, null, 2), 'utf8')
        return reply('✅ 系统提示词已更新（已写入 config.json，即时生效）。')
      }
      return reply('用法：/prompt view | /prompt set <文本>')
    }
    if (name === 'exit' || name === 'quit') return reply('👋 再见。')
    return reply('ℹ️ 未知命令 ' + name + '。发 /help 查看全部命令。')
  }

  async function runProjectCommand(msg, args, reply) {
    const sub = String(args[0] ?? '').toLowerCase()

    if (sub === 'list') {
      const list = projects.list()
      if (!list.length) return reply('📁 还没有项目。用 /project new <名称> 创建第一个项目。')
      const activeId = projects.activeFor(msg.chatId)?.id ?? null
      const lines = ['📁 **项目列表**（* = 当前聊天所用项目）']
      for (const p of list) {
        const eff = effectiveProject(p)
        const modelText = eff?.model?.model ? '（' + eff.model.model + '）' : '（默认模型）'
        lines.push((p.id === activeId ? '* ' : '  ') + p.id + ' ' + p.name + ' ' + modelText)
      }
      lines.push('', '切换：/project use <名称或id>')
      return reply(lines.join('\n'))
    }
    if (sub === 'current') {
      const p = projects.activeFor(msg.chatId)
      if (!p) return reply('ℹ️ 当前聊天未指定项目（默认会话）。用 /project use <名称> 切换。')
      const eff = effectiveProject(p)
      return reply('📁 当前项目：' + p.name + '（' + p.id + '）\n模型：' + (eff?.model?.model ?? cfg.llm.model))
    }
    if (sub === 'new') {
      const name = args.slice(1).join(' ').trim()
      if (!name) return reply('用法：/project new <项目名称>')
      const existing = projects.find(name)
      if (existing) {
        return reply('⚠️ 已存在同名项目 ' + existing.name + '（' + existing.id + '）。用 /project use ' + existing.name + ' 切换过去。')
      }
      const project = projects.create(name)
      projects.setActive(msg.chatId, project.id)
      await ensureProjectDir(root, project)
      return reply('📁 已创建并切换到项目「' + project.name + '」（' + project.id + '）。\n'
        + '每项目独立对话记忆、提示词与模型。\n'
        + '本项目资料目录：项目资料/' + project.name + '/（提示词.md 与文档自动生效）。')
    }
    if (sub === 'use') {
      const query = args.slice(1).join(' ').trim()
      if (!query) return reply('用法：/project use <名称或id>')
      const project = projects.find(query)
      if (!project) return reply('ℹ️ 没有找到项目「' + query + '」。/project list 查看全部。')
      const wasActive = projects.activeFor(msg.chatId)?.id === project.id
      projects.setActive(msg.chatId, project.id)
      await ensureProjectDir(root, project)
      return reply(wasActive
        ? '📁 已在项目「' + project.name + '」（' + project.id + '）。'
        : '📁 已切换到项目「' + project.name + '」（' + project.id + '）。之前的对话保留，切回来可继续。')
    }
    return reply('用法：\n/project new <名称>    新建项目并切换\n/project use <名称|id>  切换项目\n/project list          列出项目\n/project current       查看当前项目')
  }

  return {
    processMessage,
    runCommand,
    projectNames,
    openQuestions: () => openQuestions(store, cfg.unansweredTimeoutSec),
  }
}
