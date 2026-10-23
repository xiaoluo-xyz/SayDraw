// Agent 编排循环:上下文构建 → LLM 流式 ↔ 工具调用 → 硬确认门 → 结果落盘
// 迭代次数不设上限,由模型自行判断进度;用户可随时取消
// 每轮产出按序 blocks(text / reasoning / tool),供前端块式渲染与折叠展示

import { randomUUID } from 'node:crypto'
import type { AgentEvent, ChatMessage, ChatProfile, FileTextAttachment, ImageAsset, ImageBrief, MessageBlock, ToolCallRecord } from '@shared/types'
import { failureText, summarizeFailure, type FailureSummary } from '@shared/failure'
import { getDb } from '../store/db'
import { getSettings } from '../store/settings'
import { prepareInlineImage } from '../store/inlineImage'
import { syncSpecFile } from '../store/projects'
import { streamChatCompletion, type ContentPart, type LLMMessage, type LLMToolCall } from '../providers/chat'
import { ApiError, errText } from '../providers/http'
import { parseExplicitSize } from '../providers/images'
import { cancelSessionQuestions } from './askUser'
import { ChatRunError, streamChatWithRecovery } from './recovery'
import { SYSTEM_PROMPT, buildStateBlock } from './systemPrompt'
import { TOOL_DEFS, executeTool, type ToolCtx } from './tools'

const activeRuns = new Map<string, AbortController>()

/** 单张图粗估 token(视觉模型通用量级) */
const IMAGE_TOKEN_EST = 1300
const FILE_TEXT_MAX = 16_000
/** 单次请求的内联图片总预算(base64 文本量);图片已压缩,这里是防"图多到把请求撑爆"的兜底 */
export const INLINE_BUDGET_BYTES = 8_000_000
/** 本轮新产出的图单独留的额度:刚画出来的图是本轮重点,不能因为历史图占满预算就被挤掉 */
const FRESH_IMAGE_RESERVE = 3_000_000

/** 内联图片预算账本:一次 run 内所有请求共用,分配时始终从最新的图往回给 */
interface InlineBudget {
  left: number
  used: number
  omitted: number
}

export function isRunning(sessionId: string): boolean {
  return activeRuns.has(sessionId)
}

export function cancelRun(sessionId: string): boolean {
  const ctrl = activeRuns.get(sessionId)
  if (!ctrl) return false
  ctrl.abort()
  return true
}

const KIND_LABEL: Record<string, string> = {
  'user-upload': '用户上传',
  generated: '生成',
  edited: '编辑',
  mask: '蒙版',
  annotation: '标注'
}

function estimateTextTokens(text: string): number {
  // 中英混合粗估:约 2 字符/token
  return Math.ceil(text.length / 2)
}

/** 按模型上下文窗口裁剪历史(保底最近 6 条,裁最老的) */
function trimByContextWindow(messages: LLMMessage[], contextWindow: number, maxOutputTokens: number): LLMMessage[] {
  const budget = Math.max(4000, contextWindow - maxOutputTokens - 1000)
  const estimate = (msgs: LLMMessage[]): number =>
    msgs.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + estimateTextTokens(m.content)
      let s = 0
      for (const part of m.content) {
        if (part.type === 'text') s += estimateTextTokens(part.text)
        else s += IMAGE_TOKEN_EST
      }
      return sum + s
    }, 0)

  const out = [...messages]
  while (estimate(out) > budget && out.length > 7) {
    // system 消息(首条)永不裁
    out.splice(1, 1)
  }
  return out
}

/** 图片在上下文里的文字标注(蒙版带额外说明) */
function assetNote(asset: ImageAsset): string {
  if (asset.kind === 'annotation') {
    if (asset.meta?.inspect) {
      return `[图片 ${asset.id}(分析用局部放大图,作用于 ${asset.baseAssetId ?? '底图'}:原图像素直接裁剪、没有重绘;只用来看清细节,不是交付成果)]`
    }
    return `[图片 ${asset.id}(坐标网格标注图,作用于 ${asset.baseAssetId ?? '底图'}:横竖各 10 格,每格 0.1;用它数格子读出 composite_image 的归一化坐标)]`
  }
  if (asset.kind === 'mask') {
    if (asset.label === 'overlay') {
      return `[图片 ${asset.id}(蒙版标注图,作用于 ${asset.baseAssetId ?? '上一张图'}:彩色编号 1/2/3… 标出各处修改位置——编号 n 的颜色区域即第 n 处修改,结合用户消息中的编号说明理解)`
    }
    return `[图片 ${asset.id}(接口蒙版,作用于 ${asset.baseAssetId ?? '上一张图'}:透明区域=待修改;调用 edit_image 时 maskAssetId 应传此图 ID)]`
  }
  return `[图片 ${asset.id}(${KIND_LABEL[asset.kind] ?? asset.kind})]`
}

/**
 * 按预算决定这次请求真正携带哪些图:从最新往回给(最近的画面最重要),
 * 预算用尽后更老的图不入请求,只在文本标注里留痕。
 * (导出以便脚本化验证:scripts/verify-fix.cjs)
 */
export function planInline(assetsInOrder: ImageAsset[], budget: InlineBudget): Set<string> {
  const allowed = new Set<string>()
  for (let i = assetsInOrder.length - 1; i >= 0; i--) {
    const asset = assetsInOrder[i]
    let bytes: number
    try {
      bytes = prepareInlineImage(asset).bytes
    } catch {
      continue // 文件缺失/不可读:当作这张图不存在
    }
    if (allowed.size > 0 && bytes > budget.left) {
      budget.omitted += 1
      continue
    }
    budget.left -= bytes
    budget.used += bytes
    allowed.add(asset.id)
  }
  return allowed
}

/** 构建图片标注 + 图片本体的 content parts(图片用压缩后的内联副本,名单外的不发送) */
function buildAssetParts(assets: ImageAsset[], visionEnabled: boolean, allowed?: Set<string>): ContentPart[] {
  const parts: ContentPart[] = []
  const notes: string[] = []
  for (const asset of assets) {
    let note = assetNote(asset)
    const sendable = visionEnabled && (!allowed || allowed.has(asset.id))
    if (sendable) {
      try {
        parts.push({ type: 'image_url', image_url: { url: prepareInlineImage(asset).dataUrl } })
      } catch {
        note = `${note}(读取失败,未发送)`
      }
    } else if (visionEnabled) {
      note = `${note}(未随本次请求发送:图片体积超出本次预算)`
    }
    notes.push(note)
  }
  return [{ type: 'text', text: notes.join('\n') }, ...parts.filter((p) => p.type === 'image_url')]
}

/** 把会话历史映射为 LLM 消息(缓存友好结构):
 * ① system 为静态文本(前缀缓存命中的前提)
 * ② 历史按序只读渲染,不随轮次变化
 * ③ 动态内容(需求规格状态/工作目录/最近图片)合并进最后一条 user 消息——尾部变化不破坏前缀 */
function buildContext(sessionId: string, brief: ImageBrief, inlineBudget: InlineBudget): LLMMessage[] {
  const db = getDb()
  const settings = getSettings().load()
  const history = db.messages(sessionId)
  const session = db.getSession(sessionId)
  const chatProfile = getSettings().activeChatProfile()
  const visionEnabled = chatProfile?.supportsVision !== false

  // 图片数量预算:只带最近 N 张(含蒙版),过老的丢弃
  const referenced: string[] = []
  for (const m of history) {
    for (const id of m.assetIds) referenced.push(id)
  }
  const budget = new Set(referenced.slice(-settings.maxHistoryImages))
  const attached = new Set<string>()

  // 先按"请求里的出现顺序"收集候选图,再按体积预算从最新往回分配(最近的画面最不能丢)
  const historyAssets = new Map<string, ImageAsset[]>()
  const candidates: ImageAsset[] = []
  for (const m of history) {
    if (m.role !== 'user') continue
    const assets = m.assetIds
      .map((id) => db.asset(id))
      .filter((a): a is ImageAsset => a !== undefined && budget.has(a.id))
    historyAssets.set(m.id, assets)
    candidates.push(...assets)
    for (const a of assets) attached.add(a.id)
  }

  // 尾部补充"尚未附着在历史中的最近图片",保证连续修图时模型看到最新画面
  const visionImages = visionEnabled
    ? db
        .assets(sessionId)
        .filter((a) => a.kind !== 'mask' && !attached.has(a.id))
        .slice(-Math.min(3, settings.maxHistoryImages))
    : []
  candidates.push(...visionImages)

  // 尾部兜底图可能比历史里的图更老,统一按创建时间排序后再分配,保证"最新的图最优先"
  const allowed = visionEnabled
    ? planInline([...candidates].sort((a, b) => a.createdAt - b.createdAt), inlineBudget)
    : new Set<string>()

  const messages: LLMMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  for (const m of history) {
    if (m.role === 'user') {
      const assets = historyAssets.get(m.id) ?? []
      const textParts: string[] = [m.text.trim() || '(用户发送了图片)']
      // 文本附件以引用块注入
      for (const f of m.fileTexts ?? []) {
        textParts.push(`[附件 ${f.name}]\n${f.content.slice(0, FILE_TEXT_MAX)}`)
      }
      if (assets.length) {
        const parts: ContentPart[] = [{ type: 'text', text: textParts.join('\n\n') }, ...buildAssetParts(assets, visionEnabled, allowed)]
        messages.push({ role: 'user', content: parts })
      } else {
        messages.push({ role: 'user', content: textParts.join('\n\n') })
      }
    } else {
      let text = m.text
      if (m.assetIds.length) text = `${text}\n[本轮产出图片:${m.assetIds.join(', ')}]`
      messages.push({ role: 'assistant', content: text })
    }
  }

  // 动态状态块:合并进最后一条 user 消息(轮次间唯一变化的部分)
  let stateText = buildStateBlock(brief, session?.projectPath)
  if (visionImages.length) {
    const parts = buildAssetParts(visionImages, true, allowed)
    const note = parts[0].type === 'text' ? parts[0].text : ''
    stateText += `\n\n【图片上下文】当前会话最近的图片(最新在后),供你了解当前画面状态:\n${note}`
    const last = messages[messages.length - 1]
    const imageParts = parts.filter((p) => p.type === 'image_url')
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content = [...last.content, { type: 'text', text: stateText }, ...imageParts]
    } else if (last && last.role === 'user') {
      last.content = [
        { type: 'text', text: `${last.content}\n\n${stateText}` },
        ...imageParts
      ]
    } else {
      messages.push({ role: 'user', content: [{ type: 'text', text: stateText }, ...imageParts] })
    }
  } else {
    const last = messages[messages.length - 1]
    if (last && last.role === 'user') {
      const text = typeof last.content === 'string' ? `${last.content}\n\n${stateText}` : null
      if (text !== null) last.content = text
      else if (Array.isArray(last.content)) last.content = [...last.content, { type: 'text', text: stateText }]
    } else {
      messages.push({ role: 'user', content: stateText })
    }
  }

  const contextWindow = chatProfile?.contextWindow || 65536
  const maxOutputTokens = chatProfile?.maxOutputTokens || 8192
  return trimByContextWindow(messages, contextWindow, maxOutputTokens)
}

/** 可并行执行的独立工具(只读/无顺序依赖);生图/编辑/填槽/提问等保持串行 */
const PARALLEL_SAFE = new Set(['list_directory', 'read_file', 'import_image', 'write_file', 'edit_file', 'move_file', 'copy_file'])

function toLlmToolCall(call: { id: string; name: string; args: Record<string, unknown> }): LLMToolCall {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) }
  }
}

export interface RunOptions {
  text: string
  assetIds?: string[]
  fileTexts?: FileTextAttachment[]
  /** 用户通过界面按钮确认需求(brief.confirmedAt 直接生效) */
  confirmBrief?: boolean
}

/** 确认门:①未确认需求禁止文生图 ②分辨率未明确禁止生成 ③本轮已生成过图片时继续调整需先经 ask_user 同意 */
function gateCheck(toolName: string, brief: ImageBrief, args: Record<string, unknown>, imageOps: number, askApproval: boolean): string | null {
  if (toolName === 'generate_image' && !brief.confirmedAt) {
    return (
      'REJECTED:需求规格尚未经用户确认,禁止生成。' +
      '请立即:1) 向用户分条复述完整需求摘要;2) 调用 ask_user 询问"确认无误,开始生成吗?"(选项如 确认生成/需要调整,推荐前者);' +
      '3) 用户确认后调用 update_brief(confirmed=true),再调用 generate_image。'
    )
  }
  if (toolName === 'generate_image' && !brief.resolution && !parseExplicitSize(String(args.size ?? ''))) {
    return (
      'REJECTED:输出分辨率未明确,禁止生成。' +
      '请先确定分辨率并结合用途给用户建议(头像/图标 1024x1024、社交配图/海报 2048x2048 或 2048x1152、壁纸/大图 3840x2160),\n' +
      "通过 update_brief(resolution='WxH') 记录进需求规格(或本次调用直接传 size='WxH'),然后重新调用 generate_image。"
    )
  }
  if ((toolName === 'generate_image' || toolName === 'edit_image') && imageOps >= 1 && !askApproval) {
    return (
      'REJECTED:本轮已生成过图片,继续调整需先征得用户同意。' +
      '请调用 ask_user 以选择题形式询问(如 保持这版[推荐] / 再调暗一点 / 换构图),用户同意后再重试本工具;' +
      '用户选择保留时应直接总结收尾,不再生成。'
    )
  }
  return null
}

/** 轮内展示块构建器:text / reasoning / tool 按发生顺序追加 */
class BlockCollector {
  blocks: MessageBlock[] = []
  text = ''
  reasoning = ''

  /** 关闭当前思考块(文本或工具开始时调用) */
  closeReasoning(): void {
    const last = this.blocks[this.blocks.length - 1]
    if (last?.type === 'reasoning') last.endedAt = Date.now()
  }

  pushReasoning(piece: string): void {
    const last = this.blocks[this.blocks.length - 1]
    if (last?.type === 'reasoning') {
      last.text = (last.text ?? '') + piece
    } else {
      this.closeReasoning()
      this.blocks.push({ type: 'reasoning', text: piece, startedAt: Date.now() })
    }
    this.reasoning += piece
  }

  pushText(piece: string): void {
    const last = this.blocks[this.blocks.length - 1]
    if (last?.type === 'text') {
      last.text = (last.text ?? '') + piece
    } else {
      this.closeReasoning()
      this.blocks.push({ type: 'text', text: piece })
    }
    this.text += piece
  }

  pushTool(record: ToolCallRecord): void {
    this.closeReasoning()
    this.blocks.push({ type: 'tool', tool: record })
  }

  finishReasoning(): void {
    this.closeReasoning()
  }
}

export async function runAgentTurn(sessionId: string, opts: RunOptions, emit: (ev: AgentEvent) => void): Promise<void> {
  if (activeRuns.has(sessionId)) throw new Error('当前会话正在处理中,请等待完成或点击停止')
  const db = getDb()
  const settingsStore = getSettings()
  const chatProfile = settingsStore.activeChatProfile()
  if (!chatProfile) throw new Error('尚未配置对话服务:请打开"设置"添加语言模型配置')

  const abort = new AbortController()
  activeRuns.set(sessionId, abort)

  const startedAt = Date.now()
  const collector = new BlockCollector()
  const toolRecords: ToolCallRecord[] = []
  const runAssetIds: string[] = []
  let stopReason: ChatMessage['stopReason'] = 'completed'
  // 迭代确认门状态:用户发消息即视为对本轮首个图片操作的授权;之后的自判微调需 ask_user 逐次确认
  let imageOps = 0
  let askApproval = false
  // 本次 run 的内联图片预算:一次请求里所有图共用(图片已压缩,这里是总量兜底)
  const inlineBudget: InlineBudget = { left: INLINE_BUDGET_BYTES, used: 0, omitted: 0 }
  // 实际在用的模型:主模型端点故障时会临时切到后备模型(只影响本轮,不改用户设置)
  let activeProfile: ChatProfile = chatProfile
  let fallbackFrom: string | undefined
  /** 本轮过程提示(自动重试 / 临时换模型),随消息落盘 */
  const notices: string[] = []

  /** 后备候选:已排除当前模型;不支持视觉的模型不能用(上下文里有图) */
  const fallbackCandidates = (keep: ChatProfile): ChatProfile[] =>
    settingsStore
      .fallbackChatProfiles(chatProfile.id)
      .filter((p) => p.id !== keep.id && p.supportsVision !== false)

  /** force=true 时即使一个字都没产出也落一条消息,保证"失败"在界面上留痕 */
  const finalize = (force = false): ChatMessage | null => {
    collector.finishReasoning()
    if (!force && !collector.text.trim() && !collector.reasoning.trim() && toolRecords.length === 0) return null
    return {
      id: randomUUID(),
      sessionId,
      role: 'assistant',
      text: collector.text.trim(),
      blocks: collector.blocks,
      assetIds: [...new Set(runAssetIds)],
      toolCalls: toolRecords,
      reasoning: collector.reasoning.trim() || undefined,
      createdAt: Date.now(),
      startedAt,
      durationMs: Date.now() - startedAt,
      stopReason,
      modelUsed: activeProfile.name,
      ...(fallbackFrom ? { modelFallbackFrom: fallbackFrom } : {}),
      ...(notices.length ? { notices: [...notices] } : {})
    }
  }

  try {
    emit({ type: 'run-start', sessionId })

    // 需求确认(界面按钮路径):直接开启确认门
    let brief = db.brief(sessionId)
    if (opts.confirmBrief && !brief.confirmedAt) {
      brief = db.patchBrief(sessionId, {}, true)
      emit({ type: 'brief-updated', sessionId, brief })
      syncSpecFile(sessionId)
    }

    const userMessage: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      text: opts.text,
      assetIds: opts.assetIds ?? [],
      fileTexts: opts.fileTexts,
      createdAt: Date.now()
    }
    db.addMessage(userMessage)
    emit({ type: 'user-message', sessionId, message: userMessage })

    const llmMessages = buildContext(sessionId, brief, inlineBudget)
    const timeoutMs = settingsStore.load().chatTimeoutMs

    // 无迭代上限:由模型自行判断何时结束(无工具调用的纯文本回复即结束)
    for (;;) {
      if (abort.signal.aborted) break
      brief = db.brief(sessionId)

      // 主模型 →(抖动则退避重试)→ 后备模型;失败时抛 ChatRunError 带出完整诊断
      const recovered = await streamChatWithRecovery({
        profiles: [activeProfile, ...fallbackCandidates(activeProfile)],
        attempt: (profile, onProgress) =>
          streamChatCompletion({
            profile,
            messages: llmMessages,
            tools: TOOL_DEFS,
            timeoutMs,
            sessionKey: sessionId,
            signal: abort.signal,
            onDelta: (t) => {
              onProgress()
              collector.pushText(t)
              emit({ type: 'delta', sessionId, text: t })
            },
            onReasoningDelta: (t) => {
              onProgress()
              collector.pushReasoning(t)
              emit({ type: 'reasoning-delta', sessionId, text: t })
            }
          }),
        signal: abort.signal,
        emitNotice: (level, message) => {
          notices.push(message)
          emit({ type: 'notice', sessionId, level, message })
        }
      })
      if (recovered.profile.id !== activeProfile.id) {
        fallbackFrom = activeProfile.name
        activeProfile = recovered.profile
      }
      const result = recovered.result

      if (result.toolCalls.length === 0) break

      llmMessages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.toolCalls.map(toLlmToolCall)
      })
      // 兜底:个别兼容端点不通过流式下发 content
      if (result.content && !collector.text) {
        collector.pushText(result.content)
        emit({ type: 'delta', sessionId, text: result.content })
      }

      const batchAssetIds: string[] = []
      for (let ci = 0; ci < result.toolCalls.length; ) {
        if (abort.signal.aborted) break
        const call = result.toolCalls[ci]

        if (PARALLEL_SAFE.has(call.name)) {
          // 连续的独立工具并行执行(减少轮询等待)
          let cj = ci
          const batch: typeof result.toolCalls = []
          while (cj < result.toolCalls.length && PARALLEL_SAFE.has(result.toolCalls[cj].name)) {
            batch.push(result.toolCalls[cj])
            cj++
          }
          const records: ToolCallRecord[] = batch.map((b) => ({ id: b.id, name: b.name, args: b.args, status: 'running', startedAt: Date.now() }))
          for (const record of records) {
            collector.pushTool(record)
            toolRecords.push(record)
            emit({ type: 'tool-status', sessionId, call: record })
          }
          const ctx: ToolCtx = { sessionId, signal: abort.signal, emit }
          // eslint-disable-next-line no-await-in-loop
          const rets = await Promise.all(batch.map((b) => executeTool(ctx, b.name, b.args)))
          rets.forEach((ret, k) => {
            const record = records[k]
            record.status = ret.ok ? 'ok' : 'error'
            record.resultSummary = ret.text.slice(0, 200)
            record.resultFull = ret.text.slice(0, 2000)
            record.assetIds = ret.assetIds
            record.error = ret.ok ? undefined : ret.text
            record.durationMs = Date.now() - (record.startedAt ?? Date.now())
            runAssetIds.push(...ret.assetIds)
            batchAssetIds.push(...ret.assetIds)
            emit({ type: 'tool-status', sessionId, call: record })
            llmMessages.push({ role: 'tool', tool_call_id: record.id, content: ret.text })
          })
          ci = cj
          continue
        }

        const record: ToolCallRecord = {
          id: call.id,
          name: call.name,
          args: call.args,
          status: 'running',
          startedAt: Date.now()
        }
        collector.pushTool(record)
        toolRecords.push(record)
        emit({ type: 'tool-status', sessionId, call: record })

        const rejection = gateCheck(call.name, brief, call.args, imageOps, askApproval)
        let resultText: string
        if (rejection) {
          record.status = 'rejected'
          record.resultSummary = '被确认门拦截:需求未确认'
          if (call.name === 'generate_image' || call.name === 'edit_image') record.resultSummary = '被迭代门拦截:需用户确认'
          record.resultFull = rejection
          record.durationMs = Date.now() - (record.startedAt ?? Date.now())
          resultText = rejection
        } else {
          const ctx: ToolCtx = { sessionId, signal: abort.signal, emit }
          // eslint-disable-next-line no-await-in-loop
          const ret = await executeTool(ctx, call.name, call.args)
          record.status = ret.ok ? 'ok' : 'error'
          record.resultSummary = ret.text.slice(0, 200)
          record.resultFull = ret.text.slice(0, 2000)
          record.assetIds = ret.assetIds
          record.error = ret.ok ? undefined : ret.text
          record.durationMs = Date.now() - (record.startedAt ?? Date.now())
          resultText = ret.text
          runAssetIds.push(...ret.assetIds)
          batchAssetIds.push(...ret.assetIds)
          // 迭代门状态推进:只有**真的产出/改动了图片**才算用掉一次授权;
          // 端点拒参、尺寸非法这类失败的重试不该把用户拉来点确认(2026-10-21 实测踩到)
          if ((call.name === 'generate_image' || call.name === 'edit_image') && ret.ok && ret.assetIds.length > 0) {
            imageOps += 1
            askApproval = false // 授权已消费
          }
          if (call.name === 'ask_user' && ret.ok) {
            askApproval = true // 用户刚作答,允许紧随的一次生成操作
          }
          if (call.name === 'update_brief') {
            brief = db.brief(sessionId)
            syncSpecFile(sessionId)
          }
        }
        emit({ type: 'tool-status', sessionId, call: record })

        llmMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: resultText
        })
        ci += 1
      }

      // 工具产出的图片回注上下文,让模型亲眼看到结果再决定下一步
      if (batchAssetIds.length && !abort.signal.aborted) {
        const assets = batchAssetIds.map((id) => db.asset(id)).filter((a): a is ImageAsset => a !== undefined)
        if (assets.length) {
          const visionEnabled = activeProfile.supportsVision !== false
          let allowed = new Set<string>()
          if (visionEnabled) {
            // 新产出的图走独立额度(至少 FRESH_IMAGE_RESERVE),用掉的量仍记进总账,保证请求体有上限
            const batchBudget: InlineBudget = {
              left: Math.max(inlineBudget.left, FRESH_IMAGE_RESERVE),
              used: 0,
              omitted: 0
            }
            allowed = planInline(assets, batchBudget)
            inlineBudget.left -= batchBudget.used
            inlineBudget.used += batchBudget.used
            inlineBudget.omitted += batchBudget.omitted
          }
          const parts = buildAssetParts(assets, visionEnabled, allowed)
          const notePart = parts[0]
          const note = notePart.type === 'text' ? notePart.text : ''
          llmMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `【工具产出图片】请查看以下图片实际效果,评估是否达标:\n${note}` },
              ...parts.filter((p) => p.type === 'image_url')
            ]
          })
        }
      }
    }

    if (abort.signal.aborted) stopReason = 'aborted'
    const finalMsg = finalize()
    if (finalMsg) {
      if (stopReason === 'aborted') finalMsg.text = `${finalMsg.text}\n\n[已停止]`
      db.addMessage(finalMsg)
      emit({ type: 'message-final', sessionId, message: finalMsg })
    }
  } catch (err) {
    cancelSessionQuestions(sessionId)
    if (err instanceof Error && err.name === 'AbortError') {
      stopReason = 'aborted'
      const finalMsg = finalize()
      if (finalMsg) {
        finalMsg.text = `${finalMsg.text}\n\n[已停止]`
        db.addMessage(finalMsg)
        emit({ type: 'message-final', sessionId, message: finalMsg })
      }
    } else {
      stopReason = 'error'
      // 失败诊断:recovery 抛的 ChatRunError 已带好"谁挂了 + 试了哪些模型";
      // 其它异常(建上下文、落盘等)现归类,同样给出可执行建议
      const failure: FailureSummary =
        err instanceof ChatRunError
          ? err.failure
          : summarizeFailure({
              status: err instanceof ApiError ? err.status : undefined,
              requestId: err instanceof ApiError ? err.requestId : undefined,
              message: errText(err),
              model: activeProfile.name
            })
      const tried = err instanceof ChatRunError && err.attempts.length > 1 ? err.attempts.map((a) => a.model) : []
      const reason = `${failureText(failure)}${failure.requestId ? `(请求号 ${failure.requestId})` : ''}${
        tried.length ? ` · 已尝试:${[...new Set(tried)].join(' / ')}` : ''
      }`
      emit({ type: 'error', sessionId, message: reason })
      // 即使本轮一个字都没产出,也落一条带失败原因的消息(否则用户只看到"没了")
      const finalMsg = finalize(true)
      if (finalMsg) {
        finalMsg.error = reason
        finalMsg.failure = failure
        db.addMessage(finalMsg)
        emit({ type: 'message-final', sessionId, message: finalMsg })
      }
    }
  } finally {
    activeRuns.delete(sessionId)
    emit({ type: 'run-end', sessionId })
  }
}
