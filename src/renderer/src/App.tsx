import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import Composer from './components/Composer'
import BriefPanel from './components/BriefPanel'
import ImageCanvas from './components/ImageCanvas'
import VersionStrip from './components/VersionStrip'
import SettingsDialog from './components/SettingsDialog'
import ImageViewer from './components/ImageViewer'
import MaskEditorModal from './components/MaskEditorModal'
import CompareOverlay from './components/CompareOverlay'
import ExportPanel from './components/ExportPanel'
import WindowControls from './components/WindowControls'
import { useSessionsStore } from './stores/sessions'
import { useChatStore } from './stores/chat'
import { useSettingsStore } from './stores/settings'
import { useCanvasStore } from './stores/canvas'
import { useViewerStore } from './stores/viewer'
export default function App() {
  const settingsOpen = useSessionsStore((s) => s.settingsOpen)
  const loadSessions = useSessionsStore((s) => s.load)
  const handleEvent = useChatStore((s) => s.handleEvent)
  const loadSettings = useSettingsStore((s) => s.load)
  const viewerOpen = useViewerStore((s) => s.assetId) !== null
  const maskOpen = useCanvasStore((s) => s.editorOpen)
  const compareMode = useCanvasStore((s) => s.compareMode)
  const exportOpen = useCanvasStore((s) => s.exportOpen)
  const [booted, setBooted] = useState(false)

  /* 浮层打开 = 顶部 48px 拖拽区必须失效。
     否则浮层里落在这条带子里的按钮(蒙版工具条 撤销/清空/擦除/扩图/缩放、
     蒙版编辑器的「完成」、A-B 对比头部按钮)会被 Windows 当成标题栏吃掉,点了没反应。 */
  const overlayOpen = settingsOpen || viewerOpen || maskOpen || compareMode || exportOpen
  useEffect(() => {
    const root = document.documentElement
    if (overlayOpen) root.dataset.overlay = '1'
    else delete root.dataset.overlay
  }, [overlayOpen])

  useEffect(() => {
    const unsubscribe = window.api.onAgentEvent((ev) => {
      handleEvent(ev)
      // 会话列表按更新时间排序,消息落盘后刷新
      if (ev.type === 'message-final' || ev.type === 'user-message') void loadSessions()
    })
    return unsubscribe
  }, [handleEvent, loadSessions])

  useEffect(() => {
    void (async () => {
      await Promise.all([loadSettings(), loadSessions()])
      setBooted(true)
    })()
  }, [loadSettings, loadSessions])

  // 首次启动自动创建一个会话
  useEffect(() => {
    if (booted && useSessionsStore.getState().sessions.length === 0) {
      void useSessionsStore.getState().create()
    }
  }, [booted])

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col border-l border-zinc-800/80 bg-[#131519]">
        <Header />
        <ChatPanel />
        <Composer />
      </main>
      <aside className="flex w-[340px] shrink-0 flex-col border-l border-zinc-800/80 bg-[#101216]">
        {/* 顶部不再有系统标题栏:这里只有窗口按钮,底色和面板一致,不画成一条"条" */}
        <div className="drag flex h-12 shrink-0 items-center justify-end pr-2">
          <WindowControls />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
          <BriefPanel />
          <ImageCanvas />
          <VersionStrip />
        </div>
      </aside>
      {settingsOpen && <SettingsDialog />}
      <MaskEditorModal />
      <CompareOverlay />
      <ExportPanel />
      <ImageViewer />
    </div>
  )
}

function Header() {
  const currentId = useSessionsStore((s) => s.currentId)
  const sessions = useSessionsStore((s) => s.sessions)
  const setSettingsOpen = useSessionsStore((s) => s.setSettingsOpen)
  const session = sessions.find((s) => s.id === currentId)

  // drag:无系统标题栏后,这一条就是窗口的拖拽条(双击最大化/还原,与普通标题栏一致)
  return (
    <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800/80 px-4">
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
        {session?.title ?? '说画 SayDraw'}
      </h1>
      <button
        className="no-drag rounded-md px-2 py-1 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        onClick={() => setSettingsOpen(true)}
        title="设置"
      >
        ⚙ 设置
      </button>
    </header>
  )
}
