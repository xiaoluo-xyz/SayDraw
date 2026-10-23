// 左侧会话列表:按「工作区(工作目录)」分组
// - 不在任何工作区的会话 = 独立会话,可以直接开画(不强制选目录)
// - 一个工作目录 = 一个工作区(总文件夹),标题右侧「＋」直接在该目录下新开会话

import { useEffect, useMemo, useState } from 'react'
import { useSessionsStore } from '../stores/sessions'
import { useChatStore } from '../stores/chat'
import { groupSessions } from '@shared/workspaces'

const COLLAPSED_KEY = 'saydraw.collapsedWorkspaces'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set<string>()
  }
}

export default function Sidebar() {
  const sessions = useSessionsStore((s) => s.sessions)
  const currentId = useSessionsStore((s) => s.currentId)
  const select = useSessionsStore((s) => s.select)
  const create = useSessionsStore((s) => s.create)
  const remove = useSessionsStore((s) => s.remove)
  const setSettingsOpen = useSessionsStore((s) => s.setSettingsOpen)
  const [version, setVersion] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [error, setError] = useState('')

  useEffect(() => {
    window.api.app
      .version()
      .then(setVersion)
      .catch(() => setVersion(''))
  }, [])

  const groups = useMemo(() => groupSessions(sessions), [sessions])

  const toggle = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // 隐私模式等场景忽略
      }
      return next
    })
  }

  const createIn = async (projectPath?: string): Promise<void> => {
    setError('')
    try {
      await create(projectPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setTimeout(() => setError(''), 6000)
    }
  }

  return (
    <aside className="flex w-[220px] shrink-0 flex-col bg-[#0d0f13]">
      {/* 无系统标题栏:品牌行兼作拖拽条(与中栏 header 同为 h-12,顶部一线对齐) */}
      <div className="drag flex h-12 items-center gap-2 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600 text-sm font-bold">
          画
        </div>
        <span className="text-sm font-semibold tracking-wide">说画 <span className="text-[10px] font-normal text-zinc-500">SayDraw</span></span>
      </div>

      <div className="space-y-1 px-3">
        <button
          className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          onClick={() => void createIn()}
          title="直接新建会话,不需要先选工作目录"
        >
          + 新会话
        </button>
      </div>

      <nav className="mt-3 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {groups.workspaces.map((ws) => {
          const isCollapsed = collapsed.has(ws.path)
          const hasActive = ws.sessions.some((s) => s.id === currentId)
          return (
            <div key={ws.path}>
              <div
                className={`group flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] transition-colors ${
                  hasActive ? 'text-zinc-200' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                }`}
                onClick={() => toggle(ws.path)}
                title={`${ws.path}\n点击折叠/展开`}
              >
                <span className="w-3 shrink-0 text-[9px] text-zinc-500">{isCollapsed ? '▸' : '▾'}</span>
                <span className="shrink-0 text-[12px]">📁</span>
                <span className="min-w-0 flex-1 truncate font-medium">{ws.name}</span>
                <span className="shrink-0 text-[10px] text-zinc-600">{ws.sessions.length}</span>
                <button
                  className="shrink-0 rounded px-1 text-[13px] leading-none text-zinc-500 hover:text-emerald-400"
                  title="在这个工作区下新建会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    void createIn(ws.path)
                  }}
                >
                  ＋
                </button>
              </div>
              {!isCollapsed && (
                <div className="ml-2 space-y-0.5 border-l border-zinc-800/80 pl-1">
                  {ws.sessions.map((s) => (
                    <SessionItem key={s.id} id={s.id} title={s.title} active={s.id === currentId} onSelect={select} onRemove={remove} />
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {groups.loose.length > 0 && (
          <div className="pt-1">
            {groups.workspaces.length > 0 && (
              <p className="px-2 pb-0.5 pt-1 text-[10px] text-zinc-600">未归入工作区</p>
            )}
            {groups.loose.map((s) => (
              <SessionItem key={s.id} id={s.id} title={s.title} active={s.id === currentId} onSelect={select} onRemove={remove} />
            ))}
          </div>
        )}
      </nav>

      {error && <p className="px-3 pb-1 text-[10px] leading-snug text-red-400">{error}</p>}
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
      className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
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
