import { useRef, useState } from 'react'
import type { AppSettings, ChatModel } from '@shared/types'
import { useChatStore, selectStreaming } from '../stores/chat'
import { useComposerStore } from '../stores/composer'
import { useCanvasStore } from '../stores/canvas'
import { useSettingsStore } from '../stores/settings'
import { useSessionsStore } from '../stores/sessions'
import ProjectBar from './ProjectBar'
import QuestionPanel from './QuestionPanel'

const DEFAULT_EFFORTS = ['none', 'low', 'medium', 'high', 'max']

/** 与 ModelPicker 同风格的轻量弹出选择器(替代原生 select,保证 UI 一致) */
function PopoverSelect(props: {
  value: string
  options: { value: string; label: string; hint?: string }[]
  disabled?: boolean
  mono?: boolean
  title?: string
  onChange: (value: string) => void
}) {
  const { value, options, disabled, mono, title } = props
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        className={`flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-xs text-zinc-300 transition-colors ${
          disabled ? 'opacity-50' : 'hover:bg-zinc-800 hover:text-zinc-100'
        } ${mono ? 'font-mono' : ''}`}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value}
        <span className="text-[9px] text-zinc-500">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-50 mb-2 max-h-72 min-w-32 overflow-y-auto rounded-xl border border-zinc-700 bg-[#1b1d23] p-1.5 shadow-2xl">
            {options.map((opt) => {
              const active = opt.value === value
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    active ? 'bg-emerald-500/15 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800'
                  }`}
                  onClick={() => {
                    props.onChange(opt.value)
                    setOpen(false)
                  }}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-emerald-400' : 'bg-transparent'}`} />
                  <span className={mono ? 'font-mono' : ''}>{opt.label}</span>
                  {opt.hint && <span className="ml-auto shrink-0 text-[9px] text-zinc-500">{opt.hint}</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** 模型选择器:按钮只显示模型名(完整),点击弹出按分组排列的菜单(参考 Claude 样式) */
function ModelPicker(props: {
  settings: AppSettings
  kind: 'chat' | 'image'
  value?: string
  disabled?: boolean
  onChange: (id: string) => void
}) {
  const { settings, kind, value, disabled } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const conns = kind === 'chat' ? settings.chatConnections : settings.imageConnections
  const models = kind === 'chat' ? settings.chatModels : settings.imageModels
  const current = models.find((m) => m.id === value)
  const noVision = (m: (typeof models)[number]): boolean => kind === 'chat' && (m as ChatModel).supportsVision === false

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        className={`flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-xs text-zinc-300 transition-colors ${
          disabled ? 'opacity-50' : 'hover:bg-zinc-800 hover:text-zinc-100'
        }`}
        onClick={() => setOpen((o) => !o)}
        title={current ? `${conns.find((c) => c.id === current.groupId)?.name ?? ''}/${current.model}` : '选择模型'}
      >
        {current ? current.model || current.name : '未配置模型'}
        <span className="text-[9px] text-zinc-500">▾</span>
      </button>

      {open && (
        <>
          {/* 点击外部关闭 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-50 mb-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-zinc-700 bg-[#1b1d23] p-1.5 shadow-2xl">
            {conns.map((conn) => {
              const groupModels = models.filter((m) => m.groupId === conn.id)
              if (!groupModels.length) return null
              return (
                <div key={conn.id} className="mb-1">
                  <p className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[10px] text-zinc-500">
                    <span className="h-px flex-1 bg-zinc-800" />
                    {conn.name}
                    <span className="h-px flex-1 bg-zinc-800" />
                  </p>
                  {groupModels.map((m) => {
                    const active = m.id === value
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                          active ? 'bg-emerald-500/15 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800'
                        }`}
                        onClick={() => {
                          props.onChange(m.id)
                          setOpen(false)
                        }}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-emerald-400' : 'bg-transparent'}`} />
                        <span className="min-w-0 flex-1 truncate">{m.model || m.name}</span>
                        {noVision(m) && <span className="shrink-0 text-[9px] text-amber-500/80">无视觉</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })}
            {models.length === 0 && <p className="px-3 py-4 text-center text-[11px] text-zinc-600">暂无模型,去设置添加</p>}
          </div>
        </>
      )}
    </div>
  )
}

export default function Composer() {
  const inputText = useChatStore((s) => s.inputText)
  const setInputText = useChatStore((s) => s.setInputText)
  const setError = useChatStore((s) => s.setError)
  const send = useChatStore((s) => s.send)
  const cancel = useChatStore((s) => s.cancel)
  const sessionId = useChatStore((s) => s.sessionId)
  const streamingActive = useChatStore((s) => (s.sessionId ? Boolean(s.streamingBySession[s.sessionId]?.active) : false))

  const pending = useComposerStore((s) => s.pending)
  const pendingTexts = useComposerStore((s) => s.pendingTexts)
  const addFiles = useComposerStore((s) => s.addFiles)
  const removeImage = useComposerStore((s) => s.removeImage)
  const removeText = useComposerStore((s) => s.removeText)
  const clearAttachments = useComposerStore((s) => s.clear)

  const maskDataUrl = useCanvasStore((s) => s.maskDataUrl)
  const overlayDataUrl = useCanvasStore((s) => s.overlayDataUrl)
  const maskStrokes = useCanvasStore((s) => s.strokes)
  const maskBaseAssetId = useCanvasStore((s) => s.maskBaseAssetId)
  const clearMask = useCanvasStore((s) => s.clearMask)

  // 底部工具栏:模型与强度配置直接读写全局设置(v3:连接分组 + 模型)
  const settings = useSettingsStore((s) => s.settings)
  const saveSettings = useSettingsStore((s) => s.save)
  const setActive = useSettingsStore((s) => s.setActive)
  const activeChat = settings.chatModels.find((m) => m.id === settings.activeChatModelId)

  /** 修改当前激活语言模型的推理强度;强度即思考控制(none=不思考,其余默认开启思考) */
  const patchActiveChat = async (patch: Record<string, unknown>): Promise<void> => {
    if (!activeChat) return
    await saveSettings({
      ...settings,
      chatModels: settings.chatModels.map((m) => (m.id === activeChat.id ? { ...m, ...patch } : m))
    })
  }

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const autoSize = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const doSend = async (): Promise<void> => {
    if (streamingActive || !sessionId) return
    const text = inputText.trim()
    const hasAttachments = pending.length > 0 || pendingTexts.length > 0
    const hasMask = Boolean(maskDataUrl && maskBaseAssetId)
    if (!text && !hasAttachments && !hasMask) return

    setInputText('')
    const images = [...pending]
    const texts = [...pendingTexts]
    clearAttachments()
    requestAnimationFrame(autoSize)

    const assetIds: string[] = []
    try {
      for (const att of images) {
        const asset = await window.api.assets.upload(sessionId, att.dataUrl, 'user-upload')
        assetIds.push(asset.id)
      }
      if (hasMask) {
        // 双蒙版:二值蒙版给 edits 接口,彩色编号标注图给模型理解(看得到每处修改的位置)
        const binaryAsset = await window.api.assets.upload(sessionId, maskDataUrl!, 'mask', maskBaseAssetId!, 'binary')
        assetIds.push(maskBaseAssetId!)
        if (overlayDataUrl) {
          const overlayAsset = await window.api.assets.upload(sessionId, overlayDataUrl, 'mask', maskBaseAssetId!, 'overlay')
          assetIds.push(binaryAsset.id, overlayAsset.id)
        } else {
          assetIds.push(binaryAsset.id)
        }
        clearMask()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    await send(text || '请按我涂抹的蒙版区域修改这张图', assetIds, false, texts)
  }

  return (
    <div className="shrink-0 border-t border-zinc-800/80 bg-[#131519] px-4 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
        <ProjectBar />
        <QuestionPanel />

        <div className="rounded-2xl border border-zinc-700/70 bg-zinc-900/70 focus-within:border-emerald-500/60 focus-within:shadow-[0_0_0_2px_rgba(16,185,129,0.15)]">
          {/* 附件行 */}
          {(pending.length > 0 || pendingTexts.length > 0 || (maskDataUrl && maskBaseAssetId)) && (
            <div className="flex flex-wrap gap-2 px-3 pt-2.5">
              {pending.map((att, i) => (
                <div key={att.name + i} className="group relative">
                  <img src={att.dataUrl} alt={att.name} className="h-12 w-12 rounded-lg border border-zinc-700 object-cover" />
                  <button
                    className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-[10px] text-zinc-300 group-hover:flex"
                    onClick={() => removeImage(i)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {pendingTexts.map((f, i) => (
                <button
                  key={f.name + i}
                  className="flex h-12 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 text-[11px] text-zinc-300 hover:border-red-500/50"
                  onClick={() => removeText(i)}
                  title={`${f.name} · 点击移除`}
                >
                  📄 <span className="max-w-[120px] truncate">{f.name}</span>
                </button>
              ))}
              {maskDataUrl && maskBaseAssetId && (
                <button
                  className="flex h-12 items-center gap-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 px-2.5 text-[11px] text-amber-300"
                  onClick={clearMask}
                  title="点击移除蒙版;多编号时发送消息需说明每个编号要改成什么"
                >
                  🖌 蒙版{maskStrokes.length ? ` · ${new Set(maskStrokes.map((s) => s.brushId)).size} 处编号` : ''}
                  <span className="text-amber-500/70">(移除)</span>
                </button>
              )}
            </div>
          )}

          {/* 输入框 */}
          <textarea
            ref={textareaRef}
            value={inputText}
            rows={2}
            placeholder={sessionId ? '描述你想画什么,或对图片提出修改要求…' : '请先创建会话'}
            disabled={!sessionId}
            className="max-h-40 min-h-[56px] w-full resize-none bg-transparent px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600"
            onChange={(e) => {
              setInputText(e.target.value)
              autoSize()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void doSend()
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
              if (files.length) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
          />

          {/* 底部工具栏(简约):+ 附件 ··· 生图模型 · 语言模型 · 强度 · 发送/停止 */}
          <div className="flex min-h-10 flex-wrap items-center gap-1 px-1.5 py-1">
            <button
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg font-light text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              title="添加图片或文件(图片作为参考图;md/txt 等文本作为上下文)"
              onClick={() => fileRef.current?.click()}
            >
              +
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />

            <span className="min-w-2 flex-1" />

            <ModelPicker
              settings={settings}
              kind="image"
              value={settings.activeImageModelId ?? undefined}
              disabled={streamingActive}
              onChange={(id) => void setActive('image', id)}
            />
            <ModelPicker
              settings={settings}
              kind="chat"
              value={settings.activeChatModelId ?? undefined}
              disabled={streamingActive}
              onChange={(id) => void setActive('chat', id)}
            />
            <PopoverSelect
              mono
              value={activeChat?.reasoningEffort ?? ''}
              disabled={!activeChat || streamingActive}
              title="Reasoning effort(默认开启思考;none = 不思考;档位在设置·模型配置中增删)"
              options={[
                { value: '', label: 'default', hint: '默认' },
                ...(activeChat?.effortLevels?.length ? activeChat.effortLevels : DEFAULT_EFFORTS).map((lv) => ({
                  value: lv,
                  label: lv
                })),
                // 当前值不在档位列表时保持可选
                ...(activeChat?.reasoningEffort &&
                !(activeChat.effortLevels?.length ? activeChat.effortLevels : DEFAULT_EFFORTS).includes(activeChat.reasoningEffort)
                  ? [{ value: activeChat.reasoningEffort, label: activeChat.reasoningEffort, hint: '当前' }]
                  : [])
              ]}
              onChange={(v) => void patchActiveChat({ reasoningEffort: v || undefined, thinkingMode: undefined })}
            />

            {streamingActive ? (
              <button
                className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 transition-colors hover:bg-red-500 hover:text-white"
                title="停止"
                onClick={() => void cancel()}
              >
                <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
              </button>
            ) : (
              <button
                className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-600/25 transition-all hover:bg-emerald-500 hover:shadow-emerald-500/40 disabled:opacity-30 disabled:shadow-none"
                title="发送"
                disabled={!sessionId || (!inputText.trim() && pending.length === 0 && pendingTexts.length === 0 && !(maskDataUrl && maskBaseAssetId))}
                onClick={() => void doSend()}
              >
                ➤
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 px-1 text-center text-[10px] text-zinc-600">Enter 发送 · Shift+Enter 换行 · 支持拖拽 / 粘贴图片</p>
      </div>
    </div>
  )
}
