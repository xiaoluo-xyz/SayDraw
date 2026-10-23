// 对话请求的「重试 + 后备模型」编排:主模型挂了不让用户空手而归。
//
// 背景(2026-10-21 实测 OpenCode Go):同一个 Key,`deepseek-v4.1-flash` 与 `deepseek-v4-pro`
// 的端点在网关侧 503 "Endpoint is unavailable",而同 Key 的 glm-5.3 / kimi / qwen 全部正常 ——
// 说明这是**模型级上游故障**,换模型就能继续干活。此前的实现一次失败就落一条"出错"消息,
// 用户既不知道是谁挂的,也没有第二次机会。
//
// 策略:
//   1) 同一模型内对"抖动类"失败(index 0 时)退避重试;
//   2) 仅当**本次尝试还没有任何输出**时才重试/换模型(否则界面已吐出半截文字,重来会重复);
//   3) 仍失败则按计划换后备模型(不同连接优先),并在对话里明确告知"本轮谁代跑";
//   4) 全部失败时把**最有用的一次诊断**带出去(优先主模型的),而不是最后一条無關报错。

import type { ChatProfile } from '@shared/types'
import { summarizeFailure, shouldRetry, shouldSwitchModel, type FailureSummary } from '@shared/failure'
import type { ChatStreamResult } from '../providers/chat'
import { ApiError, errText } from '../providers/http'

export interface ChatRecoveryOptions {
  /** 依次尝试的模型(第一个是用户选的;发生切换后调用方应把它放到首位继续用) */
  profiles: ChatProfile[]
  /** 单模型内的重试间隔(长度 = 额外重试次数);默认 [600, 1600] */
  retryDelaysMs?: number[]
  /** 真正发一次请求;每收到一段增量就调一次 onProgress(用于判断"已产出,不能再重来") */
  attempt: (profile: ChatProfile, onProgress: () => void) => Promise<ChatStreamResult>
  signal?: AbortSignal
  /** 过程提示(重试中 / 临时换模型),调用方负责展示与落盘 */
  emitNotice?: (level: 'info' | 'warn', message: string) => void
  /** 注入 sleep 便于测试 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface ChatRecoveryResult {
  result: ChatStreamResult
  /** 实际成功的模型 */
  profile: ChatProfile
  notices: string[]
  /** 主模型失败时的诊断(发生过切换才存在) */
  primaryFailure?: FailureSummary
}

/** 全部模型都失败:带上主模型的诊断与每一次尝试,供界面给出可执行的建议 */
export class ChatRunError extends Error {
  failure: FailureSummary
  primary: ChatProfile
  attempts: { model: string; failure: FailureSummary }[]
  notices: string[]
  constructor(params: {
    failure: FailureSummary
    primary: ChatProfile
    attempts: { model: string; failure: FailureSummary }[]
    notices: string[]
  }) {
    super(params.failure.title)
    this.name = 'ChatRunError'
    this.failure = params.failure
    this.primary = params.primary
    this.attempts = params.attempts
    this.notices = params.notices
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('已取消'), { name: 'AbortError' }))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

function failureOf(err: unknown, profile: ChatProfile): FailureSummary {
  const apiErr = err instanceof ApiError ? err : undefined
  const aborted = err instanceof Error && err.name === 'AbortError'
  return summarizeFailure({
    status: apiErr?.status,
    requestId: apiErr?.requestId,
    message: errText(err),
    model: profile.name || profile.model,
    aborted
  })
}

const DEFAULT_RETRY_DELAYS = [600, 1600]

/**
 * 按 profiles 顺序尝试,单个模型内按 retryDelaysMs 退避重试。
 * 抛出 ChatRunError 时一定带得出"谁挂了、为什么、试了哪些"。
 */
export async function streamChatWithRecovery(opts: ChatRecoveryOptions): Promise<ChatRecoveryResult> {
  const profiles = opts.profiles.filter((p, i, arr) => p?.model && arr.findIndex((x) => x.id === p.id) === i)
  const primary = profiles[0]
  if (!primary) throw new Error('没有可用的对话模型')
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  const sleep = opts.sleep ?? defaultSleep
  const notices: string[] = []
  const attempts: { model: string; failure: FailureSummary }[] = []
  let primaryFailure: FailureSummary | undefined

  const notice = (level: 'info' | 'warn', message: string): void => {
    notices.push(message)
    opts.emitNotice?.(level, message)
  }

  for (let pi = 0; pi < profiles.length; pi++) {
    const profile = profiles[pi]
    const isPrimary = pi === 0
    // 只在主模型上做退避重试:后备模型是"再赌一次别的服务",多耗两轮等待没有意义
    const maxRetries = isPrimary ? delays.length : 0
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
      let produced = false
      try {
        const result = await opts.attempt(profile, () => {
          produced = true
        })
        // 成功:切换过模型时把主模型的诊断带回去(界面上要说明"谁没干活、谁代跑")
        return { result, profile, notices, primaryFailure }
      } catch (err) {
        const failure = failureOf(err, profile)
        if (opts.signal?.aborted || failure.kind === 'aborted') throw err
        if (isPrimary && !primaryFailure) primaryFailure = failure
        attempts.push({ model: profile.name || profile.model, failure })

        const canRetry = attempt < maxRetries && shouldRetry(failure) && !produced
        if (canRetry) {
          const wait = delays[attempt]
          notice(
            'warn',
            `「${profile.name}」${failure.title}${failure.status ? `(HTTP ${failure.status})` : ''},${(wait / 1000).toFixed(1)} 秒后重试(${attempt + 1}/${maxRetries})`
          )
          await sleep(wait, opts.signal)
          continue
        }

        // 本次尝试已经吐出内容:不能再换模型重来(界面/上下文都会重复),原样抛给上层的"中断"处理
        if (produced) throw err

        const next = profiles[pi + 1]
        if (next && shouldSwitchModel(failure)) {
          notice(
            'warn',
            `「${profile.name}」${failure.title}${failure.status ? `(HTTP ${failure.status})` : ''},本轮临时改用「${next.name}」继续`
          )
          break
        }

        throw new ChatRunError({ failure: primaryFailure ?? failure, primary, attempts, notices })
      }
    }
  }
  throw new ChatRunError({ failure: primaryFailure!, primary, attempts, notices })
}
