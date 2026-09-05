// 配置加载：环境变量/.env（凭据与运行参数）+ config.json（提示词、项目覆盖，热更新）

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 加载 .env（若存在；已设置的环境变量优先）。 */
export function loadEnvFile(file) {
  try {
    if (!existsSync(file)) return
    const raw = readFileSync(file, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m || line.trimStart().startsWith('#')) continue
      const key = m[1]
      if (process.env[key] === undefined) {
        process.env[key] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    // .env 不可读时忽略，环境变量仍可用
  }
}

/** 运行配置（环境变量快照 + 路径）。 */
export function loadRuntimeConfig(overrides = {}) {
  const env = process.env
  const dataDir = overrides.dataDir ?? env.DATA_DIR ?? join(ROOT, 'data')
  return {
    dataDir,
    feishu: {
      appId: env.FEISHU_APP_ID ?? '',
      appSecret: env.FEISHU_APP_SECRET ?? '',
    },
    llm: {
      apiKey: env.DEEPSEEK_API_KEY ?? '',
      baseUrl: (env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
      reasoningEffort: env.REASONING_EFFORT ?? 'max',
      maxTokens: Number(env.MAX_TOKENS ?? 8000) || 8000,
    },
    vision: {
      // 视觉模型（OpenAI 兼容格式）：填 VISION_MODEL 即启用图片识别；未填 = 图片仅落盘不识别
      baseUrl: (env.VISION_BASE_URL ?? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
      apiKey: env.VISION_API_KEY ?? env.DEEPSEEK_API_KEY ?? '',
      model: env.VISION_MODEL ?? '',
      prompt: env.VISION_PROMPT ?? '请描述这张图片的内容，并尽量完整地转录其中的文字（表格按行列输出）。',
      maxBytes: Number(env.VISION_MAX_BYTES ?? 10 * 1024 * 1024) || 10 * 1024 * 1024,
    },
    adminPort: Number(env.ADMIN_PORT ?? 3800) || 3800,
    // 看板监听地址：本机调试保持 127.0.0.1；部署公网服务器远程访问看板时设 0.0.0.0
    adminHost: env.ADMIN_HOST ?? '127.0.0.1',
    // 看板访问令牌：留空 = 不校验（仅本机访问时）；绑到公网务必设置
    adminToken: env.ADMIN_TOKEN ?? '',
    unansweredTimeoutSec: Number(env.UNANSWERED_TIMEOUT_SEC ?? 600) || 600,
    alertChats: (env.ALERT_CHATS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    maxHistoryTurns: Number(env.MAX_HISTORY_TURNS ?? 20) || 20,
  }
}

const DEFAULT_CONFIG = {
  // 系统提示词（模型回答的提示词，直接编辑本文件或飞书 /prompt set 修改，保存即生效）
  systemPrompt: '你是「需求助手」，一名专业的需求分析师，通过飞书与用户沟通软件需求。\n'
    + '你的职责：帮助用户梳理、澄清、记录软件需求，输出结构化需求说明（背景、目标、用户故事、功能点、验收标准）。\n'
    + '规则：需求含糊时先追问，不要臆造；回答用简体中文，简洁、结构化；不确定时列出待确认问题。',
  // 每项目覆盖：projects.<id>.prompt / model（覆盖全局），contextDir（覆盖上下文目录）
  projects: {},
}

/** 读取 config.json（每次调用重读 → 热更新）。 */
export function loadAssistantConfig(file) {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      systemPrompt: typeof parsed.systemPrompt === 'string' && parsed.systemPrompt
        ? parsed.systemPrompt
        : DEFAULT_CONFIG.systemPrompt,
      projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
    }
  } catch {
    return { ...DEFAULT_CONFIG, projects: {} }
  }
}

/** 项目级提示词覆盖（config.json → projects.<id>.prompt）。 */
export function projectPromptOverride(assistantConfig, projectId) {
  const p = assistantConfig.projects[projectId]
  return p && typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt.trim() : null
}

/** 项目级模型覆盖（config.json → projects.<id>.model {model, reasoningEffort, maxTokens}）。 */
export function projectModelOverride(assistantConfig, projectId) {
  const p = assistantConfig.projects[projectId]
  const m = p && p.model && typeof p.model === 'object' ? p.model : null
  if (!m) return null
  const out = {}
  if (typeof m.model === 'string' && m.model) out.model = m.model
  if (typeof m.reasoningEffort === 'string' && m.reasoningEffort) out.reasoningEffort = m.reasoningEffort
  if (Number(m.maxTokens) > 0) out.maxTokens = Number(m.maxTokens)
  return Object.keys(out).length > 0 ? out : null
}
