// 本地 mock 模型服务:验证 Agent 核心链路(无需真实 API Key)
// 实现:OpenAI 规范 /v1/chat/completions(SSE)+ /v1/images/generations + /v1/models
//      Anthropic 规范 /v1/messages(SSE,含 tool_use)

import http from 'node:http'

const PORT = 3117

// 1x1 透明 PNG
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data ? JSON.parse(data) : {}))
  })
}

/** 原样读请求体(按 utf8 增量解码,避免多字节中文被切在半路) */
function readRawBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

// ---------- 观测与故障注入(供 scripts/verify-fix.cjs 这类校验脚本使用) ----------
// GET  /__stats   → 最近/最大请求体体积、请求里的内联图片张数等(验证"请求体不再被大图撑爆")
// POST /__mode    → { fail: true } 让后续对话请求返回 500(验证失败时消息仍落盘并带原因)
// POST /__reset   → 清空统计
const stats = {
  requests: 0,
  maxBodyBytes: 0,
  lastBodyBytes: 0,
  lastUrl: '',
  lastImageCount: 0,
  lastHadOmitNote: false,
  failChat: false,
  /** 每个 SSE 分片之间的间隔(ms):用来验证"持续输出不超时 / 静默才超时" */
  streamDelayMs: 15
}

/** 统计请求体里内联图片张数与"体积超预算被省略"的留痕 */
function observeBody(url, rawBody) {
  const imageCount = (rawBody.match(/data:image\//g) ?? []).length
  stats.requests += 1
  stats.lastUrl = url
  stats.lastBodyBytes = Buffer.byteLength(rawBody, 'utf8')
  stats.lastImageCount = imageCount
  stats.lastHadOmitNote = rawBody.includes('未随本次请求发送')
  if (stats.lastBodyBytes > stats.maxBodyBytes) stats.maxBodyBytes = stats.lastBodyBytes
}

// ---------- OpenAI 规范决策 ----------

function decideOpenAi(body) {
  const msgs = body.messages ?? []
  // 状态块已移至尾部 user 消息(system 为静态),全局检测确认状态
  const joined = msgs
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
  const confirmed = joined.includes('已确认(用户已同意按此规格生成)')
  const toolMsgs = msgs.filter((m) => m.role === 'tool')
  const lastTool = toolMsgs.length ? String(toolMsgs[toolMsgs.length - 1].content) : ''

  // 脚本化导入指令:用户消息里带 `__IMPORT__ 路径1|路径2|…` 时,逐个调用 import_image
  // (校验"导入大图后请求体是否被撑爆"这条真实链路:scripts/verify-fix.cjs)
  const directive = joined.match(/__IMPORT__\s+([^\n"]+)/)
  if (directive) {
    const paths = directive[1]
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
    const imported = toolMsgs.filter((m) => String(m.content).startsWith('已导入图片')).length
    if (imported < paths.length) {
      return { kind: 'tool', name: 'import_image', args: { path: paths[imported] } }
    }
  }

  if (!toolMsgs.length) {
    // 第一轮:未确认时故意违规直接生成(测需求确认门);已确认则正常生成
    return { kind: 'tool', name: 'generate_image', args: { prompt: 'a watercolor cat', aspectRatio: '1:1', n: 1 } }
  }
  if (lastTool.startsWith('REJECTED') && lastTool.includes('本轮已生成过图片')) {
    // 迭代门拦截 → 按指引询问用户(选择题,带推荐项)
    return {
      kind: 'tool',
      name: 'ask_user',
      args: {
        question: '当前结果是否需要微调?',
        options: [
          { label: '再调暗一点', description: '整体色调压暗', recommended: true },
          { label: '保持这版' }
        ]
      }
    }
  }
  if (lastTool.startsWith('REJECTED')) {
    return { kind: 'tool', name: 'update_brief', args: { subject: '一只猫', style: '水彩插画', aspectRatio: '1:1' } }
  }
  if (lastTool.startsWith('需求已记录')) {
    return { kind: 'text', text: `我复述一下需求:主体=一只猫;风格=水彩插画;比例=1:1${confirmed ? '(已确认)' : ''}。${confirmed ? '' : '确认无误后我就开始生成,可以吗?'}` }
  }
  // 从最近的工具结果里回溯真实 asset id(ask_user 的结果里没有,需要扫描全部)
  const lastAssetId = () => {
    for (let i = toolMsgs.length - 1; i >= 0; i--) {
      const m = String(toolMsgs[i].content).match(/asset-[\w-]+/)
      if (m) return m[0]
    }
    return 'asset-x'
  }
  if (lastTool.startsWith('已生成')) {
    // 生成成功后故意直接再编辑(测迭代门拦截)
    return { kind: 'tool', name: 'edit_image', args: { assetIds: [lastAssetId()], instruction: 'darker' } }
  }
  if (lastTool.startsWith('用户选择')) {
    // 用户已通过问答面板同意 → 再次编辑(应放行)
    return { kind: 'tool', name: 'edit_image', args: { assetIds: [lastAssetId()], instruction: 'darker v2' } }
  }
  if (lastTool.startsWith('已完成编辑')) {
    return { kind: 'text', text: '已完成微调(经用户确认),这版色调更沉,请查看。' }
  }
  return { kind: 'text', text: 'mock fallback' }
}

function sse(res, chunks, doneMarker) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  let i = 0
  const tick = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`)
      setTimeout(tick, stats.streamDelayMs)
    } else {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
  tick()
}

function openaiChatStream(req, res, body) {
  const decision = decideOpenAi(body)
  const chunks = []
  if (decision.kind === 'text') {
    // 先流式输出一段思考内容,验证思考块管线
    for (const piece of '用户想要一张猫的图,我先复述需求再请求确认。'.match(/.{1,6}/gs) ?? []) {
      chunks.push({ choices: [{ delta: { reasoning_content: piece }, finish_reason: null }] })
    }
    for (const piece of decision.text.match(/.{1,8}/gs) ?? []) {
      chunks.push({ choices: [{ delta: { content: piece }, finish_reason: null }] })
    }
    chunks.push({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  } else {
    chunks.push({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, function: { name: decision.name, arguments: JSON.stringify(decision.args) } }] },
          finish_reason: null
        }
      ]
    })
    chunks.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  }
  sse(res, chunks)
}

// ---------- Anthropic 规范决策 ----------

function decideAnthropic(body) {
  const blocks = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  const hasToolResult = blocks.some((b) => b.type === 'tool_result')
  if (!hasToolResult) {
    return { kind: 'tool', name: 'update_brief', args: { subject: '远山', style: '水墨画', aspectRatio: '16:9' } }
  }
  return { kind: 'text', text: 'Anthropic 链路验证成功:需求已记录(远山·水墨·16:9)。' }
}

function anthropicStream(req, res, body) {
  const decision = decideAnthropic(body)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  send({ type: 'message_start', message: { role: 'assistant' } })
  if (decision.kind === 'text') {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const piece of decision.text.match(/.{1,8}/gs) ?? []) {
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
    }
    send({ type: 'content_block_stop', index: 0 })
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
  } else {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: decision.name, input: {} } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(decision.args) } })
    send({ type: 'content_block_stop', index: 0 })
    send({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  }
  send({ type: 'message_stop' })
  res.end()
}

// ---------- HTTP 服务 ----------

// OpenAI Responses 规范:首轮回工具调用,见到 function_call_output 后回文本
function decideResponses(body) {
  const items = body.input ?? []
  const hasOutput = items.some((i) => i.type === 'function_call_output')
  if (!hasOutput) {
    return { kind: 'tool', name: 'update_brief', args: { subject: '远山', style: '水墨画', aspectRatio: '16:9' } }
  }
  return { kind: 'text', text: 'Responses 链路验证成功:需求已记录(远山·水墨·16:9)。' }
}

function responsesStream(req, res, body) {
  const decision = decideResponses(body)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  send({ type: 'response.created', response: { id: `resp_${Date.now()}` } })
  if (decision.kind === 'text') {
    send({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_0', type: 'message', role: 'assistant' } })
    for (const piece of decision.text.match(/.{1,8}/gs) ?? []) {
      send({ type: 'response.output_text.delta', item_id: 'msg_0', output_index: 0, delta: piece })
    }
    send({ type: 'response.output_text.done', item_id: 'msg_0', text: decision.text })
  } else {
    const fcId = 'fc_0'
    send({ type: 'response.output_item.added', output_index: 0, item: { id: fcId, type: 'function_call', call_id: `call_${Date.now()}`, name: decision.name, arguments: '' } })
    for (const piece of JSON.stringify(decision.args).match(/.{1,10}/gs) ?? []) {
      send({ type: 'response.function_call_arguments.delta', item_id: fcId, output_index: 0, delta: piece })
    }
    send({ type: 'response.function_call_arguments.done', item_id: fcId, arguments: JSON.stringify(decision.args) })
    send({ type: 'response.output_item.done', output_index: 0, item: { id: fcId, type: 'function_call' } })
  }
  send({ type: 'response.completed', response: { id: `resp_${Date.now()}`, usage: {} } })
  res.end()
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? ''
  try {
    if (req.method === 'GET' && url === '/__stats') {
      json(res, stats)
    } else if (req.method === 'POST' && url === '/__mode') {
      const body = await readBody(req)
      if (typeof body.fail === 'boolean') stats.failChat = body.fail
      if (typeof body.streamDelayMs === 'number') stats.streamDelayMs = Math.max(0, body.streamDelayMs)
      json(res, stats)
    } else if (req.method === 'POST' && url === '/__reset') {
      stats.requests = 0
      stats.maxBodyBytes = 0
      stats.lastBodyBytes = 0
      stats.lastImageCount = 0
      stats.lastHadOmitNote = false
      json(res, stats)
    } else if (req.method === 'POST' && url.endsWith('/responses')) {
      const raw = await readRawBody(req)
      observeBody(url, raw)
      if (stats.failChat) return json(res, { error: { message: 'mock 500:上游网关超时' } }, 500)
      responsesStream(req, res, raw ? JSON.parse(raw) : {})
    } else if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      const raw = await readRawBody(req)
      observeBody(url, raw)
      if (stats.failChat) return json(res, { error: { message: 'mock 500:上游网关超时' } }, 500)
      openaiChatStream(req, res, raw ? JSON.parse(raw) : {})
    } else if (req.method === 'POST' && url.endsWith('/messages')) {
      const raw = await readRawBody(req)
      observeBody(url, raw)
      if (stats.failChat) return json(res, { error: { message: 'mock 500:上游网关超时' } }, 500)
      anthropicStream(req, res, raw ? JSON.parse(raw) : {})
    } else if (req.method === 'POST' && url.endsWith('/images/generations')) {
      json(res, { data: [{ b64_json: TINY_PNG }] })
    } else if (req.method === 'POST' && url.endsWith('/images/edits')) {
      json(res, { data: [{ b64_json: TINY_PNG }] })
    } else if (req.method === 'GET' && url.endsWith('/models')) {
      json(res, { data: [{ id: 'mock-chat' }, { id: 'mock-image' }] })
    } else {
      json(res, { error: { message: `not found: ${req.method} ${url}` } }, 404)
    }
  } catch (err) {
    json(res, { error: { message: String(err) } }, 500)
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock-llm listening on http://127.0.0.1:${PORT}`))
