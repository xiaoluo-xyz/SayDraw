// 上游故障归类:决定「能不能自动重试」「要不要换模型」,并把各家网关的报错翻译成用户能照着做的建议。
//
// 为什么需要这一层:中转/网关的报错文案五花八门且完全不给解决方案 —— 例如 OpenCode Go 在
// 某模型的端点上挂掉时只回一句 `Upstream request failed: Endpoint is unavailable.`(HTTP 503),
// 用户看到的就是"出错 + 一句英文",既不知道是自己配错了还是服务商挂了,也不知道该干什么。
// 归类后:抖动类自动重试、模型级故障自动切后备模型、配置类直接指到设置页。
//
// 纯函数,无 Electron/Node 依赖(渲染进程与主进程共用,可单测)。

export type FailureKind =
  | 'aborted' // 用户中止
  | 'auth' // Key 无效/无权限
  | 'quota' // 余额/额度不足
  | 'rate_limit' // 429 限流
  | 'upstream' // 服务商/网关 5xx(端点不可用、网关超时…)
  | 'model_missing' // 模型不存在 / 无权访问该模型
  | 'model_protocol' // 模型不提供当前协议(常见:只给 /responses 或 Anthropic)
  | 'endpoint' // 路径 404(Base URL / 请求路径配错)
  | 'network' // DNS / 连接被拒 / 断网
  | 'timeout' // 请求超时
  | 'config' // 本地配置缺项(无 Key、无模型名)
  | 'unknown'

export interface FailureInfo {
  kind: FailureKind
  /** 同一请求立刻重试可能成功(抖动、限流、短暂断连) */
  transient: boolean
  /** 换一个模型可能立刻就好(端点级/模型级故障) */
  modelSpecific: boolean
  /** 一句话定性,给用户看 */
  title: string
  /** 用户接下来该做什么(空字符串=无需操作) */
  hint: string
}

/** 落盘到消息里的结构化失败信息(刷新后仍能展示同样的诊断与建议) */
export interface FailureSummary extends FailureInfo {
  status?: number
  requestId?: string
  /** 出问题的服务/模型,如 "OpenCode Go/deepseek-v4.1-flash" */
  model?: string
  /** 原始报错(截断),便于对照服务商文档或工单 */
  detail: string
}

export interface FailureInput {
  status?: number
  message: string
  requestId?: string
  model?: string
  /** 是否由用户主动取消引起(fetch abort) */
  aborted?: boolean
}

const AUTH_HINTS = 'Key 无效、被撤销,或这个账号没有该模型权限。到 设置 → 对话服务 检查 API Key,或换一个能访问该模型的 Key'
const QUOTA_HINTS = '账户余额/额度不足。到服务商控制台充值,或换一个 Key/服务'
const RATE_HINTS = '请求太频繁被限流。等几秒再试,或换一个不共享配额的模型/服务'
const UPSTREAM_HINTS =
  '这是服务商/网关那边该模型的端点故障,不是本机网络或配置问题。已自动重试并尝试后备模型;仍失败就换一个模型,或稍后再试'
const MODEL_HINTS = '这个模型在这家服务上不可用(名字写错,或当前 Key 无权访问)。到 设置 → 模型设置 核对模型 ID,或换一个模型'
const PROTOCOL_HINTS =
  '该模型不提供 OpenAI Chat 协议(常见于只提供 /responses 或 Anthropic 协议的模型)。到 设置 → 模型设置 把「请求规范」改成对应的格式'
const ENDPOINT_HINTS = '地址路径可能配错了。检查 设置 → 连接 里的 Base URL,以及模型设置里的请求路径'
const NETWORK_HINTS = '连不上服务:检查网络/代理是否可用,或服务域名是否已更换'
const TIMEOUT_HINTS = '请求超时。网络慢或服务端排队;稍后重试,或在 设置 → 通用 里调大对话空闲超时'

function info(kind: FailureKind, title: string, hint: string, transient = false, modelSpecific = false): FailureInfo {
  return { kind, title, hint, transient, modelSpecific }
}

/** 归类一条失败(输入已归一化的 status + 文案) */
export function classifyFailure(input: FailureInput): FailureInfo {
  const m = (input.message ?? '').toLowerCase()
  const has = (...needles: string[]): boolean => needles.some((n) => m.includes(n))
  const status = input.status

  if (input.aborted || has('已取消', 'aborted', 'aborterror')) return info('aborted', '已取消', '')

  // 本地配置缺项:先于网络类判断,否则会被当成"连不上"
  if (has('配置不完整', '未配置 api key', '配置不完整(缺', '尚未配置对话服务')) {
    return info('config', '本地配置不完整', '到 设置 里补齐服务地址、API Key 与模型名')
  }

  // 鉴权:401/403,以及网关把 Key 问题包成 200/503 的文案
  if (status === 401 || status === 403 || has('invalid credential', 'invalid api key', 'invalid_api_key', 'authentication fails', 'unauthorized', 'invalid authentication')) {
    return info('auth', 'API Key 无效或无权限', AUTH_HINTS)
  }

  if (has('insufficient', 'quota', 'balance', '余额', '额度不足', '欠费', 'no credit')) {
    return info('quota', '额度不足', QUOTA_HINTS)
  }

  // 说明:有的网关把"无权访问该模型"也回 401/403(上面已拦),剩下的按 429 处理
  if (status === 429 || has('rate limit', 'rate_limit', 'too many requests', '并发限制')) {
    return info('rate_limit', '触发限流', RATE_HINTS, true, true)
  }

  // 协议不匹配:模型只提供 /responses 等其它规范(必须在 model_missing 之前判)
  if (has('does not support this protocol', 'unsupported protocol', 'protocol not supported', 'only supports the responses')) {
    return info('model_protocol', '该模型不支持当前协议', PROTOCOL_HINTS, false, true)
  }

  // 模型级不可用:OpenCode 的 "Upstream request failed: Model is unavailable." 走这里
  if (
    has('model is unavailable', 'model is not available', 'model_not_found', 'model does not exist', 'unknown model', 'invalid model', 'no such model', '模型不存在', '模型不可用') ||
    ((status === 400 || status === 404 || status === 422) && has('model') && has('unavailable', 'not found', 'does not exist', 'unknown', 'invalid', 'no access'))
  ) {
    return info('model_missing', '该模型不可用', MODEL_HINTS, false, true)
  }

  // 上游端点故障:5xx/网关类文案(OpenCode Go 的 "Endpoint is unavailable." 是这里的典型)
  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    has('endpoint is unavailable', 'service unavailable', 'bad gateway', 'gateway timeout', 'upstream request failed', 'internal server error', 'upstream error', 'server_error')
  ) {
    return info('upstream', '上游端点不可用', UPSTREAM_HINTS, true, true)
  }

  if (status === 404 || has('endpoint not found', 'no route', '404 page not found')) {
    return info('endpoint', '接口地址不存在', ENDPOINT_HINTS)
  }

  if (
    has('fetch failed', 'enotfound', 'econnrefused', 'econnreset', 'eai_again', 'socket hang up', 'network error', 'net::err_', 'getaddrinfo', 'connect timeout', 'etimedout')
  ) {
    return info('network', '网络连不上服务', NETWORK_HINTS, true)
  }

  if (status === 408 || has('timeout', 'timed out', '请求超时')) {
    return info('timeout', '请求超时', TIMEOUT_HINTS, true)
  }

  if (status === 400 || status === 422) {
    return info('unknown', '请求被服务端拒绝', '把下面的原始报错发给我,我按它调整请求字段')
  }

  return info('unknown', '请求失败', '稍后重试;反复失败请把下面的原始报错发给我')
}

/** 组装可落盘/可展示的失败摘要 */
export function summarizeFailure(input: FailureInput): FailureSummary {
  const base = classifyFailure(input)
  return {
    ...base,
    status: input.status,
    requestId: input.requestId,
    model: input.model,
    detail: (input.message ?? '').slice(0, 400)
  }
}

/** 一句话标题(带 HTTP 码与模型),用于列表/日志 */
export function failureHeadline(s: FailureSummary): string {
  const bits = [s.title]
  if (s.status) bits.push(`HTTP ${s.status}`)
  if (s.model) bits.push(s.model)
  return bits.join(' · ')
}

/** 兼容旧字段 `message.error`:一行说清"谁挂了 + 原始报错" */
export function failureText(s: FailureSummary): string {
  const who = s.model ? `[${s.model}] ` : ''
  const original = s.detail.trim()
  return original ? `${s.title}:${who}${original}` : `${who}${s.title}`
}

/** 是否值得在「本次尝试还没有任何输出」的前提下自动重试 */
export function shouldRetry(s: FailureSummary): boolean {
  return s.transient && s.kind !== 'aborted'
}

/** 是否值得换一个模型再试(用户取消、本地配置缺项除外:换模型救不了) */
export function shouldSwitchModel(s: FailureSummary): boolean {
  return s.kind !== 'aborted' && s.kind !== 'config'
}
