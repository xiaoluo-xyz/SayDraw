// 上游故障「自动重试 + 后备模型」端到端验收:npm run verify:recovery:live
//
// 不碰真服务:起一个本地 OpenAI 兼容 mock(指定模型必回 503,另一个模型正常流式),
// 把应用的对话配置临时指向它,在真实界面里跑一轮,验证:
//   1. 主模型 503 → 先退避重试(恰好 3 次请求)→ 自动改用后备模型并完成本轮
//   2. 消息里留下过程提示与"谁代跑",界面上有黄色提示条
//   3. 全部模型都挂时,落一条带诊断卡片(标题/建议/请求号/原始报错)的失败消息
//   4. 结束后还原用户的对话配置(不留 mock 连接)
//
// 用法:先让应用带着 --remote-debugging-port=9222 跑着(node_modules\\electron\\dist\\electron.exe . --remote-debugging-port=9222),
// 然后 npm run verify:recovery:live
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = path.join(ROOT, '_shots')
fs.mkdirSync(SHOTS, { recursive: true })
const CDP = process.env.SAYDRAW_CDP ?? 'http://127.0.0.1:9222'

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- mock 服务:按模型名决定行为 ----------
// mock-503:永远是上游端点故障(带网关请求号) · mock-ok:正常流式输出
const hits = []
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      // 忽略
    }
    const model = String(body.model ?? '')
    hits.push(model)
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-503' }, { id: 'mock-ok' }] }))
      return
    }
    if (model !== 'mock-ok') {
      res.writeHead(503, { 'content-type': 'application/json', 'x-opencode-log-id': `mock-log-${hits.length}` })
      res.end(JSON.stringify({ error: { type: 'server_error', message: 'Upstream request failed: Endpoint is unavailable.' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    send({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })
    send({ choices: [{ delta: { content: '我是后备模型,已经接管本轮。' }, finish_reason: null }] })
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`

// ---------- CDP ----------
async function listTargets() {
  try {
    const r = await fetch(`${CDP}/json/list`)
    return await r.json()
  } catch {
    return []
  }
}
let page = (await listTargets()).find((t) => t.type === 'page')
if (!page) {
  console.error(`连不上应用(CDP ${CDP})。请先启动应用并带 --remote-debugging-port=9222`)
  server.close()
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})
let msgId = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails))
  return r.result?.result?.value
}
async function screenshot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.result.data, 'base64'))
}

const original = await evaluate(`(async () => {
  const s = await window.api.settings.get()
  return { activeChatModelId: s.activeChatModelId, chatFallback: s.chatFallback ?? null,
           connIds: s.chatConnections.map((c) => c.id), modelIds: s.chatModels.map((m) => m.id) }
})()`)

// ---------- 装配置:一个 mock 连接 + 正常/故障两个模型 ----------
const applyMockSettings = async (activeModel, fallback) => {
  await evaluate(`(async () => {
    const s = await window.api.settings.get()
    const conn = { id: 'conn-mock-recovery', name: 'Mock 通道(验收)', baseUrl: '${baseUrl}', apiKey: 'mock', apiFormat: 'openai' }
    const mk = (id, model) => ({ id, groupId: conn.id, name: model, model, contextWindow: 65536, maxOutputTokens: 4096, supportsVision: true })
    s.chatConnections = [...s.chatConnections.filter((c) => c.id !== conn.id), conn]
    s.chatModels = [...s.chatModels.filter((m) => m.groupId !== conn.id), mk('mock-503', 'mock-503'), mk('mock-ok', 'mock-ok')]
    s.activeChatModelId = '${activeModel}'
    s.chatFallback = '${fallback}'
    await window.api.settings.save(s)
    return true
  })()`)
}

const clickSession = async (title) =>
  evaluate(`(() => {
    const span = [...document.querySelectorAll('aside span')].find((el) => el.textContent.trim() === ${JSON.stringify(title)})
    if (!span) return false
    span.parentElement.click()
    return true
  })()`)

/** 重载界面:通过 IPC 直建的会话不会自动刷进侧栏,重载一次最稳 */
async function reloadApp() {
  await send('Page.reload')
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    try {
      if (await evaluate(`!!document.querySelector('aside')`)) return
    } catch {
      // 重载中上下文不可用,继续等
    }
  }
  throw new Error('应用重载超时')
}

async function runTurn(title, text, timeoutMs = 40_000) {
  const created = await evaluate(`window.api.sessions.create({ title: ${JSON.stringify(title)} })`)
  await reloadApp()
  await sleep(300)
  const clicked = await clickSession(title)
  if (!clicked) throw new Error('侧栏里找不到刚建的会话')
  await sleep(300)
  const start = Date.now()
  await evaluate(`window.api.chat.send(${JSON.stringify(created.id)}, ${JSON.stringify(text)})`)
  for (;;) {
    await sleep(400)
    const data = await evaluate(`window.api.chat.history(${JSON.stringify(created.id)})`)
    const last = data.messages[data.messages.length - 1]
    if (last && last.role === 'assistant' && last.stopReason) {
      await sleep(900) // 等界面渲染完最终消息
      return { sessionId: created.id, messages: data.messages }
    }
    if (Date.now() - start > timeoutMs) throw new Error('等待本轮结束超时')
  }
}

let exitCode = 0
try {
  // ===== 场景 1:主模型 503 → 自动换后备模型完成本轮 =====
  await applyMockSettings('mock-503', 'mock-ok')
  hits.length = 0
  const turn1 = await runTurn('503 自动接管验收', '你好,随便说一句')
  const final1 = [...turn1.messages].reverse().find((m) => m.role === 'assistant')
  record('场景1:本轮完成(不是"出错")', final1?.stopReason === 'completed', `stopReason=${final1?.stopReason}`)
  record('场景1:由后备模型产出内容', String(final1?.text ?? '').includes('后备模型'), final1?.text?.slice(0, 40))
  record('场景1:记录"谁代跑"', Boolean(final1?.modelFallbackFrom) && String(final1?.modelUsed).includes('mock-ok'), `${final1?.modelFallbackFrom} → ${final1?.modelUsed}`)
  record('场景1:留过程提示(重试 2 条 + 换模型 1 条)', (final1?.notices?.length ?? 0) >= 3, String(final1?.notices?.length))
  record('场景1:提示里说明临时改用', (final1?.notices ?? []).some((n) => n.includes('本轮临时改用')), (final1?.notices ?? []).join(' | ').slice(0, 120))
  record('场景1:主模型恰好请求 3 次(1+2 重试)', hits.filter((m) => m === 'mock-503').length === 3, JSON.stringify(hits))
  record('场景1:后备模型请求 1 次', hits.filter((m) => m === 'mock-ok').length === 1, JSON.stringify(hits))
  const amber = await evaluate(`[...document.querySelectorAll('div')].some((el) => el.textContent.includes('本轮临时改用') && el.className.includes('amber'))`)
  record('场景1:界面出现黄色提示条', amber === true, String(amber))
  await screenshot('recovery-1-fallback.png')

  // ===== 场景 2:所有模型都 503 → 失败诊断卡片 =====
  await applyMockSettings('mock-503', 'off')
  hits.length = 0
  const turn2 = await runTurn('503 全挂诊断验收', '再试一次')
  const final2 = [...turn2.messages].reverse().find((m) => m.role === 'assistant')
  const f = final2?.failure
  record('场景2:本轮为失败', final2?.stopReason === 'error', `stopReason=${final2?.stopReason}`)
  record('场景2:归类为上游端点故障', f?.kind === 'upstream' && f?.status === 503, `${f?.kind}/${f?.status}`)
  record('场景2:标题可读', f?.title === '上游端点不可用', f?.title)
  record('场景2:给出可执行建议', typeof f?.hint === 'string' && f.hint.length > 10, f?.hint?.slice(0, 40))
  record('场景2:带上网关请求号', typeof f?.requestId === 'string' && f.requestId.startsWith('mock-log-'), f?.requestId)
  record('场景2:重试耗尽(3 次)', hits.filter((m) => m === 'mock-503').length === 3, JSON.stringify(hits))
  record('场景2:旧字段 error 仍然可读', typeof final2?.error === 'string' && final2.error.includes('上游端点不可用'), final2?.error?.slice(0, 60))
  const card = await evaluate(`(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.textContent.includes('建议:') && d.className.includes('red'))
    return el ? el.innerText.slice(0, 160) : null
  })()`)
  record('场景2:界面显示诊断卡片(建议/原始报错)', Boolean(card && card.includes('上游端点不可用')), card?.replace(/\n/g, ' / ').slice(0, 90))
  const retryBtn = await evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('重试'))`)
  record('场景2:提供一键重试', retryBtn === true, String(retryBtn))
  await screenshot('recovery-2-diagnosis.png')

  // ===== 场景 3:点「↻ 重试」真的会重发一轮 =====
  const before = hits.filter((m) => m === 'mock-503').length
  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('重试'))
    if (!b) return false
    b.click()
    return true
  })()`)
  record('场景3:重试按钮可点', clicked === true, String(clicked))
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    const d = await evaluate(`window.api.chat.history(${JSON.stringify(turn2.sessionId)})`)
    if (d.messages.filter((m) => m.role === 'assistant' && m.stopReason).length >= 2) break
  }
  const after = hits.filter((m) => m === 'mock-503').length
  const history3 = await evaluate(`window.api.chat.history(${JSON.stringify(turn2.sessionId)})`)
  record('场景3:确实重新发起了请求(+3 次)', after - before === 3, `${before} → ${after}`)
  record('场景3:会话里多了一条用户消息', history3.messages.filter((m) => m.role === 'user').length === 2, String(history3.messages.filter((m) => m.role === 'user').length))
} catch (err) {
  console.error('EXCEPTION', err)
  exitCode = 1
} finally {
  // ---------- 还原用户配置并清掉验收会话 ----------
  try {
    await evaluate(`(async () => {
      const s = await window.api.settings.get()
      s.chatConnections = s.chatConnections.filter((c) => c.id !== 'conn-mock-recovery')
      s.chatModels = s.chatModels.filter((m) => m.groupId !== 'conn-mock-recovery')
      s.activeChatModelId = ${JSON.stringify(original.activeChatModelId)}
      ${original.chatFallback ? `s.chatFallback = ${JSON.stringify(original.chatFallback)}` : 'delete s.chatFallback'}
      await window.api.settings.save(s)
      for (const t of ['503 自动接管验收', '503 全挂诊断验收']) {
        const list = await window.api.sessions.list()
        const hit = list.find((x) => x.title === t)
        if (hit) await window.api.sessions.remove(hit.id)
      }
      return true
    })()`)
    const restored = await evaluate(`(async () => {
      const s = await window.api.settings.get()
      return { active: s.activeChatModelId, hasMock: s.chatConnections.some((c) => c.id === 'conn-mock-recovery'), titles: (await window.api.sessions.list()).map((x) => x.title) }
    })()`)
    record('收尾:配置已还原、mock 连接已清除', restored.active === original.activeChatModelId && restored.hasMock === false, JSON.stringify(restored))
    await reloadApp()
  } catch (err) {
    console.error('还原配置失败', err)
    exitCode = 1
  }
  ws.close()
  server.close()
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
  if (failed.length) {
    console.log(failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n'))
    exitCode = 1
  }
  process.exit(exitCode)
}
