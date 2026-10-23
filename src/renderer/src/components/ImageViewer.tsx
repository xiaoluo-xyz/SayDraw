// 双击打开的全屏图片查看器:滚轮缩放(锚定光标)/ 拖拽平移 / 旋转 / 1:1 / Esc 关闭
// 放大后仍可用画布功能:切「涂抹」直接用同一套蒙版编辑器(编号画笔/笔刷大小/羽化/撤销/擦除/扩图)

import { useCallback, useEffect, useRef, useState } from 'react'
import { assetUrl } from '@shared/ipc'
import { useViewerStore } from '../stores/viewer'
import { useChatStore } from '../stores/chat'
import { useCanvasStore } from '../stores/canvas'
import MaskStage from './MaskStage'

const MIN_SCALE = 0.1
const MAX_SCALE = 12

export default function ImageViewer() {
  const assetId = useViewerStore((s) => s.assetId)
  const close = useViewerStore((s) => s.close)
  const assets = useChatStore((s) => s.assets)
  const asset = assetId ? assets[assetId] : null

  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [rotate, setRotate] = useState(0)
  const [paintMode, setPaintMode] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  const brushSize = useCanvasStore((s) => s.brushSize)
  const setBrushSize = useCanvasStore((s) => s.setBrushSize)
  const setBase = useCanvasStore((s) => s.setBase)
  const strokes = useCanvasStore((s) => s.strokes)
  const maskDataUrl = useCanvasStore((s) => s.maskDataUrl)

  // 打开新图时重置视图与模式
  useEffect(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setRotate(0)
    setPaintMode(false)
  }, [assetId])

  // Esc 关闭
  useEffect(() => {
    if (!assetId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [assetId, close])

  // 滚轮缩放(涂抹模式下交给 MaskStage 自己处理,避免双重缩放)
  useEffect(() => {
    const el = containerRef.current
    if (!el || !assetId || paintMode) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setScale((prevScale) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prevScale * factor))
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left - rect.width / 2
        const cy = e.clientY - rect.top - rect.height / 2
        setOffset((prev) => ({
          x: cx - ((cx - prev.x) * next) / prevScale,
          y: cy - ((cy - prev.y) * next) / prevScale
        }))
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [assetId, paintMode])

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)))
  }, [])

  if (!asset) return null
  const canPaint = asset.kind !== 'mask'

  const togglePaint = (): void => {
    const next = !paintMode
    setPaintMode(next)
    if (next) {
      // 涂抹要作用在这张图上:让画布面板的底图与笔迹保持一致
      setBase(asset.id)
    }
  }

  const dragProps = {
    onPointerDown: (e: React.PointerEvent): void => {
      dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: React.PointerEvent): void => {
      const d = dragRef.current
      if (!d) return
      setOffset({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) })
    },
    onPointerUp: (): void => {
      dragRef.current = null
    }
  }

  const btn = 'flex h-8 w-8 items-center justify-center rounded-lg bg-black/60 text-sm text-zinc-200 backdrop-blur hover:bg-black/80'

  return (
    <div className="fixed inset-0 z-[60] select-none bg-black/85 backdrop-blur-sm" onClick={close}>
      <div
        ref={containerRef}
        className={`absolute inset-0 flex items-center justify-center overflow-hidden ${
          paintMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
        }`}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={() => {
          if (paintMode) return // 涂抹时不切换缩放,免得画到一半跳走
          setScale((s) => (s >= 1.95 ? 1 : 2))
          setOffset({ x: 0, y: 0 })
        }}
        {...(paintMode ? {} : dragProps)}
      >
        {paintMode ? (
          <MaskStage
            asset={asset}
            mode="editor"
            onFinish={() => {
              // 擦除/扩图都是"把话准备好、交给聊天框继续":关掉查看器,用户才能看到输入框里已经写好的指令
              setPaintMode(false)
              close()
            }}
          />
        ) : (
          <img
            src={assetUrl(asset.sessionId, asset.fileName)}
            alt={asset.id}
            draggable={false}
            className="max-h-full max-w-full object-contain will-change-transform"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotate}deg)` }}
          />
        )}
      </div>

      {/* 顶部信息 */}
      <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-zinc-300 backdrop-blur">
        {paintMode
          ? `涂抹模式 · ${strokes.length} 笔${maskDataUrl ? ' · 蒙版已就绪' : ''}`
          : `${asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.id} · ${Math.round(scale * 100)}%`}
      </div>

      {/* 涂抹时的笔刷大小 */}
      {paintMode && (
        <div
          className="absolute bottom-12 left-4 z-10 flex items-center gap-2 rounded-xl border border-zinc-700/80 bg-black/70 px-3 py-2 backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-[11px] text-zinc-300">笔刷</span>
          <span className="flex h-7 w-7 items-center justify-center" title="笔刷预览">
            <span
              className="rounded-full border border-white/90 bg-white/25"
              style={{ width: Math.max(4, Math.min(24, brushSize / 7)), height: Math.max(4, Math.min(24, brushSize / 7)) }}
            />
          </span>
          <input
            type="range"
            min={4}
            max={240}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-28 accent-emerald-500"
            title="笔刷大小([ / ] 也能调)"
          />
          <span className="w-20 text-center font-mono text-[10px] text-zinc-400">
            {brushSize} · {Math.max(1, Math.round((brushSize / 720) * (asset.width ?? 720)))}px
          </span>
        </div>
      )}

      {/* 右侧工具条 */}
      <div className="absolute right-4 top-1/2 flex -translate-y-1/2 flex-col gap-2" onClick={(e) => e.stopPropagation()}>
        {canPaint && (
          <button
            className={`${btn} ${paintMode ? 'bg-emerald-600 text-white hover:bg-emerald-500' : ''}`}
            title={paintMode ? '退出涂抹' : '涂抹蒙版(在这个放大视图里直接画)'}
            onClick={togglePaint}
          >
            🖌
          </button>
        )}
        {!paintMode && (
          <>
            <button className={btn} title="放大" onClick={() => zoomBy(1.25)}>
              +
            </button>
            <button className={btn} title="缩小" onClick={() => zoomBy(0.8)}>
              −
            </button>
            <button
              className={btn}
              title="重置(适配窗口)"
              onClick={() => {
                setScale(1)
                setOffset({ x: 0, y: 0 })
                setRotate(0)
              }}
            >
              ⤢
            </button>
            <button className={btn} title="旋转 90°" onClick={() => setRotate((r) => r + 90)}>
              ⟳
            </button>
          </>
        )}
        <button className={btn} title="复制图片" onClick={() => void window.api.assets.contextMenu(asset.id)}>
          ⧉
        </button>
        <button className={btn} title="关闭 (Esc)" onClick={close}>
          ✕
        </button>
      </div>

      {!paintMode && (
        <p className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-zinc-500">
          滚轮缩放 · 拖拽移动 · 双击切换 100%/适配 · 点 🖌 进入涂抹 · 右键复制/另存为
        </p>
      )}
    </div>
  )
}
