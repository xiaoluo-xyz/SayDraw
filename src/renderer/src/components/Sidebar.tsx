import { useEffect, useState } from 'react'
import { useSessionsStore } from '../stores/sessions'
import { useChatStore } from '../stores/chat'

export default function Sidebar() {
  const sessions = useSessionsStore((s) => s.sessions)
  const currentId = useSessionsStore((s) => s.currentId)
  const select = useSessionsStore((s) => s.select)
  const create = useSessionsStore((s) => s.create)
  const remove = useSessionsStore((s) => s.remove)
  const setSettingsOpen = useSessionsStore((s) => s.setSettingsOpen)
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.api.app
      .version()
      .then(setVersion)
      .catch(() => setVersion(''))
  }, [])

  return (
    <aside className="flex w-[220px] shrink-0 flex-col bg-[#0d0f13]">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600 text-sm font-bold">
          画
        </div>
        <span className="text-sm font-semibold tracking-wide">说画 <span className="text-[10px] font-normal text-zinc-500">SayDraw</span></span>
      </div>

      <div className="px-3">
        <button
          className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          onClick={() => void create()}
        >
          + 新会话
        </button>
      </div>

      <nav className="mt-3 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {sessions.map((s) => (
          <SessionItem key={s.id} id={s.id} title={s.title} active={s.id === currentId} onSelect={select} onRemove={remove} />
        ))}
      </nav>

      <div className="border-t border-zinc-800/80 px-4 py-3 text-[11px] text-zinc-600">
        <p>{version ? `v${version} · ` : ''}说画 SayDraw</p>
      </div>
    </aside>
  )
}

function SessionItem(props: {
  id: string
  title: string
  active: boolean
  onSelect: (id: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const running = useChatStore((s) => Boolean(s.streamingBySession[props.id]?.active))
  return (
    <div
      className={`group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
        props.active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
      }`}
      onClick={() => void props.onSelect(props.id)}
    >
      {running ? (
        <span
          className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-emerald-400 border-t-transparent"
          title="推理进行中,切走不会中断"
        />
      ) : (
        <span className="h-3 w-3 shrink-0" />
      )}
      <span className={`min-w-0 flex-1 truncate ${running ? 'text-zinc-200' : ''}`}>{props.title}</span>
      <button
        className="hidden shrink-0 rounded px-1 text-xs text-zinc-500 hover:text-red-400 group-hover:block"
        title="删除会话"
        onClick={(e) => {
          e.stopPropagation()
          if (window.confirm(`删除会话「${props.title}」及其全部图片?`)) void props.onRemove(props.id)
        }}
      >
        ✕
      </button>
    </div>
  )
}
