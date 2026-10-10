// OpenAI Responses 规范 /responses:SSE 流式 + vision + function calling
// 与 chat.ts 的 chatCompletionStream 返回同构结果,由 streamChatCompletion 分发
// 中转站(如 cf.api.fan)与 OpenCode Go 的 gpt/grok 系模型走此规范

import type { ChatProfile } from '@shared/types'
import { ApiError, createIdleGuard, endpointUrl, gatewaySessionHeaders, readErrorMessage, sseDataChunks, withTimeout } from './http'
import type { ChatStreamResult, LLMMessage, LLMTool, StreamChatOpts } from './chat'

// ---------- 输入结构(LLMMessage → Responses input items) ----------

type InputContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

type InputItem =
  | { role: 'user' | 'assistant'; content: InputContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/** system 并入顶层 instructions;assistant 工具调用与 tool 结果展开为顶层 item */
function convertInput(messages: LLMMessage[]): { instructions: string; input: InputItem[] } {
  const instructions: string[] = []
  const input: InputItem[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) instructions.push(m.content)
      continue
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      } else if (Array.isArray(m.content)) {
        const content = m.content.map<InputContent>((p) =>
          p.type === 'text' ? { type: 'output_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url }
        )
        if (content.length) input.push({ role: 'assistant', content })
      }
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
      }
      continue
    }
    if (m.role === 'user') {
      const content: InputContent[] =
        typeof m.content === 'string'
          ? [{ type: 'input_text', text: m.content }]
          : m.content.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: p.image_url.url }))
      if (content.length) input.push({ role: 'user', content })
      continue
    }
    // tool 结果:output 为字符串
    input.push({
      type: 'function_call_output',
      call_id: m.tool_call_id ?? '',
      output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    })
  }
  return { instructions: instructions.join('\n\n'), input }
}

function buildBody(profile: ChatProfile, instructions: string, input: InputItem[], tools?: LLMTool[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: profile.model,
    input,
    stream: true,
    store: false // 历史在客户端维护,不需要服务端存储
  }
  if (instructions) body.instructions = instructions
  if (profile.maxOutputTokens) body.max_output_tokens = profile.maxOutputTokens
  // 推理强度:Responses 规范用 reasoning.effort;仅在用户显式设置时发送
  const effort = profile.reasoningEffort?.trim()
  if (effort && effort !== 'none' && effort !== 'default') body.reasoning = { effort }
  if (tools?.length) {
    // Responses 的工具定义是扁平结构(无 function 包层)
    body.tools = tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }))
  }
  return body
}

export async function responsesChatStream(opts: StreamChatOpts): Promise<ChatStreamResult> {
  const { profile, messages, tools, timeoutMs, signal, onDelta } = opts
  if (!profile.baseUrl || !profile.model) throw new ApiError('对话服务配置不完整(缺 baseUrl 或模型名)')
  if (!profile.apiKey) throw new ApiError('对话服务未配置 API Key')

  const { instructions, input } = convertInput(messages)
  const body = buildBody(profile, instructions, input, tools)

  // 空闲超时:timeoutMs 内没有数据才中断
  const guard = createIdleGuard(signal, timeoutMs)
  const res = await fetch(endpointUrl(profile.baseUrl, profile.chatPath, 'responses'), {
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
  // key=item_id;只发 arguments.done 不发 delta 的实现也能覆盖
  const calls = new Map<string, { id: string; name: string; args: string }>()

  for await (const data of sseDataChunks(res, guard.touch)) {
    let json: {
      type?: string
      delta?: string
      item_id?: string
      item?: { id?: string; type?: string; call_id?: string; name?: string }
      arguments?: string
    }
    try {
      json = JSON.parse(data)
    } catch {
      continue
    }
    switch (json.type) {
      case 'response.output_text.delta':
        if (typeof json.delta === 'string' && json.delta) {
          content += json.delta
          onDelta?.(json.delta)
        }
        break
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        if (typeof json.delta === 'string' && json.delta) opts.onReasoningDelta?.(json.delta)
        break
      case 'response.output_item.added': {
        const item = json.item
        if (item?.type === 'function_call') {
          calls.set(item.id ?? item.call_id ?? '', { id: item.call_id ?? item.id ?? '', name: item.name ?? '', args: '' })
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const slot = calls.get(json.item_id ?? '')
        if (slot && typeof json.delta === 'string') slot.args += json.delta
        break
      }
      case 'response.function_call_arguments.done': {
        const slot = calls.get(json.item_id ?? '')
        if (slot && typeof json.arguments === 'string' && !slot.args) slot.args = json.arguments
        break
      }
      case 'response.failed':
      case 'error':
        throw new ApiError(`Responses 流错误:${data.slice(0, 300)}`)
      default:
        // response.created / output_item.done / completed 等无需处理
        break
    }
  }

  const toolCalls: ChatStreamResult['toolCalls'] = []
  for (const [, slot] of calls) {
    if (!slot.name) continue
    let args: Record<string, unknown> = {}
    try {
      args = slot.args.trim() ? (JSON.parse(slot.args) as Record<string, unknown>) : {}
    } catch {
      args = { _raw: slot.args }
    }
    toolCalls.push({ id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: slot.name, args })
  }

  guard.dispose()
  return { content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' }
}

/** Responses 连通性测试(非流式) */
export async function responsesPing(profile: ChatProfile, timeoutMs = 30_000, sessionKey = 'settings-test'): Promise<void> {
  if (!profile.baseUrl || !profile.model) throw new ApiError('配置不完整(缺 baseUrl 或模型名)')
  if (!profile.apiKey) throw new ApiError('未配置 API Key')
  const res = await fetch(endpointUrl(profile.baseUrl, profile.chatPath, 'responses'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`,
      ...gatewaySessionHeaders(profile.baseUrl, sessionKey)
    },
    body: JSON.stringify({
      model: profile.model,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
      max_output_tokens: 16,
      stream: false,
      store: false
    }),
    signal: withTimeout(undefined, timeoutMs)
  })
  if (!res.ok) await readErrorMessage(res)
}
