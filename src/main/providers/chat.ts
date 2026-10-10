// OpenAI 兼容 /chat/completions:SSE 流式 + vision + tool calls

import type { ChatProfile } from '@shared/types'
import { ApiError, createIdleGuard, endpointUrl, gatewaySessionHeaders, readErrorMessage, sseDataChunks, withTimeout } from './http'

// ---------- LLM 消息结构 ----------

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LLMToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface LLMTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_calls?: LLMToolCall[]
  tool_call_id?: string
}

// ---------- 流式结果 ----------

export interface ChatStreamResult {
  content: string
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[]
  finishReason: string | null
}

interface ToolCallAcc {
  id: string
  name: string
  arguments: string
}

export async function chatCompletionStream(opts: {
  profile: ChatProfile
  messages: LLMMessage[]
  tools?: LLMTool[]
  timeoutMs: number
  signal?: AbortSignal
  sessionKey?: string
  onDelta?: (text: string) => void
  onReasoningDelta?: (text: string) => void
}): Promise<ChatStreamResult> {
  const { profile, messages, tools, timeoutMs, signal, onDelta } = opts
  if (!profile.baseUrl || !profile.model) throw new ApiError('对话服务配置不完整(缺 baseUrl 或模型名)')
  if (!profile.apiKey) throw new ApiError('对话服务未配置 API Key')

  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    stream: true
  }
  if (profile.maxOutputTokens) body.max_tokens = profile.maxOutputTokens
  // 思考模式与推理强度:仅在用户显式设置时发送(避免不兼容端点拒绝未知字段)
  if (profile.thinkingMode) body.thinking = { type: profile.thinkingMode }
  if (profile.reasoningEffort) body.reasoning_effort = profile.reasoningEffort
  if (tools?.length) body.tools = tools

  // 空闲超时:timeoutMs 内没有数据才中断(长回答不再被整请求 deadline 误杀)
  const guard = createIdleGuard(signal, timeoutMs)
  const res = await fetch(endpointUrl(profile.baseUrl, profile.chatPath, 'chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
      ...gatewaySessionHeaders(profile.baseUrl, opts.sessionKey ?? 'default')
    },
    body: JSON.stringify(body),
    signal: guard.signal
  })
  if (!res.ok) await readErrorMessage(res)

  let content = ''
  let finishReason: string | null = null
  const acc = new Map<number, ToolCallAcc>()

  for await (const data of sseDataChunks(res, guard.touch)) {
    if (data === '[DONE]') break
    let json: {
      choices?: {
        delta?: {
          content?: string | null
          reasoning_content?: string | null
          reasoning?: string | null
          tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        }
        finish_reason?: string | null
      }[]
    }
    try {
      json = JSON.parse(data)
    } catch {
      continue // 跳过不认识的行
    }
    const choice = json.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta
    if (!delta) continue
    const reasoningPiece = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoningPiece === 'string' && reasoningPiece) {
      opts.onReasoningDelta?.(reasoningPiece)
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      onDelta?.(delta.content)
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const slot = acc.get(idx) ?? { id: '', name: '', arguments: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
        if (tc.function?.arguments) slot.arguments += tc.function.arguments
        acc.set(idx, slot)
      }
    }
  }

  const toolCalls: ChatStreamResult['toolCalls'] = []
  for (const [, slot] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.name) continue
    let args: Record<string, unknown> = {}
    try {
      args = slot.arguments.trim() ? (JSON.parse(slot.arguments) as Record<string, unknown>) : {}
    } catch {
      args = { _raw: slot.arguments }
    }
    toolCalls.push({ id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: slot.name, args })
  }

  guard.dispose()
  return { content, toolCalls, finishReason }
}

/** 非流式小请求,用于设置页连通性测试(OpenAI 规范) */
export async function chatPing(profile: ChatProfile, timeoutMs = 30_000, sessionKey = 'settings-test'): Promise<void> {
  if (!profile.baseUrl || !profile.model) throw new ApiError('配置不完整(缺 baseUrl 或模型名)')
  if (!profile.apiKey) throw new ApiError('未配置 API Key')
  const res = await fetch(endpointUrl(profile.baseUrl, profile.chatPath, 'chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
      ...gatewaySessionHeaders(profile.baseUrl, sessionKey)
    },
    body: JSON.stringify({
      model: profile.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
      stream: false
    }),
    signal: withTimeout(undefined, timeoutMs)
  })
  if (!res.ok) await readErrorMessage(res)
}

// ---------- 规范分发:按 apiFormat 选择 OpenAI 或 Anthropic 实现 ----------

export interface StreamChatOpts {
  profile: ChatProfile
  messages: LLMMessage[]
  tools?: LLMTool[]
  timeoutMs: number
  signal?: AbortSignal
  sessionKey?: string
  onDelta?: (text: string) => void
  onReasoningDelta?: (text: string) => void
}

export async function streamChatCompletion(opts: StreamChatOpts): Promise<ChatStreamResult> {
  if (opts.profile.apiFormat === 'openai-responses') {
    const { responsesChatStream } = await import('./responses')
    return responsesChatStream(opts)
  }
  if (opts.profile.apiFormat === 'anthropic') {
    const { anthropicChatStream } = await import('./anthropic')
    return anthropicChatStream(opts)
  }
  return chatCompletionStream(opts)
}

export async function chatProviderPing(profile: ChatProfile, timeoutMs = 30_000, sessionKey = 'settings-test'): Promise<void> {
  if (profile.apiFormat === 'openai-responses') {
    const { responsesPing } = await import('./responses')
    return responsesPing(profile, timeoutMs, sessionKey)
  }
  if (profile.apiFormat === 'anthropic') {
    const { anthropicPing } = await import('./anthropic')
    return anthropicPing(profile, timeoutMs, sessionKey)
  }
  return chatPing(profile, timeoutMs, sessionKey)
}
