// Anthropic 规范 /v1/messages:SSE 流式 + vision + tool use
// 与 chat.ts 的 chatCompletionStream 返回同构结果,由 streamChatCompletion 分发

import type { ChatProfile } from '@shared/types'
import { ApiError, createIdleGuard, endpointUrl, gatewaySessionHeaders, readErrorMessage, sseDataChunks, withTimeout } from './http'
import type { ChatStreamResult, LLMMessage, LLMTool } from './chat'

interface ToolUseAcc {
  id: string
  name: string
  json: string
}

type Block =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: { type: 'ephemeral' } }

interface ConvMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

function parseDataUrl(url: string): { mime: string; data: string } {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(url)
  if (!m) return { mime: 'image/png', data: '' }
  return { mime: m[1].toLowerCase(), data: m[2] }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return s.trim() ? (JSON.parse(s) as Record<string, unknown>) : {}
  } catch {
    return { _raw: s }
  }
}

/** LLMMessage → Anthropic 消息结构(合并连续同角色;tool 结果并入 user 消息) */
function convertMessages(messages: LLMMessage[]): { system: string; messages: ConvMessage[] } {
  const systemTexts: string[] = []
  const out: ConvMessage[] = []
  const push = (role: 'user' | 'assistant', block: Block): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(block)
    else out.push({ role, content: [block] })
  }

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemTexts.push(m.content)
      continue
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        push('user', { type: 'text', text: m.content })
      } else {
        for (const part of m.content) {
          if (part.type === 'text') push('user', { type: 'text', text: part.text })
          else {
            const { mime, data } = parseDataUrl(part.image_url.url)
            if (data) push('user', { type: 'image', source: { type: 'base64', media_type: mime, data } })
          }
        }
      }
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) push('assistant', { type: 'text', text })
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          push('assistant', { type: 'tool_use', id: tc.id, name: tc.function.name, input: safeParse(tc.function.arguments) })
        }
      }
    } else {
      // tool 角色结果 → user 消息中的 tool_result 块
      const text = typeof m.content === 'string' ? m.content : '[非文本结果]'
      push('user', { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: text })
    }
  }

  if (out.length === 0 || out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(对话开始)' }] })
  }
  return { system: systemTexts.join('\n\n'), messages: out }
}

function messagesUrl(baseUrl: string, chatPath?: string): string {
  return endpointUrl(baseUrl, chatPath, 'messages')
}

export async function anthropicChatStream(opts: {
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

  const { system, messages: conv } = convertMessages(messages)
  const maxTokens = profile.maxOutputTokens || 8192
  const body: Record<string, unknown> = {
    model: profile.model,
    max_tokens: maxTokens,
    messages: conv,
    stream: true
  }
  if (system) {
    // 显式缓存断点①:system(静态,跨请求全量命中)
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
  }
  // 显式缓存断点②:倒数第二条消息的末块(滚动断点,下一轮此前缀不变即命中缓存,写 1.25x / 读 0.1x)
  const rolling = conv[conv.length - 2]
  if (rolling?.content?.length) {
    const lastBlock = rolling.content[rolling.content.length - 1] as { cache_control?: unknown }
    lastBlock.cache_control = { type: 'ephemeral' }
  }
  // 思考模式映射:Anthropic 用 thinking.budget_tokens;推理强度档位无对应,忽略
  if (profile.thinkingMode === 'enabled') {
    body.thinking = { type: 'enabled', budget_tokens: Math.min(16_000, Math.max(1024, maxTokens - 2048)) }
  }
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }))
  }

  // 空闲超时:timeoutMs 内没有数据才中断
  const guard = createIdleGuard(signal, timeoutMs)
  const res = await fetch(messagesUrl(profile.baseUrl, profile.chatPath), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01',
      ...gatewaySessionHeaders(profile.baseUrl, opts.sessionKey ?? 'default')
    },
    body: JSON.stringify(body),
    signal: guard.signal
  })
  if (!res.ok) await readErrorMessage(res)

  let content = ''
  let finishReason: string | null = null
  const toolAcc = new Map<number, ToolUseAcc>()

  for await (const data of sseDataChunks(res, guard.touch)) {
    let json: {
      type?: string
      index?: number
      content_block?: { type?: string; id?: string; name?: string }
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
    }
    try {
      json = JSON.parse(data)
    } catch {
      continue
    }
    switch (json.type) {
      case 'content_block_start':
        if (json.content_block?.type === 'tool_use') {
          toolAcc.set(json.index ?? 0, { id: json.content_block.id ?? '', name: json.content_block.name ?? '', json: '' })
        }
        break
      case 'content_block_delta': {
        const delta = json.delta
        if (delta?.type === 'text_delta' && delta.text) {
          content += delta.text
          onDelta?.(delta.text)
        } else if (delta?.type === 'thinking_delta' && (delta as { thinking?: string }).thinking) {
          opts.onReasoningDelta?.((delta as { thinking?: string }).thinking ?? '')
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          const slot = toolAcc.get(json.index ?? 0)
          if (slot) slot.json += delta.partial_json
        }
        break
      }
      case 'message_delta':
        if (json.delta?.stop_reason === 'tool_use') finishReason = 'tool_calls'
        else if (json.delta?.stop_reason) finishReason = 'stop'
        break
      case 'error':
        throw new ApiError(`Anthropic 流错误:${data.slice(0, 300)}`)
      default:
        break
    }
  }

  const toolCalls: ChatStreamResult['toolCalls'] = [...toolAcc.values()]
    .filter((t) => t.name)
    .map((t) => ({ id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: t.name, args: safeParse(t.json) }))

  guard.dispose()
  return { content, toolCalls, finishReason }
}

/** Anthropic 连通性测试(非流式) */
export async function anthropicPing(profile: ChatProfile, timeoutMs = 30_000, sessionKey = 'settings-test'): Promise<void> {
  const res = await fetch(messagesUrl(profile.baseUrl, profile.chatPath), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01',
      ...gatewaySessionHeaders(profile.baseUrl, sessionKey)
    },
    body: JSON.stringify({
      model: profile.model,
      max_tokens: 8,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
    }),
    signal: withTimeout(undefined, timeoutMs)
  })
  if (!res.ok) await readErrorMessage(res)
}
