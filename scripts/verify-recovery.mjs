// 上游故障归类 + 重试/后备编排单测:npm run verify:recovery
//
// 用 esbuild 把 TS 打成临时 bundle(渲染/主进程共用 @shared 别名,node 直跑解析不了),
// electron 用桩替身,不联网、不花额度。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saydraw-recovery-'))
const posix = (p) => p.replace(/\\/g, '/')

const stubElectron = path.join(tmp, 'electron-stub.ts')
fs.writeFileSync(stubElectron, 'export const app = { getVersion: () => "0.0.0-test" }\nexport const safeStorage = {}\n', 'utf8')

const entry = path.join(tmp, 'entry.ts')
fs.writeFileSync(
  entry,
  [
    `export * from '${posix(path.join(ROOT, 'src/shared/failure'))}'`,
    `export * from '${posix(path.join(ROOT, 'src/shared/fallback'))}'`,
    `export { streamChatWithRecovery, ChatRunError } from '${posix(path.join(ROOT, 'src/main/agent/recovery'))}'`,
    `export { ApiError } from '${posix(path.join(ROOT, 'src/main/providers/http'))}'`
  ].join('\n'),
  'utf8'
)

const outfile = path.join(tmp, 'bundle.mjs')
buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@shared': posix(path.join(ROOT, 'src/shared')), electron: stubElectron },
  outfile,
  logLevel: 'warning'
})

const { classifyFailure, summarizeFailure, failureText, failureHeadline, shouldRetry, shouldSwitchModel, streamChatWithRecovery, ChatRunError, ApiError, orderFallbackModelIds } =
  await import(pathToFileURL(outfile).href)

let pass = 0
const failures = []
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    failures.push(`${name}: 期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`)
    console.log(`FAIL  ${name} — 期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`)
  }
}

const kindOf = (status, message) => classifyFailure({ status, message }).kind

// ---------- 1. 归类:真实报文全覆盖 ----------
// OpenCode Go 端点故障的原始报文(2026-10-21 实测)
const OC_503 = 'Upstream request failed: Endpoint is unavailable.(HTTP 503)'
eq('OpenCode 503 端点故障 → upstream', kindOf(503, OC_503), 'upstream')
eq('OpenCode 503 无状态码也能认 → upstream', kindOf(undefined, 'Upstream request failed: Endpoint is unavailable.'), 'upstream')
eq('503 可重试', shouldRetry(summarizeFailure({ status: 503, message: OC_503 })), true)
eq('503 可换模型', shouldSwitchModel(summarizeFailure({ status: 503, message: OC_503 })), true)

eq('无效密钥 → auth', kindOf(401, '{"error":{"message":"Upstream request failed: Invalid credential"}}'), 'auth')
eq('鉴权不重试(同 Key 重试没意义)', shouldRetry(summarizeFailure({ status: 401, message: 'Invalid credential' })), false)
eq('DeepSeek 鉴权失败文案 → auth', kindOf(401, 'Authentication Fails, Your api key: ****abcd is invalid'), 'auth')

eq('模型不存在(400) → model_missing', kindOf(400, 'Upstream request failed: Model is unavailable.'), 'model_missing')
eq('模型不存在(无状态码) → model_missing', kindOf(undefined, 'Upstream request failed: Model is unavailable.'), 'model_missing')
eq('模型不存在可换模型', shouldSwitchModel(summarizeFailure({ message: 'Model is unavailable.' })), true)
eq('模型不存在不重试', shouldRetry(summarizeFailure({ message: 'Model is unavailable.' })), false)

eq('协议不匹配 → model_protocol', kindOf(400, 'Model does not support this protocol.'), 'model_protocol')
eq('429 → rate_limit', kindOf(429, 'Rate limit reached'), 'rate_limit')
eq('429 可重试', shouldRetry(summarizeFailure({ status: 429, message: 'Rate limit' })), true)
eq('额度不足 → quota', kindOf(400, 'insufficient_quota: 余额不足'), 'quota')
eq('404 路径错 → endpoint', kindOf(404, '404 page not found'), 'endpoint')
eq('断网 → network', kindOf(undefined, 'TypeError: fetch failed'), 'network')
eq('断网可重试', shouldRetry(summarizeFailure({ message: 'fetch failed' })), true)
eq('超时 → timeout', kindOf(undefined, '请求超时'), 'timeout')
eq('用户取消 → aborted', classifyFailure({ message: '已取消', aborted: true }).kind, 'aborted')
eq('取消不重试也不换模型', [shouldRetry(summarizeFailure({ message: '已取消', aborted: true })), shouldSwitchModel(summarizeFailure({ message: '已取消', aborted: true }))], [false, false])
eq('缺 Key → config', kindOf(undefined, '对话服务未配置 API Key'), 'config')
eq('未知 4xx → unknown', kindOf(400, 'bad request: foo'), 'unknown')

// 建议文案必须真的给出动作,不能是空的
for (const [label, kind] of [
  ['upstream', 'upstream'],
  ['auth', 'auth'],
  ['model_missing', 'model_missing'],
  ['model_protocol', 'model_protocol'],
  ['rate_limit', 'rate_limit'],
  ['network', 'network']
]) {
  const f = classifyFailure({ status: 503, message: kind === 'auth' ? 'Invalid credential' : kind === 'model_protocol' ? 'does not support this protocol' : 'Endpoint is unavailable' })
  eq(`${label} 有可执行建议`, Boolean(f.hint && f.hint.length > 8), true)
}

eq('标题带 HTTP 与模型', failureHeadline(summarizeFailure({ status: 503, message: OC_503, model: 'OpenCode Go/deepseek-v4.1-flash' })), '上游端点不可用 · HTTP 503 · OpenCode Go/deepseek-v4.1-flash')
eq('兼容旧 error 字段', failureText(summarizeFailure({ status: 503, message: OC_503, model: 'A/b' })), `上游端点不可用:[A/b] ${OC_503}`)

// ---------- 2. 后备模型挑选顺序 ----------
{
  const models = [
    { id: 'a1', groupId: 'A' },
    { id: 'a2', groupId: 'A' },
    { id: 'b1', groupId: 'B' },
    { id: 'b2', groupId: 'B' }
  ]
  eq('auto:先别的连接,再同连接', orderFallbackModelIds(models, 'a1', 'auto'), ['b1', 'b2', 'a2'])
  eq('auto:未设置策略按 auto', orderFallbackModelIds(models, 'a1', undefined), ['b1', 'b2', 'a2'])
  eq('off:不换模型', orderFallbackModelIds(models, 'a1', 'off'), [])
  eq('显式指定:只用指定的', orderFallbackModelIds(models, 'a1', 'b2'), ['b2'])
  eq('显式指定自己:视为没有后备', orderFallbackModelIds(models, 'a1', 'a1'), [])
  eq('显式指定已删除的模型:视为没有后备', orderFallbackModelIds(models, 'a1', 'gone'), [])
  eq('未知主模型:全部候选按原序', orderFallbackModelIds(models, 'nope', 'auto'), ['a1', 'a2', 'b1', 'b2'])
}

// ---------- 3. 重试 / 换模型编排 ----------
const P = (id, model, name) => ({ id, name: name ?? `${model}/${id}`, baseUrl: 'https://x', apiKey: 'k', model })
const ok = (text) => ({ content: text, toolCalls: [], finishReason: 'stop' })
const noSleep = async () => {}
const upErr = () => new ApiError('Upstream request failed: Endpoint is unavailable.', 503, '{}', 'log-abc123')

function harness(behaviour) {
  const calls = []
  const attempt = async (profile, onProgress) => {
    calls.push(profile.id)
    return behaviour(profile, onProgress, calls)
  }
  return { calls, attempt }
}

// (a) 抖动一次就恢复:只重试,不换模型
{
  let n = 0
  const h = harness(async () => {
    n++
    if (n === 1) throw upErr()
    return ok('hello')
  })
  const notices = []
  const r = await streamChatWithRecovery({
    profiles: [P('m1', 'primary'), P('m2', 'backup')],
    attempt: h.attempt,
    sleep: noSleep,
    emitNotice: (_l, m) => notices.push(m)
  })
  eq('抖动:最终成功在主模型', r.profile.id, 'm1')
  eq('抖动:调用序列(主/主)', h.calls, ['m1', 'm1'])
  eq('抖动:一条重试提示', notices.length, 1)
  eq('抖动:提示含秒数与次数', /0\.6 秒后重试\(1\/2\)/.test(notices[0]), true)
  eq('抖动:没有切换记录', r.primaryFailure?.kind, 'upstream')
}

// (b) 主模型持续 503:重试耗尽 → 换后备模型
{
  const h = harness(async (p) => {
    if (p.id === 'm1') throw upErr()
    return ok('from backup')
  })
  const notices = []
  const r = await streamChatWithRecovery({ profiles: [P('m1', 'primary'), P('m2', 'backup')], attempt: h.attempt, sleep: noSleep, emitNotice: (_l, m) => notices.push(m) })
  eq('换模型:成功在后备', [r.profile.id, r.result.content], ['m2', 'from backup'])
  eq('换模型:主模型 1+2 次', h.calls, ['m1', 'm1', 'm1', 'm2'])
  eq('换模型:2 条重试 + 1 条切换提示', notices.length, 3)
  eq('换模型:最后一条说明谁代跑', /本轮临时改用「backup\/m2」继续/.test(notices[2]), true)
  eq('换模型:带出主模型诊断', r.primaryFailure?.status, 503)
  eq('换模型:诊断带网关请求号', r.primaryFailure?.requestId, 'log-abc123')
}

// (c) 已经吐出内容后失败:不许重来(否则界面重复)
{
  let n = 0
  const h = harness(async (p, onProgress) => {
    n++
    onProgress()
    throw upErr()
  })
  let err
  try {
    await streamChatWithRecovery({ profiles: [P('m1', 'primary'), P('m2', 'backup')], attempt: h.attempt, sleep: noSleep })
  } catch (e) {
    err = e
  }
  eq('已产出不重试:一次就停', h.calls, ['m1'])
  eq('已产出不重试:抛原始错误', err?.status, 503)
}

// (d) 全部失败:抛 ChatRunError,诊断取主模型的(不是最后一条)
{
  const h = harness(async (p) => {
    throw p.id === 'm1' ? upErr() : new ApiError('Model is unavailable.', 400)
  })
  let err
  try {
    await streamChatWithRecovery({ profiles: [P('m1', 'primary'), P('m2', 'backup')], attempt: h.attempt, sleep: noSleep })
  } catch (e) {
    err = e
  }
  eq('全失败:是 ChatRunError', err instanceof ChatRunError, true)
  eq('全失败:诊断取主模型(upstream 503)', [err.failure.kind, err.failure.status], ['upstream', 503])
  eq('全失败:每次尝试都记录(主 3 次 + 后备 1 次)', err.attempts.length, 4)
  eq('全失败:后备模型不重试(只 1 次)', h.calls, ['m1', 'm1', 'm1', 'm2'])
}

// (e) 鉴权错误:主模型不重试(不浪费时间),直接换模型
{
  const h = harness(async (p) => {
    if (p.id === 'm1') throw new ApiError('Invalid credential', 401)
    return ok('ok')
  })
  const r = await streamChatWithRecovery({ profiles: [P('m1', 'primary'), P('m2', 'backup')], attempt: h.attempt, sleep: noSleep })
  eq('鉴权:直接换模型不重试', h.calls, ['m1', 'm2'])
  eq('鉴权:最终用后备', r.profile.id, 'm2')
}

// (f) 只有一个模型且失败:带建议抛出
{
  const h = harness(async () => {
    throw upErr()
  })
  let err
  try {
    await streamChatWithRecovery({ profiles: [P('m1', 'primary')], attempt: h.attempt, sleep: noSleep })
  } catch (e) {
    err = e
  }
  eq('单模型失败:只重试 2 次', h.calls.length, 3)
  eq('单模型失败:建议非空', Boolean(err?.failure?.hint), true)
}

// (g) 取消:立刻中止,不再重试
{
  const ctrl = new AbortController()
  const h = harness(async () => {
    ctrl.abort()
    throw Object.assign(new Error('已取消'), { name: 'AbortError' })
  })
  let name
  try {
    await streamChatWithRecovery({ profiles: [P('m1', 'primary'), P('m2', 'backup')], attempt: h.attempt, signal: ctrl.signal, sleep: noSleep })
  } catch (e) {
    name = e.name
  }
  eq('取消:抛 AbortError 且不再尝试', [name, h.calls], ['AbortError', ['m1']])
}

// (h) 重复 profile 去重(配置里同一模型挂多次时不重复打请求)
{
  const h = harness(async () => ok('x'))
  await streamChatWithRecovery({ profiles: [P('m1', 'primary'), P('m1', 'primary')], attempt: h.attempt, sleep: noSleep })
  eq('去重:只请求一次', h.calls, ['m1'])
}

console.log(`\n==== ${pass}/${pass + failures.length} 通过 ====`)
fs.rmSync(tmp, { recursive: true, force: true })
if (failures.length) {
  console.log(failures.map((f) => ' - ' + f).join('\n'))
  process.exit(1)
}
