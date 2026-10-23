// 自绘窗口控制(最小化 / 最大化-还原 / 关闭)
// 应用是无边框窗口,顶部不再有系统标题栏 —— 这三个按钮是唯一的系统操作入口,
// 所以样式必须跟着主题走(暗底 + 悬停提亮,关闭才变红),不能再出现浅色条。

import { useEffect, useState } from 'react'

const BUTTON_BASE =
  'no-drag flex h-7 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors'

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.window.isMaximized().then((value) => {
      if (alive) setMaximized(value)
    })
    // 双击拖拽区、Win+↑、贴靠布局导致的最大化/还原也要让图标跟上
    const off = window.api.window.onStateChange((state) => setMaximized(state.maximized))
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <div className="flex items-center gap-0.5">
      <button
        className={`${BUTTON_BASE} hover:bg-zinc-800/80 hover:text-zinc-200`}
        title="最小化"
        aria-label="最小化"
        onClick={() => void window.api.window.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.2 5.5h5.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>

      <button
        className={`${BUTTON_BASE} hover:bg-zinc-800/80 hover:text-zinc-200`}
        title={maximized ? '向下还原' : '最大化'}
        aria-label={maximized ? '向下还原' : '最大化'}
        onClick={() => {
          void window.api.window.toggleMaximize().then(setMaximized)
        }}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
            <path d="M3.4 2.6h4v4" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
            <rect x="2.6" y="3.4" width="4" height="4" rx="0.4" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
            <rect x="2.6" y="2.6" width="4.8" height="4.8" rx="0.5" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>

      <button
        className={`${BUTTON_BASE} hover:bg-red-500/90 hover:text-white`}
        title="关闭"
        aria-label="关闭"
        onClick={() => void window.api.window.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.6 2.6l4.8 4.8M7.4 2.6l-4.8 4.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
