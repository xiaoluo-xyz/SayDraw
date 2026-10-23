import { useMemo, useRef, useState } from 'react'
import { BRIEF_SLOTS } from '@shared/types'
import { BRIEF_TEMPLATES } from '@shared/templates'
import { compileBriefPrompt } from '@shared/promptCompiler'
import { useChatStore } from '../stores/chat'

export default function BriefPanel() {
  const brief = useChatStore((s) => s.brief)
  const sessionId = useChatStore((s) => s.sessionId)
  const send = useChatStore((s) => s.send)
  const streamingActive = useChatStore((s) => (s.sessionId ? Boolean(s.streamingBySession[s.sessionId]?.active) : false))
  const messages = useChatStore((s) => s.messages)

  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const previewRef = useRef<HTMLDetailsElement>(null)

  const hasSubject = Boolean(brief.subject?.trim())
  const hasRatio = Boolean(brief.aspectRatio?.trim())
  const ready = hasSubject && hasRatio && !brief.confirmedAt
  const empty = messages.length === 0
  const preview = useMemo(() => compileBriefPrompt(brief), [brief])

  const applyTemplate = async (id: string): Promise<void> => {
    const tpl = BRIEF_TEMPLATES.find((t) => t.id === id)
    if (!tpl || !sessionId) return
    setTemplatesOpen(false)
    // 不覆盖用户已经写好的主体/补充说明,其余槽位按模板填
    const patch = { ...tpl.brief }
    await window.api.brief.patch(sessionId, patch)
  }

  const copyPreview = async (): Promise<void> => {
    if (!preview) return
    try {
      await navigator.clipboard.writeText(preview)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时保持静默,用户可以手动选中复制
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-[#15171c]">
      <header className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-zinc-300">📋 需求规格</h2>
        <div className="flex items-center gap-1.5">
          <button
            className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
            title="套用常见场景模板,一键填好风格/构图/比例/规避项(需求会回到待确认)"
            onClick={() => setTemplatesOpen((v) => !v)}
          >
            📐 模板
          </button>
          {brief.confirmedAt ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">已确认</span>
          ) : (
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">待确认</span>
          )}
        </div>
      </header>

      {templatesOpen && (
        <div className="border-b border-zinc-800/80 bg-[#191c22] px-2.5 py-2">
          <div className="grid grid-cols-2 gap-1.5">
            {BRIEF_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                className="rounded-lg border border-zinc-700 bg-zinc-800/40 px-2 py-1.5 text-left hover:border-emerald-500/70 hover:bg-emerald-500/10"
                title={`${tpl.hint}\n骨架:${tpl.skeleton}`}
                onClick={() => void applyTemplate(tpl.id)}
              >
                <span className="block text-[11px] text-zinc-200">
                  {tpl.emoji} {tpl.name}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-zinc-500">{tpl.hint}</span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-600">套用模板会填好槽位并让需求回到「待确认」,不会直接生成。</p>
        </div>
      )}

      <div className="space-y-1.5 px-3 py-2.5">
        {empty && <p className="py-2 text-center text-[11px] text-zinc-600">开始对话后,AI 会在这里逐步记录需求</p>}
        {BRIEF_SLOTS.map((slot) => {
          const value = brief[slot.key]
          const filled = typeof value === 'string' && value.trim()
          return (
            <div key={slot.key} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 w-14 shrink-0 ${slot.required ? 'text-zinc-300' : 'text-zinc-500'}`}>
                {slot.required && <span className="mr-0.5 text-emerald-400">*</span>}
                {slot.label}
              </span>
              {filled ? (
                <span className="min-w-0 flex-1 break-words rounded bg-zinc-800/70 px-1.5 py-0.5 text-zinc-200">{value}</span>
              ) : (
                <span className="flex-1 text-zinc-600">{slot.hint}</span>
              )}
            </div>
          )
        })}
      </div>

      <details ref={previewRef} className="border-t border-zinc-800/80 px-3 py-2">
        <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">
          🔤 提示词编译预览{preview ? '' : '(填槽后生成)'}
        </summary>
        {preview ? (
          <div className="mt-1.5 space-y-1.5">
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-900/70 px-2 py-1.5 text-[10px] leading-relaxed text-zinc-300">
              {preview}
            </pre>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                onClick={() => void copyPreview()}
              >
                {copied ? '已复制' : '复制提示词'}
              </button>
              <span className="text-[10px] text-zinc-600">生成时会自动追加这段约束</span>
            </div>
          </div>
        ) : (
          <p className="mt-1.5 text-[10px] text-zinc-600">填好主体后,这里会实时编译出可直接使用的提示词。</p>
        )}
      </details>

      <div className="border-t border-zinc-800/80 px-3 py-2.5">
        {brief.confirmedAt ? (
          <p className="text-[11px] leading-relaxed text-zinc-500">需求已确认。生成后如需调整,继续对话即可(重大修改会重新确认)。</p>
        ) : ready ? (
          <button
            disabled={streamingActive}
            className="w-full rounded-lg bg-emerald-600 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
            onClick={() => void send('我确认以上需求摘要,请开始生成图片。', [], true)}
          >
            ✓ 确认需求,开始生成
          </button>
        ) : (
          <p className="text-[11px] leading-relaxed text-zinc-500">
            带星号的槽位补齐后可一键确认;AI 也会主动向你提问补齐需求。
          </p>
        )}
      </div>
    </section>
  )
}
