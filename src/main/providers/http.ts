// HTTP 公共设施:URL 拼接、超时/取消、SSE 解析、错误归一化

import { app } from 'electron'

export class ApiError extends Error {
  status?: number
  body?: string
  /** 网关给的请求号(OpenCode 的 x-opencode-log-id / cf-ray 等),报障时能对上服务端日志 */
  requestId?: string
  constructor(message: string, status?: number, body?: string, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.requestId = requestId
  }
}

/** 各网关用来标识单次请求的响应头,按优先级取第一个非空的 */
const REQUEST_ID_HEADERS = ['x-opencode-log-id', 'x-request-id', 'request-id', 'cf-ray', 'x-amzn-requestid', 'x-served-by']

export function requestIdOf(res: Response): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const v = res.headers.get(name)
    if (v && v.trim()) return v.trim().slice(0, 80)
  }
  return undefined
}

/** baseUrl(如 https://host/v1)+ 路径(/chat/completions) */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * 网关会话头:OpenCode Go(opencode.ai)要求每个会话带稳定的 x-opencode-session,
 * 缺失会被 400 拒绝("cannot be routed efficiently");顺带自定义 User-Agent 标识客户端。
 * 其他服务不受影响(按 host 匹配才附加)。
 */
export function gatewaySessionHeaders(baseUrl: string, sessionKey: string): Record<string, string> {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) {
      return { 'x-opencode-session': `saydraw-${sessionKey}`, 'User-Agent': `SayDraw/${app.getVersion()}` }
    }
  } catch {
    // 非法 baseUrl 交给后续请求统一报错
  }
  return {}
}

/**
 * 规范端点 URL:分组地址是基础地址,按规范拼请求地址。
 * 显式路径(chatPath)优先;否则基础地址已含版本段(/v1、/v4 等)直接拼相对路径,
 * 不含则补 /v1 前缀 —— 如 cf.api.fan + chat/completions → /v1/chat/completions,
 * api.openai.com/v1 + chat/completions → /v1/chat/completions。
 */
export function endpointUrl(baseUrl: string, explicitPath: string | undefined, relPath: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const rel = relPath.replace(/^\/+/, '')
  if (explicitPath?.trim()) return joinUrl(base, explicitPath.trim())
  return /\/v\d+$/.test(base) ? `${base}/${rel}` : `${base}/v1/${rel}`
}

/** 合并外部取消信号与超时(整请求硬上限;用于 ping/生图/列模型这类短请求) */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)])
}

/** 流式对话请求的总上限:兜住"服务端一直滴数据但永不结束"的极端情况(正常由空闲超时兜底) */
export const STREAM_HARD_TIMEOUT_MS = 15 * 60_000

export interface IdleGuard {
  /** 交给 fetch 的信号:外部取消、空闲超时、总超时任一触发都会中断 */
  signal: AbortSignal
  /** 收到任何数据(含心跳/思考增量)时调用,重新计时 */
  touch: () => void
  /** 请求结束(含失败)后清计时器;忘了调用也只是让计时器多待一会儿,不影响已结束的请求 */
  dispose: () => void
}

/**
 * 流式请求的空闲超时守卫:只要还在收数据就不算超时,连续 idleMs 没有任何数据才中断。
 *
 * 为什么不用 `AbortSignal.timeout` 直接卡整请求:deepseek-v4.1-flash(max 推理强度、
 * maxOutputTokens 6.4 万)这类配置,单轮流式输出几分钟很常见 —— 2026-10-10 实测,
 * 一个完全正常的回合在 120 秒处被硬 deadline 掐断,界面只显示「请求超时」。
 */
export function createIdleGuard(external: AbortSignal | undefined, idleMs: number, hardMs = STREAM_HARD_TIMEOUT_MS): IdleGuard {
  const ctrl = new AbortController()
  let idleTimer: NodeJS.Timeout | null = null
  const arm = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => ctrl.abort(new DOMException(`idle ${idleMs}ms`, 'TimeoutError')), idleMs)
    idleTimer.unref?.()
  }
  arm()
  const hardTimer = setTimeout(() => ctrl.abort(new DOMException(`hard ${hardMs}ms`, 'TimeoutError')), hardMs)
  hardTimer.unref?.()

  return {
    signal: external ? AbortSignal.any([external, ctrl.signal]) : ctrl.signal,
    touch: arm,
    dispose: (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(hardTimer)
    }
  }
}

export async function readErrorMessage(res: Response): Promise<never> {
  let body = ''
  try {
    body = (await res.text()).slice(0, 500)
  } catch {
    // ignore
  }
  let hint = ''
  try {
    const json = JSON.parse(body) as { error?: { message?: string } ; message?: string }
    hint = json.error?.message ?? json.message ?? ''
  } catch {
    // 非 JSON 响应体
  }
  // 鉴权失败是最常见的"看起来没反应":把原因说清楚,用户才知道该去设置里改 Key
  if (res.status === 401 || res.status === 403) {
    const advice = 'API Key 可能已失效、被撤销或额度不足,请到设置里检查对应服务'
    hint = hint ? `${hint}(${advice})` : `鉴权失败(HTTP ${res.status}):${advice}`
  }
  if (!hint) hint = body.trim() ? body.trim().slice(0, 200) : ''
  throw new ApiError(hint || `HTTP ${res.status}`, res.status, body, requestIdOf(res))
}

/** 逐条产出 SSE data 载荷(兼容 \n 与 \r\n);onActivity 在每次收到字节时回调(空闲超时续期用) */
export async function* sseDataChunks(res: Response, onActivity?: () => void): AsyncGenerator<string> {
  if (!res.body) throw new ApiError('响应无内容(SSE 流为空)')
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let dataLines: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line === '') {
          if (dataLines.length) {
            yield dataLines.join('\n')
            dataLines = []
          }
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
        // 忽略 event:/id:/retry:/注释行
      }
    }
    if (dataLines.length) yield dataLines.join('\n')
  } finally {
    reader.releaseLock()
  }
}

export function errText(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}${err.status ? `(HTTP ${err.status})` : ''}`
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return '请求超时'
    if (err.name === 'AbortError') return '已取消'
    return err.message
  }
  return String(err)
}
