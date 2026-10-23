// 工作目录(工作区)栏:输入框上方
// 目录是可选的 —— 不选也能直接画(产出落在本机默认目录);选了之後会话归到左侧对应工作区,
// 产出存进该目录的 生成图片/。这里只做「挂载/更换/移出」,不读取目录内容。

import { useCallback, useState } from 'react'
import { useSessionsStore } from '../stores/sessions'

export interface PickResult {
  ok: boolean
  createdFiles?: string[]
  error?: string
}

/** 选择工作目录的共享逻辑 */
export function useProjectPicker() {
  const [picking, setPicking] = useState(false)
  const loadSessions = useSessionsStore((s) => s.load)

  const pick = useCallback(
    async (sessionId: string): Promise<PickResult> => {
      if (picking) return { ok: false }
      setPicking(true)
      try {
        const result = await window.api.sessions.selectProject(sessionId)
        if (!result) return { ok: false }
        await loadSessions()
        return { ok: true, createdFiles: result.createdFiles }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        setPicking(false)
      }
    },
    [picking, loadSessions]
  )

  return { pick, picking }
}

export default function ProjectBar() {
  const sessions = useSessionsStore((s) => s.sessions)
  const sessionId = useSessionsStore((s) => s.currentId)
  const clearProject = useSessionsStore((s) => s.clearProject)
  const session = sessions.find((s) => s.id === sessionId)
  const { pick, picking } = useProjectPicker()
  const [notice, setNotice] = useState('')

  const showNotice = (text: string): void => {
    setNotice(text)
    setTimeout(() => setNotice(''), 5000)
  }

  if (!session) return null

  return (
    <div className="mb-2 flex items-center gap-2 text-[11px]">
      {session.projectPath ? (
        <>
          <button
            className="flex min-w-0 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 text-zinc-300 hover:border-emerald-500/60"
            title={`${session.projectPath}\n点击更换工作目录`}
            onClick={() =>
              void pick(session.id).then((r) => {
                if (r.createdFiles) showNotice(`已初始化:${r.createdFiles.join('、')}`)
                else if (r.error) showNotice(r.error)
              })
            }
            disabled={picking}
          >
            📁 <span className="max-w-[240px] truncate font-medium">{displayName(session.projectPath)}</span>
            <span className="text-zinc-500">· 工作目录</span>
          </button>
          <button
            className="rounded-full px-1.5 py-1 text-zinc-500 hover:text-amber-400"
            title="移出工作区(只解除关联,不删除磁盘上的文件)"
            onClick={() => {
              if (!window.confirm('把这个会话移出工作区?磁盘上的文件不会被删除。')) return
              void clearProject(session.id).then(() => showNotice('已移出工作区'))
            }}
          >
            ✕
          </button>
          <span className="truncate text-zinc-600" title="产出图片在 生成图片/,素材放 素材/,要求.md 与 需求规格.md 自动维护">
            生成图片/ · 素材/ · 要求.md
          </span>
        </>
      ) : (
        <button
          className="flex items-center gap-1.5 rounded-full border border-dashed border-zinc-600 px-2.5 py-1 text-zinc-400 hover:border-emerald-500/70 hover:text-emerald-300"
          title="可选:选一个目录当本会话的工作区,产出会存进它的 生成图片/;不选也能直接画"
          onClick={() =>
            void pick(session.id).then((r) => {
              if (r.createdFiles) showNotice(`已初始化:${r.createdFiles.join('、')}`)
              else if (r.error) showNotice(r.error)
            })
          }
          disabled={picking}
        >
          📁 {picking ? '选择中…' : '选择工作目录(可选)'}
        </button>
      )}
      {notice && <span className="ml-auto truncate text-emerald-400/80">{notice}</span>}
    </div>
  )
}

function displayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const base = normalized.split(/[\\/]/).pop() ?? path
  return base || path
}
