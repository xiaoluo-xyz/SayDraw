// 聊天状态:当前视图数据(消息/资产/需求规格)+ 按会话隔离的流式状态
// 流式状态与会话切换解耦:切走再切回,运行中的推理照常展示;多会话可并发运行

import { create } from 'zustand'
import type { AgentEvent, AgentQuestion, ChatMessage, ImageAsset, ImageBrief, MessageBlock, ToolCallRecord } from '@shared/types'

export interface StreamingState {
  active: boolean
  startedAt: number
  blocks: MessageBlock[]
  assetIds: string[]
  /** 本轮过程提示(自动重试 / 临时换模型) */
  notices: string[]
  error?: string
}

export interface PendingQuestion {
  callId?: string
  question: AgentQuestion
}

interface ChatStore {
  sessionId: string | null
  messages: ChatMessage[]
  assets: Record<string, ImageAsset>
  brief: ImageBrief
  /** 各会话独立的流式状态(键为 sessionId),不随切换丢失 */
  streamingBySession: Record<string, StreamingState>
  /** 各会话挂起的 ask_user 问答(键为 sessionId) */
  pendingQuestionBySession: Record<string, PendingQuestion>
  lastError: string | null
  inputText: string
  setInputText: (t: string) => void
  setError: (msg: string | null) => void
  loadFor: (sessionId: string) => Promise<void>
  reset: () => void
  send: (text: string, assetIds?: string[], confirmBrief?: boolean, fileTexts?: { name: string; content: string }[]) => Promise<void>
  cancel: () => Promise<void>
  /** 选用候选图:草稿 → 正式版本链 */
  promote: (assetId: string) => Promise<void>
  /** 同参再生成(结果由主进程推送 asset-added 事件后自动出现) */
  regenerate: (assetId: string) => Promise<ImageAsset | undefined>
  /** 本地登记一个已上传的资产(上传接口不广播事件) */
  upsertAsset: (asset: ImageAsset) => void
  handleEvent: (ev: AgentEvent) => void
}

/** 便捷选择器:取指定会话的流式状态 */
export const selectStreaming = (sessionId: string | null) => (s: ChatStore): StreamingState | undefined =>
  sessionId ? s.streamingBySession[sessionId] : undefined

/** 新文本块开始前,为仍在流式的思考块封口(endedAt),保证只有最后一个思考块在计时 */
function closeTrailingReasoning(blocks: MessageBlock[]): MessageBlock[] {
  const last = blocks[blocks.length - 1]
  if (last?.type === 'reasoning' && last.endedAt === undefined) {
    return [...blocks.slice(0, -1), { ...last, endedAt: Date.now() }]
  }
  return blocks
}

function appendToLastText(blocks: MessageBlock[], piece: string): MessageBlock[] {
  const last = blocks[blocks.length - 1]
  if (last?.type === 'text') {
    return [...blocks.slice(0, -1), { ...last, text: (last.text ?? '') + piece }]
  }
  return [...closeTrailingReasoning(blocks), { type: 'text', text: piece }]
}

function appendToLastReasoning(blocks: MessageBlock[], piece: string): MessageBlock[] {
  const last = blocks[blocks.length - 1]
  if (last?.type === 'reasoning') {
    return [...blocks.slice(0, -1), { ...last, text: (last.text ?? '') + piece }]
  }
  return [...blocks, { type: 'reasoning', text: piece, startedAt: Date.now() }]
}

function upsertToolBlock(blocks: MessageBlock[], call: ToolCallRecord): MessageBlock[] {
  const idx = blocks.findIndex((b) => b.type === 'tool' && b.tool?.id === call.id)
  if (idx >= 0) {
    const copy = [...blocks]
    copy[idx] = { type: 'tool', tool: call }
    return copy
  }
  return [...closeTrailingReasoning(blocks), { type: 'tool', tool: call }]
}

export const useChatStore = create<ChatStore>((set, get) => ({
  sessionId: null,
  messages: [],
  assets: {},
  brief: {},
  streamingBySession: {},
  pendingQuestionBySession: {},
  lastError: null,
  inputText: '',

  setInputText: (t) => set({ inputText: t }),

  setError: (msg) => set({ lastError: msg }),

  loadFor: async (sessionId) => {
    const data = await window.api.chat.history(sessionId)
    // 仅更新视图数据;各会话流式状态保留
    set((s) => ({
      sessionId,
      messages: data.messages,
      assets: data.assets,
      brief: data.brief,
      lastError: null,
      inputText: s.sessionId === sessionId ? s.inputText : ''
    }))
  },

  reset: () => set({ sessionId: null, messages: [], assets: {}, brief: {}, lastError: null, inputText: '' }),

  send: async (text, assetIds, confirmBrief, fileTexts) => {
    const { sessionId } = get()
    if (!sessionId) return
    set({ lastError: null, inputText: '' })
    await window.api.chat.send(sessionId, text, assetIds, confirmBrief, fileTexts)
  },

  cancel: async () => {
    const { sessionId } = get()
    if (sessionId) await window.api.chat.cancel(sessionId)
  },

  promote: async (assetId) => {
    const updated = await window.api.assets.promote(assetId)
    if (!updated) return
    set((s) => (s.assets[updated.id] ? { assets: { ...s.assets, [updated.id]: updated } } : {}))
  },

  regenerate: async (assetId) => {
    try {
      return await window.api.assets.regenerate(assetId)
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  },

  upsertAsset: (asset) => set((s) => ({ assets: { ...s.assets, [asset.id]: asset } })),

  handleEvent: (ev) => {
    const state = get()
    const cur = state.sessionId
    const isCurrentView = cur !== null && 'sessionId' in ev && ev.sessionId === cur

    // 无 sessionId 的事件(不应出现)仅作用于当前视图
    const sid = 'sessionId' in ev ? ev.sessionId : cur
    if (!sid) return

    const patchStreaming = (fn: (st: StreamingState) => StreamingState): void => {
      set((s) => {
        const prev = s.streamingBySession[sid] ?? { active: false, startedAt: Date.now(), blocks: [], assetIds: [], notices: [] }
        return { streamingBySession: { ...s.streamingBySession, [sid]: fn(prev) } }
      })
    }

    const clearQuestion = (): void => {
      set((s) => {
        if (!s.pendingQuestionBySession[sid]) return s
        const next = { ...s.pendingQuestionBySession }
        delete next[sid]
        return { pendingQuestionBySession: next }
      })
    }

    switch (ev.type) {
      case 'user-message':
        if (isCurrentView) set((s) => ({ messages: [...s.messages, ev.message] }))
        break
      case 'run-start':
        patchStreaming(() => ({ active: true, startedAt: Date.now(), blocks: [], assetIds: [], notices: [] }))
        if (isCurrentView) set({ lastError: null })
        break
      case 'delta':
        patchStreaming((st) => ({ ...st, blocks: appendToLastText(st.blocks, ev.text) }))
        break
      case 'reasoning-delta':
        patchStreaming((st) => ({ ...st, blocks: appendToLastReasoning(st.blocks, ev.text) }))
        break
      case 'notice':
        patchStreaming((st) => ({ ...st, notices: [...st.notices, ev.message] }))
        break
      case 'brief-updated':
        if (isCurrentView) set({ brief: ev.brief })
        break
      case 'tool-status':
        patchStreaming((st) => ({ ...st, blocks: upsertToolBlock(st.blocks, ev.call) }))
        // ask_user 工具完成(拿到答案)或失败 → 清除该会话的问答面板
        if (ev.call.name === 'ask_user' && ev.call.status !== 'running') clearQuestion()
        break
      case 'ask-user':
        set((s) => {
          const prevAsk = s.pendingQuestionBySession[sid]
          const runningAsk = (s.streamingBySession[sid]?.blocks ?? []).find(
            (b) => b.type === 'tool' && b.tool?.name === 'ask_user' && b.tool.status === 'running'
          )
          return {
            pendingQuestionBySession: {
              ...s.pendingQuestionBySession,
              [sid]: { callId: runningAsk?.tool?.id ?? prevAsk?.callId, question: ev.question }
            }
          }
        })
        break
      case 'asset-added':
        if (isCurrentView) set((s) => ({ assets: { ...s.assets, [ev.asset.id]: ev.asset } }))
        patchStreaming((st) => ({ ...st, assetIds: [...st.assetIds, ev.asset.id] }))
        break
      case 'message-final':
        if (isCurrentView) set((s) => ({ messages: [...s.messages, ev.message] }))
        set((s) => {
          const nextStream = { ...s.streamingBySession }
          const nextAsk = { ...s.pendingQuestionBySession }
          delete nextStream[sid]
          delete nextAsk[sid]
          return { streamingBySession: nextStream, pendingQuestionBySession: nextAsk }
        })
        break
      case 'error':
        if (isCurrentView) set({ lastError: ev.message })
        patchStreaming((st) => ({ ...st, active: false, error: ev.message }))
        break
      case 'run-end': {
        const st = get().streamingBySession[sid]
        clearQuestion()
        if (!st) break
        // 异常中断且无最终消息:仅在当前视图合成占位消息保留展示;切走的会话数据已由主进程落盘
        if (isCurrentView) {
          const hasContent = st.blocks.some((b) => (b.text ?? '').trim() || b.type === 'tool')
          if (hasContent) {
            const pseudo: ChatMessage = {
              id: `local-${Date.now()}`,
              sessionId: sid,
              role: 'assistant',
              text: st.blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
              blocks: st.blocks,
              assetIds: st.assetIds,
              notices: st.notices.length ? st.notices : undefined,
              startedAt: st.startedAt,
              durationMs: Date.now() - st.startedAt,
              stopReason: 'aborted',
              createdAt: Date.now()
            }
            set((s) => ({
              messages: [...s.messages, pseudo],
              streamingBySession: { ...s.streamingBySession, [sid]: { ...st, active: false } }
            }))
            break
          }
        }
        set((s) => {
          const next = { ...s.streamingBySession }
          delete next[sid]
          return { streamingBySession: next }
        })
        break
      }
    }
  }
}))
