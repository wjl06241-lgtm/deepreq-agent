// DeepSeek API 客户端（OpenAI 兼容 /chat/completions）
// 模型 deepseek-v4-pro + reasoning_effort max；baseUrl/key/model 全部可配。

const LLM_TIMEOUT_MS = 180000
const LLM_MAX_RETRIES = 2

/** 单次请求（不重试）。 */
async function requestOnce(opts) {
  const { baseUrl, apiKey, model } = opts
  const body = {
    model,
    messages: opts.messages,
    stream: false,
  }
  if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = opts.maxTokens
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort
  let res
  try {
    res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
  } catch (err) {
    // 网络层失败：给出具体原因（DNS/连接拒绝/超时等），便于排查代理与网络
    const code = err?.cause?.code ?? err?.code ?? ''
    const detail = err?.cause?.message ?? err?.message ?? String(err)
    const wrapped = new Error('LLM 网络请求失败' + (code ? '（' + code + '）' : '') + ': ' + detail.slice(0, 200))
    wrapped.networkError = true
    throw wrapped
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    const httpErr = new Error('LLM HTTP ' + res.status + ' ' + detail)
    httpErr.status = res.status
    throw httpErr
  }
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content ?? ''
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('LLM 返回内容为空：' + JSON.stringify(data?.choices?.[0]?.message ?? data).slice(0, 300))
  }
  return { text: text.trim(), usage: data.usage ?? null }
}

/**
 * 一次对话补全（网络类失败自动重试；认证/参数类错误立即抛出）。
 * @param {object} opts { baseUrl, apiKey, model, reasoningEffort?, maxTokens?, messages }
 * @returns {Promise<{text: string, usage: object|null}>}
 */
export async function chatCompletion(opts) {
  if (!opts.apiKey) throw new Error('DEEPSEEK_API_KEY 未配置')
  let lastErr
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      return await requestOnce(opts)
    } catch (err) {
      lastErr = err
      // 4xx（认证/参数）重试无意义，立即抛；网络类与 5xx 重试
      if (err.status >= 400 && err.status < 500) throw err
      if (!err.networkError && err.status >= 500 && attempt === LLM_MAX_RETRIES) throw err
      if (attempt < LLM_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000))
      }
    }
  }
  throw lastErr
}

/** 按文件头魔术字节识别图片 MIME（png/jpeg/gif/webp）。 */
export function detectImageMime(buffer) {
  const b = buffer
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

/**
 * 视觉模型调用（OpenAI 兼容 /chat/completions，content 携带 base64 图片）。
 * @param {object} opts { baseUrl, apiKey, model, imageDataUrl, prompt, maxTokens? }
 * @returns {Promise<{text: string, usage: object|null}>}
 */
export async function chatCompletionVision(opts) {
  const { baseUrl, apiKey, model } = opts
  if (!apiKey) throw new Error('视觉模型未配置 API Key（VISION_API_KEY 或 DEEPSEEK_API_KEY）')
  const body = {
    model,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: opts.prompt ?? '请描述这张图片的内容。' },
        { type: 'image_url', image_url: { url: opts.imageDataUrl } },
      ],
    }],
  }
  if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = opts.maxTokens
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error('视觉模型 HTTP ' + res.status + ' ' + detail)
  }
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content ?? ''
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('视觉模型返回内容为空')
  }
  return { text: text.trim(), usage: data.usage ?? null }
}

/** 组装请求消息（系统提示词 + 历史 + 本轮用户输入）。 */
export function buildMessages(systemPrompt, history, userText) {
  const messages = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  for (const h of history) messages.push({ role: h.role, content: h.content })
  messages.push({ role: 'user', content: userText })
  return messages
}

/** 把长文本切成飞书文本消息可发的大小（保守 3500 字符/条）。 */
export function splitLongText(text, maxChars = 3500) {
  const out = []
  let rest = String(text ?? '')
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut <= 0) cut = maxChars
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.trim()) out.push(rest)
  return out
}
