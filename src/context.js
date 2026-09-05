// 系统提示词组装：全局提示词 + 项目专属提示词（项目资料/<项目名>/提示词.md）+ 项目文档注入
// 项目资料目录：D:\Workspace\需求助手\项目资料\<项目名>\
//   - 提示词.md       本项目专属提示词（可选；存在则覆盖全局/配置里的项目提示词）
//   - 其他 .md/.txt   全部自动注入本项目对话的系统提示词（合计约 30KB 上限）
// 每次回答都会重新读取 → 改文件即时生效，无需重启。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_CONTEXT_BYTES = 30 * 1024 // 上下文注入上限（约 30KB）
export const PROMPT_FILE = '提示词.md'

/** 某项目的资料目录（按项目名，非哈希 id）。 */
export function projectMaterialsDir(root, project) {
  return join(root, '项目资料', project.name)
}

/** 读一个文件；不存在或超限时按规则返回。 */
function readIfExists(file, maxBytes) {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      return raw.slice(0, maxBytes) + '\n\n（内容超限已截断）'
    }
    return raw.trim() ? raw : null
  } catch {
    return null
  }
}

/** 项目专属提示词：项目资料/<名称>/提示词.md（存在则返回其内容）。 */
export function resolveProjectPrompt(root, project) {
  if (!project) return null
  return readIfExists(join(projectMaterialsDir(root, project), PROMPT_FILE), MAX_CONTEXT_BYTES)
}

/** 项目资料注入：目录下除 提示词.md 外的所有 .md/.txt，按文件名排序拼接（合计上限 30KB）。 */
export function readProjectDocs(root, project) {
  const dir = projectMaterialsDir(root, project)
  if (!existsSync(dir)) return ''
  let names = []
  try {
    names = readdirSync(dir)
      .filter(n => n !== PROMPT_FILE && /\.(md|txt)$/i.test(n) && statSync(join(dir, n)).isFile())
  } catch {
    return ''
  }
  names.sort()
  let total = 0
  const parts = []
  for (const name of names) {
    const text = readIfExists(join(dir, name), MAX_CONTEXT_BYTES - total)
    if (!text) continue
    parts.push('## ' + name + '\n' + text)
    total += Buffer.byteLength(text, 'utf8') + 64
    if (total >= MAX_CONTEXT_BYTES) break
  }
  return parts.join('\n\n')
}

/**
 * 组装某项目会话的系统提示词。
 * 优先级：项目资料/<名称>/提示词.md > config.json 项目 prompt > 全局 systemPrompt；
 * 随后注入：全局 AGENTS.md（历史压缩上下文）→ 项目资料文档。
 */
export async function buildSystemPrompt(opts) {
  const { root, assistantConfig, project } = opts
  const sections = []
  const fromFile = project ? resolveProjectPrompt(root, project) : null
  const base = fromFile ?? project?.prompt ?? assistantConfig.systemPrompt
  if (base) sections.push(base)

  const global = readIfExists(join(root, 'AGENTS.md'), MAX_CONTEXT_BYTES)
  if (global) sections.push('## 项目全局上下文\n' + global)

  if (project) {
    const docs = readProjectDocs(root, project)
    if (docs) sections.push('## 本项目资料（' + project.name + '）\n' + docs)
  }

  return sections.join('\n\n')
}

/** 兼容别名：项目资料目录。 */
export function projectContextDir(root, project) {
  return projectMaterialsDir(root, project)
}

/** 初始化某项目的资料目录（/project new 时调用）：生成 提示词.md 与 项目文档.md 模板。 */
export async function ensureProjectDir(root, project) {
  const { mkdir, writeFile, access } = await import('node:fs/promises')
  const dir = projectMaterialsDir(root, project)
  try {
    await mkdir(dir, { recursive: true })
    const promptFile = join(dir, PROMPT_FILE)
    const docsFile = join(dir, '项目文档.md')
    try {
      await access(promptFile)
    } catch {
      await writeFile(promptFile,
        '# 项目「' + project.name + '」专属提示词\n\n'
        + '（可选：这里的内容将作为本项目专属提示词，覆盖全局提示词。留空则使用 config.json 的全局提示词。）\n',
        'utf8')
    }
    try {
      await access(docsFile)
    } catch {
      await writeFile(docsFile,
        '# 项目「' + project.name + '」文档\n\n'
        + '（把该项目的需求文档、背景资料、术语、决策记录写在这里；\n'
        + '本目录下所有 .md/.txt 文件会自动注入本项目对话的系统提示词，合计上限约 30KB。\n'
        + '其他格式（docx/pdf 等）请转成文本或 md 后放入。）\n',
        'utf8')
    }
  } catch (err) {
    console.warn('[context] 项目资料目录初始化失败:', err?.message ?? err)
  }
}
