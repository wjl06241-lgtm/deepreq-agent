// 真实 API 冒烟：验证 deepseek-v4-pro + reasoning_effort=max（需 DEEPSEEK_API_KEY，可选 DEEPSEEK_BASE_URL/DEEPSEEK_MODEL）

import { chatCompletion } from '../src/llm.js'

const opts = {
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
  reasoningEffort: process.env.REASONING_EFFORT ?? 'max',
  maxTokens: 200,
  messages: [{ role: 'user', content: '用一句话介绍你自己。' }],
}
console.log('调用模型:', opts.model, '| reasoning_effort:', opts.reasoningEffort, '| baseUrl:', opts.baseUrl)
const { text, usage } = await chatCompletion(opts)
console.log('回复:', text.slice(0, 120))
console.log('usage:', JSON.stringify(usage))
console.log('LIVE-LLM-OK')
