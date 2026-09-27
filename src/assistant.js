// 助手核心：消息处理与命令执行（与渠道无关）
// server.js（飞书）与 scripts/console-chat.mjs（本地终端模拟）共用同一套逻辑。

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadAssistantConfig, projectPromptOverride, projectModelOverride,
} from './config.js'
import { buildSystemPrompt, ensureProjectDir } from './context.js'
import { parseCommand, helpText } from './commands.js'
import { openQuestions } from './monitor.js'

import iconv from 'iconv-lite'
import { AssistantRuntime } from './runtime.js'
import { projectMaterialsDir } from './context.js'
import { actorKey, sessionKey, ownsTask } from './identity.js'
import { ProjectRouter } from './project-routing.js'

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

  const runtime = new AssistantRuntime(deps)
  const router = cfg.projectRouting?.enabled && projects.governed ? new ProjectRouter(cfg, deps.routeClassifier) : null
  const actorJobs = new Map()
  const serial = (msg, fn) => {
    const key = actorKey(msg)
    const job = (actorJobs.get(key) || Promise.resolve()).catch(() => {}).then(fn)
    actorJobs.set(key, job)
    job.finally(() => { if (actorJobs.get(key) === job) actorJobs.delete(key) }).catch(() => {})
    return job
  }

  const projectNames = () => {
    const map = {}
    for (const p of projects.list()) map[p.id] = p.name
    return map
  }

  /** 项目 + config.json 覆盖（提示词/模型/上下文目录）。 */
  const canAccessProject = (project, msg) => {
    if (!project) return false
    if (projects.governed) return !project.archived && project.enterpriseId === projects.enterprise?.id && project.memberOpenIds.includes(msg?.userId)
    const owners = loadAssistantConfig(configFile).projects[project.id]?.ownerOpenIds
    return !Array.isArray(owners) || owners.includes(msg?.userId)
  }
  const effectiveProject = (project, msg) => {
    if (!project) return null
    const ac = loadAssistantConfig(configFile)
    if (!canAccessProject(project, msg)) return null
    const prompt = project.prompt || projectPromptOverride(ac, project.id)
    const model = projectModelOverride(ac, project.id)
    const pc = ac.projects[project.id] ?? {}, contextDir = pc.contextDir || (projects.governed ? join(cfg.dataDir,'materials',project.id) : '')
    return { ...project, ...(prompt ? { prompt } : {}), ...(model ? { model } : {}),
      contextDir: projectMaterialsDir(root, { ...project, contextDir }), backend: pc.backend || cfg.backend,
      codex: pc.codex, promptFile: pc.promptFile, explicitPrompt: Boolean(project.prompt), includeHistory: pc.includeHistory === true && (!projects.governed || pc.ownerOpenIds?.includes(msg.userId)) }
  }

  const configuredProject = msg => msg.boundProjectId !== undefined
    ? projects.get(msg.boundProjectId)
    : projects.selectionFor(actorKey(msg)) !== undefined ? projects.get(projects.selectionFor(actorKey(msg))) : projects.activeFor(msg.chatId)
  const activeProject = msg => {
    const project = configuredProject(msg)
    return canAccessProject(project, msg) ? project : null
  }

  /** 处理一条入站消息：记录 → 命令或模型问答 → 回复。 */
  async function processMessage(msg, skipRouting = false) {
    const choice = /^确认归属\s*(\d+)\s*$/.exec(String(msg.text).trim())
    if (router && choice && !skipRouting) return confirmProject(msg, { index: Number(choice[1]) })
    const intentText = String(msg.text).trim().replace(/[。！？!?]+$/, '').trim()
    if (projects.governed) {
      if (/^(当前项目|查看当前项目|我(?:现在|当前)?(?:的)?(?:是)?(?:在|处于)哪个项目(?:下|里|中)?|我在哪个项目)$/.test(intentText)) {
        return runCommand(msg, { name: 'project', args: ['current'] })
      }
      const request = intentText.replace(/^(?:请)?(?:帮我|给我)?\s*/, '')
      // Match only explicit selection phrases and exact catalog names. Access is checked by runProjectCommand.
      const match = /^(?:选择|进入|切换到|切到)\s*(.+)$/.exec(request)
      if (match && !/^项目\s+/.test(match[1])) {
        const target = match[1].trim().replace(/^[“「"]|[”」"]$/g, '')
        const candidates = projects.list().filter(p => target === p.name || target === p.name + '项目')
        if (candidates.length === 1) return runCommand(msg, { name: 'project', args: ['use', candidates[0].id] })
      }
    }
    if (/^(返回普通聊天|普通聊天|退出项目)$/.test(String(msg.text).trim())) return runCommand(msg,{name:'project',args:['leave']})
    if (projects.governed && /^(切换项目|选择项目|项目列表)$/.test(String(msg.text).trim())) return runCommand(msg,{name:'project',args:['list']})
    if (projects.governed && /^选择项目\s+/.test(String(msg.text).trim())) return runCommand(msg,{name:'project',args:['use',String(msg.text).trim().replace(/^选择项目\s+/, '')]})
    const project = effectiveProject(activeProject(msg), msg)
    const cmd = parseCommand(msg.text)
    if (cmd) {
      if (cmd.name === 'cancel' || cmd.name === 'task') return runtime.control(msg, cmd.name, cmd.args, project?.id ?? '')
      if (cmd.name === 'new') {
        await runtime.ready
        const busy = runtime.tasks.list(msg.chatId, project?.id ?? '').some(t => ownsTask(msg, t) && ['queued','running'].includes(t.status))
        if (busy) return sendReply(msg.chatId, '请先 /cancel 取消当前任务，再 /new。')
        await runtime.codex.reset(sessionKey({ ...msg, projectId: project?.id ?? '' }))
        await store.resetConversation?.({ userId:msg.userId,chatId:msg.chatId,platform:msg.platform }, project?.id ?? '')
      }
      return runCommand(msg, cmd)
    }
    if (projects.governed && !project && (msg.boundProjectId ?? projects.selectionFor(actorKey(msg)))) return sendReply(msg.chatId,'当前项目已不可访问。请发送“返回普通聊天”，或“切换项目”选择已授权项目。')
    if (router && !skipRouting) {
      try {
        const history = await memory.get(actorKey(msg), project?.id ?? '')
        if (await router.suggest(msg, project?.id ?? '', projects.list().filter(p => canAccessProject(p, msg)), history, sendReply)) return
      } catch {
        if (!router.state.data.initialized?.[actorKey(msg)]) {
          return sendReply(msg.chatId, '首次聊天需要先选择范围。卡片暂时无法显示，请发送“普通聊天”，或发送“切换项目”查看可选项目。选择后请重发刚才的问题。')
        }
        log('项目归属建议暂不可用，本轮保持原范围回答。')
      }
    }
    const backend = project?.backend || cfg.backend || 'deepseek'
    if(project && backend !== 'codex' && deps.projectConfiguration){
      const files=await deps.projectConfiguration.list(project.id,true)
      project.uploadedNotes=files.map(f=>'文件：'+f.name+'\n'+f.excerpt).join('\n\n').slice(0,30000)
    }
    const systemPrompt = '当前可信聊天范围：' + JSON.stringify({ enterprise: projects.enterprise?.name || '', project: project?.name || '普通聊天' }) + '\n' + await buildSystemPrompt({ root, assistantConfig: loadAssistantConfig(configFile), project,
      globalPrompt: deps.projectConfiguration ? (await deps.projectConfiguration.global()).prompt : '',
      globalMaterials: Boolean(deps.projectConfiguration),
      globalNotes: deps.projectConfiguration && backend !== 'codex' ? (await deps.projectConfiguration.list(null,true)).map(f=>'文件：'+f.name+'\n'+f.excerpt).join('\n\n').slice(0,30000) : '',
      indexOnly: backend === 'codex', includeGlobalContext: !projects.governed || Boolean(project) })
    return runtime.submit(msg, project, systemPrompt, backend)
  }

  async function runCommand(msg, cmd) {
    const { name, args } = cmd
    const reply = (text) => sendReply(msg.chatId, text)

    if (name === 'whoami') return reply('姓名：' + (msg.userProfile?.name || msg.userName || '未获取') + '\n用户 ID：' + msg.userId + '\n信息状态：' + (msg.userProfile?.status === 'available' ? '已获取基本信息' : '暂未获取姓名，仍按用户 ID 独立会话') + '\n对话隔离：当前用户＋当前聊天＋当前项目')
    if (name === 'help') return reply(projects.governed ? '企业：'+(projects.enterprise?.name||'待配置')+'\n切换项目：发送“切换项目”或 /project\n选择项目：选择项目 <名称>\n/project current 查看当前项目\n/task status 查看任务\n/cancel 取消任务\n/new 开始当前项目的新会话\n/profile 查看本人资料\n项目及成员由管理员在后台配置；历史对话与附件按项目和本人隔离。' : helpText())
    if (name === 'new') {
      await memory.clear(actorKey(msg), activeProject(msg)?.id ?? '')
      return reply('🆕 已清空当前项目的对话记忆，开始新会话。')
    }
    if (name === 'status') {
      const proj = activeProject(msg)
      const open = (await openQuestions(store, cfg.unansweredTimeoutSec, runtime.tasks))
        .filter(q => q.userId === msg.userId && q.chatId === msg.chatId && q.project === (proj?.id ?? ''))
      return reply('📡 **状态**\n'
        + '· 后端: ' + (effectiveProject(proj,msg)?.backend || cfg.backend || 'deepseek') + '\n· 模型: ' + ((effectiveProject(proj,msg)?.backend || cfg.backend) === 'codex' ? (effectiveProject(proj,msg)?.codex?.model || cfg.codex.model || 'Codex 默认模型') : cfg.llm.model) + '\n'
        + '· 当前项目: ' + (proj ? proj.name + '（' + proj.id + '）' : '无（默认会话）') + '\n'
        + '· 项目总数: ' + projects.list().length + '\n'
        + '· 待处理未回答: ' + open.length)
    }
    if (name === 'project') {
      await runProjectCommand(msg, args, reply)
      return
    }
    if (name === 'prompt') {
      if (projects.governed) return reply('请由管理员在后台的企业与项目页面设置项目提示词。')
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

    if (sub === 'leave') {
      await router?.cancel(msg)
      projects.setActive(actorKey(msg),'')
      await projects.save()
      await store.selectProject?.(msg,{id:'',name:'普通聊天'})
      return reply('已返回普通聊天。项目记录保留，普通聊天不会读取项目资料；发送“切换项目”可重新进入已授权项目。')
    }

    if (sub === 'list' || (!sub && projects.governed)) {
      const list = projects.list().filter(p => canAccessProject(p,msg))
      if (!list.length) return reply('暂无已授权项目。可以直接进行普通聊天；如果之前选过项目，请发送“返回普通聊天”。项目由后台统一创建和分配。')
      const activeId = activeProject(msg)?.id ?? null
      const lines = ['📁 **'+(projects.enterprise?.name || '')+' 项目列表**（* = 当前项目）']
      for (const p of list) {
        const eff = effectiveProject(p,msg)
        const modelText = eff?.model?.model ? '（' + eff.model.model + '）' : '（默认模型）'
        lines.push((p.id === activeId ? '* ' : '  ') + p.id + ' ' + p.name + ' ' + modelText)
      }
      lines.push('', '回复“选择项目 项目名称”或 /project use <名称或id> 切换。发送“返回普通聊天”退出项目。项目由后台统一管理。')
      return reply(lines.join('\n'))
    }
    if (sub === 'current') {
      const p = activeProject(msg)
      if (!p) {
        const available = projects.list().filter(p => canAccessProject(p, msg)).map(p => p.name)
        return reply('当前范围：普通聊天，尚未进入具体项目。' + (available.length ? '\n可进入的项目：' + available.join('、') + '\n发送“选择项目 项目名称”进入。' : '\n目前没有已授权项目。'))
      }
      const eff = effectiveProject(p,msg)
      return reply('📁 当前项目：' + p.name + '（' + p.id + '）\n模型：' + (eff?.model?.model ?? cfg.llm.model))
    }
    if (sub === 'new') {
      return reply('项目由管理员在后台统一创建并分配，聊天中不支持自建项目。可以直接普通聊天，或发送“切换项目”查看已授权项目。')
    }
    if (sub === 'use') {
      const query = args.slice(1).join(' ').trim()
      if (!query) return reply('用法：/project use <名称或id>')
      const project = projects.find(query)
      if (project && !canAccessProject(project,msg)) return reply('ℹ️ 没有找到项目「' + query + '」。/project list 查看全部。')
      if (!project) return reply('ℹ️ 没有找到项目「' + query + '」。/project list 查看全部。')
      await router?.cancel(msg)
      const wasActive = activeProject(msg)?.id === project.id
      projects.setActive(actorKey(msg), project.id)
      await projects.save()
      await store.selectProject?.(msg, project)
      if (!projects.governed) await ensureProjectDir(root, project)
      return reply(wasActive
        ? '📁 已在项目「' + project.name + '」（' + project.id + '）。'
        : '📁 已切换到项目「' + project.name + '」（' + project.id + '）。之前的对话保留，切回来可继续。')
    }
    return reply('用法：\n/project use <名称|id>  切换已授权项目\n/project list          列出项目\n/project current       查看当前项目\n/project leave         返回普通聊天\n项目由后台统一创建和分配。')
  }

  async function confirmProject(msg, selection) {
    if (!router) return
    let chosen
    try { chosen = await router.choose(msg, selection, projects.list().filter(p => canAccessProject(p, msg))) }
    catch(e) { return sendReply(msg.chatId, e.message) }
    const p = chosen.projectId ? projects.get(chosen.projectId) : null
    projects.setActive(actorKey(msg), chosen.projectId)
    await projects.save()
    await store.selectProject?.(msg, p || { id: '', name: '普通聊天' })
    await sendReply(msg.chatId, '已选择：' + (p?.name || '普通聊天') + '。正在继续回答刚才的问题。')
    return processMessage({ ...chosen.msg, boundProjectId: chosen.projectId }, true)
  }

  return {
    processMessage: msg => /^\s*\/(cancel|task)\b/i.test(msg.text) ? processMessage(msg, true) : serial(msg, () => processMessage({ ...msg, boundProjectId: projects.selectionFor(actorKey(msg)) ?? msg.boundProjectId })),
    confirmProject: (msg, selection) => serial(msg, () => confirmProject(msg, selection)),
    ready: Promise.all([runtime.ready, router?.ready]),
    runtime,
    dispose: async () => { await router?.close(); await runtime.close(); await Promise.allSettled([...actorJobs.values()]) },
    projectFor: msg => effectiveProject(activeProject(msg),msg),
    backendFor: msg => effectiveProject(activeProject(msg),msg)?.backend || cfg.backend || 'deepseek',
    runCommand,
    projectNames,
    openQuestions: () => openQuestions(store, cfg.unansweredTimeoutSec, runtime.tasks),
  }
}
