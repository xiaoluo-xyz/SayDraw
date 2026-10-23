import { useEffect, useRef, useState } from 'react'
import { assetUrl } from '@shared/ipc'
import { failureHeadline } from '@shared/failure'
import type { ChatMessage, ImageAsset, MessageBlock } from '@shared/types'
import { useChatStore, selectStreaming } from '../stores/chat'
import { useComposerStore } from '../stores/composer'
import { useCanvasStore } from '../stores/canvas'
import { useViewerStore } from '../stores/viewer'
import { fmtDuration, STOP_LABEL } from '../lib/format'
import { renderMarkdown } from '../lib/markdown'
import ToolCard from './ToolCard'
import ReasoningBlock from './ReasoningBlock'
import GeneratingCard from './GeneratingCard'

/** 流式期间的 500ms 心跳,驱动"已用 X 秒"实时刷新 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export default function ChatPanel() {
  const sessionId = useChatStore((s) => s.sessionId)
  const streaming = useChatStore(selectStreaming(sessionId))
  const messages = useChatStore((s) => s.messages)
  const lastError = useChatStore((s) => s.lastError)
  const setInputText = useChatStore((s) => s.setInputText)
  const containerRef = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(true)
  const [dragOver, setDragOver] = useState(false)
  const addFiles = useComposerStore((s) => s.addFiles)
  const now = useNow(Boolean(streaming?.active))

  const blocksKey = streaming ? streaming.blocks.map((b) => b.text?.length ?? (b.tool?.id ?? '') + b.tool?.status).join('|') : ''
  useEffect(() => {
    const el = containerRef.current
    if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages.length, blocksKey, lastError, now])

  const onScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  // 流式中的"进行中"消息
  const liveMessage: ChatMessage | null = streaming
    ? {
        id: 'live',
        sessionId: '',
        role: 'assistant',
        text: '',
        blocks: streaming.blocks,
        assetIds: streaming.assetIds,
        createdAt: streaming.startedAt,
        startedAt: streaming.startedAt
      }
    : null

  return (
    <div
      className="relative flex-1 overflow-y-auto px-4 py-4"
      ref={containerRef}
      onScroll={onScroll}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-emerald-500 bg-emerald-500/10 text-sm text-emerald-300">
          松开以添加图片
        </div>
      )}

      {messages.length === 0 && !streaming ? (
        <EmptyState onPick={(t) => setInputText(t)} />
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {messages.map((m, i) => {
            if (m.role === 'user') return <UserTurn key={m.id} message={m} />
            // 重试 = 把这条消息之前最后一条用户消息重发一遍(会话不变,失败痕迹保留)
            const lastUser = [...messages.slice(0, i)].reverse().find((x) => x.role === 'user' && x.text.trim())
            return (
              <AssistantTurn
                key={m.id}
                message={m}
                now={now}
                onRetry={lastUser ? () => void useChatStore.getState().send(lastUser.text) : undefined}
              />
            )
          })}
          {liveMessage && <AssistantTurn message={liveMessage} now={now} live notices={streaming?.notices} />}
        </div>
      )}
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const suggestions = [
    '画一张赛博朋克风格的城市夜景壁纸',
    '帮我设计一个简约风格的 App 图标',
    '看看我的项目文件夹里有什么素材',
    '我想修改一张图片(先发图,再告诉我怎么改)'
  ]
  return (
    <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-2xl">
        🎨
      </div>
      <div>
        <h2 className="text-lg font-semibold">你好,我是你的图像创作 Agent</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          告诉我你想画什么,我会先和你确认需求细节(主体、风格、比例、用途),
          <br />
          达成一致后再调用生图模型;不满意可以继续对话修改,也可以涂抹蒙版做局部重绘。
        </p>
      </div>
      <div className="grid w-full grid-cols-1 gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-left text-sm text-zinc-300 transition-colors hover:border-emerald-500/50 hover:bg-zinc-800/60"
            onClick={() => onPick(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------- 用户消息 ----------

function UserTurn({ message }: { message: ChatMessage }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <MessageImages assetIds={message.assetIds} dense />
      {message.fileTexts && message.fileTexts.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {message.fileTexts.map((f) => (
            <span key={f.name} className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-2 py-1 text-[11px] text-zinc-300">
              📄 {f.name}
            </span>
          ))}
        </div>
      )}
      {message.text && (
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-emerald-600 px-4 py-2.5 text-sm leading-relaxed text-white">
          {message.text}
        </div>
      )}
    </div>
  )
}

// ---------- 助手消息(块式) ----------

function AssistantTurn({
  message,
  now,
  live = false,
  notices,
  onRetry
}: {
  message: ChatMessage
  now: number
  live?: boolean
  /** 流式中的过程提示(自动重试 / 临时换模型) */
  notices?: string[]
  onRetry?: () => void
}) {
  const blocks = normalizeBlocks(message)
  const hasToolRunning = blocks.some((b) => b.type === 'tool' && b.tool?.status === 'running')
  const noticeList = notices ?? message.notices ?? []
  const failure = message.failure

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-xs">
        ✦
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {live && (
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-500 border-t-transparent" />
            {blocks.length === 0 || blocks.every((b) => b.type === 'reasoning' && b.endedAt === undefined) ? '思考中' : '处理中'}
            · 已用 <span className="tabular-nums">{fmtDuration(now - (message.startedAt ?? Date.now()))}</span>
          </div>
        )}

        {/* 过程提示:自动重试、临时换后备模型 —— 按时间顺序排在正文之前,否则用户不知道"为什么答得不一样" */}
        {noticeList.length > 0 && (
          <div className="flex flex-col gap-1">
            {noticeList.map((n, i) => (
              <div
                key={i}
                className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-300"
              >
                ⚠ {n}
              </div>
            ))}
          </div>
        )}

        {blocks.map((block, i) => {
          if (block.type === 'reasoning') return <ReasoningBlock key={i} block={block} live={live} now={now} />
          if (block.type === 'tool' && block.tool) {
            const isImageTool = block.tool.name === 'generate_image' || block.tool.name === 'edit_image'
            return (
              <div key={block.tool.id} className="flex flex-col gap-2">
                <ToolCard call={block.tool} now={now} />
                {/* 生图/编辑执行中:流光占位动画展示生成过程 */}
                {block.tool.status === 'running' && isImageTool && (
                  <GeneratingCard
                    startedAt={block.tool.startedAt}
                    label={block.tool.name === 'generate_image' ? '正在生成图片' : '正在编辑图片'}
                    now={now}
                  />
                )}
              </div>
            )
          }
          if (block.type === 'text' && block.text) {
            return <div key={i} className="md assistant-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />
          }
          return null
        })}

        <MessageImages assetIds={message.assetIds} />

        {live && blocks.length === 0 && !hasToolRunning && (
          <div className="rounded-2xl bg-zinc-800/50 px-4 py-2 text-xs text-zinc-400">连接模型中…</div>
        )}

        {!live && message.durationMs !== undefined && message.stopReason && (
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-dashed border-zinc-800 pt-1.5 text-[11px] text-zinc-500">
            <span className={`font-medium ${STOP_LABEL[message.stopReason]?.cls ?? ''}`}>
              {STOP_LABEL[message.stopReason]?.text ?? message.stopReason}
            </span>
            <span>· 用时 {fmtDuration(message.durationMs)}</span>
            {message.assetIds.length > 0 && <span>· 产出 {message.assetIds.length} 张图</span>}
            {message.modelFallbackFrom && message.modelUsed && (
              <span className="text-amber-400/80">· 本轮由 {message.modelUsed} 代跑</span>
            )}
          </div>
        )}

        {/* 失败诊断:谁挂了 / 为什么 / 该怎么办 + 一键重试(以前只有一句英文报错) */}
        {!live && message.error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-300">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 font-medium">
                {failure ? failureHeadline(failure) : message.error}
              </div>
              {onRetry && (
                <button
                  className="shrink-0 rounded-md border border-red-400/40 px-2 py-0.5 text-[11px] text-red-200 transition-colors hover:bg-red-500/20"
                  onClick={onRetry}
                  title="用同一条消息重发(会沿用当前设置里的模型)"
                >
                  ↻ 重试
                </button>
              )}
            </div>
            {failure ? (
              <>
                {failure.hint && <div className="mt-1 text-red-200/85">建议:{failure.hint}</div>}
                {failure.requestId && (
                  <div className="mt-1 text-red-300/60">请求号 {failure.requestId}(报障时可用它找服务商核对)</div>
                )}
                {failure.detail && (
                  <details className="mt-1">
                    <summary className="cursor-pointer select-none text-red-300/70">原始报错</summary>
                    <div className="mt-1 break-all font-mono text-[10px] text-red-300/70">{failure.detail}</div>
                  </details>
                )}
              </>
            ) : (
              <div className="mt-1">{message.error}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 旧消息(无 blocks)回退为平铺块序列:思考 → 工具 → 文本 */
function normalizeBlocks(message: ChatMessage): MessageBlock[] {
  if (message.blocks && message.blocks.length > 0) return message.blocks
  const blocks: MessageBlock[] = []
  if (message.reasoning?.trim()) blocks.push({ type: 'reasoning', text: message.reasoning })
  for (const call of message.toolCalls ?? []) blocks.push({ type: 'tool', tool: call })
  if (message.text.trim()) blocks.push({ type: 'text', text: message.text })
  return blocks
}

function MessageImages({ assetIds, dense = false }: { assetIds: string[]; dense?: boolean }) {
  const assets = useChatStore((s) => s.assets)
  const setBase = useCanvasStore((s) => s.setBase)
  const visible = assetIds
    .map((id) => assets[id])
    .filter((a): a is ImageAsset => Boolean(a) && a.kind !== 'mask' && a.kind !== 'annotation')
  if (visible.length === 0) return null
  return (
    <div className={`flex flex-wrap gap-2 ${dense ? 'justify-end' : ''}`}>
      {visible.map((asset) => (
        <button
          key={asset.id}
          className="group relative overflow-hidden rounded-xl border border-zinc-700/60 bg-zinc-900 transition-all hover:border-emerald-500/70"
          onClick={() => setBase(asset.id)}
          onDoubleClick={() => useViewerStore.getState().open(asset.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            void window.api.assets.contextMenu(asset.id)
          }}
          title="单击在画布查看 · 双击放大 · 右键复制/另存为"
        >
          <img
            src={assetUrl(asset.sessionId, asset.fileName)}
            alt={asset.kind}
            className={dense ? 'max-h-24 max-w-[160px] object-cover' : 'max-h-72 max-w-full object-contain'}
          />
          <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-300">
            {asset.kind === 'generated' ? '生成' : asset.kind === 'edited' ? '编辑' : '上传'}
          </span>
        </button>
      ))}
    </div>
  )
}
