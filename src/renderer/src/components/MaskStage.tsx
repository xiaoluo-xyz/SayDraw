// 蒙版画布(Konva):编号画笔笔迹(归一化存储)+ 双图导出
// view 模式:侧栏小画布(适配显示,可简单涂抹)
// editor 模式:完整编辑器——滚轮锚定缩放、平移(✋/空格/中键)、笔刷/撤销/清空、缩放控件

import { useEffect, useRef, useState } from 'react'
import { Stage, Layer, Image as KImage, Line, Group } from 'react-konva'
import type Konva from 'konva'
import type { ImageAsset } from '@shared/types'
import { assetUrl } from '@shared/ipc'
import { MASK_BRUSHES, brushOf, regionSummary, renderBinaryMask, renderBorderMask, renderColoredOverlay, renderExpandedBase, usedBrushIds } from '../lib/mask'
import { useCanvasStore } from '../stores/canvas'
import { useChatStore } from '../stores/chat'

export function useHtmlImage(url: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!url) {
      setImg(null)
      return
    }
    const el = new window.Image()
    el.onload = () => setImg(el)
    el.src = url
    return () => {
      el.onload = null
    }
  }, [url])
  return img
}

/** 笔迹变化 → 防抖导出二值蒙版 + 彩色标注图回填 store */
export function useMaskExport(img: HTMLImageElement | null): void {
  const strokes = useCanvasStore((s) => s.strokes)
  const featherPx = useCanvasStore((s) => s.featherPx)
  const setMaskOutput = useCanvasStore((s) => s.setMaskOutput)
  useEffect(() => {
    if (!img) return
    const timer = setTimeout(() => {
      if (strokes.length === 0) {
        setMaskOutput(null, null)
        return
      }
      setMaskOutput(
        renderBinaryMask(strokes, img.naturalWidth, img.naturalHeight, featherPx),
        renderColoredOverlay(strokes, img.naturalWidth, img.naturalHeight)
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [strokes, img, featherPx, setMaskOutput])
}

export default function MaskStage(props: { asset: ImageAsset; mode: 'view' | 'editor'; maxH?: number; onFinish?: () => void }) {
  const { asset, mode, maxH = 380, onFinish } = props
  const editor = mode === 'editor'
  const img = useHtmlImage(assetUrl(asset.sessionId, asset.fileName))
  useMaskExport(img)

  const strokes = useCanvasStore((s) => s.strokes)
  const activeBrushId = useCanvasStore((s) => s.activeBrushId)
  const setActiveBrush = useCanvasStore((s) => s.setActiveBrush)
  const brushSize = useCanvasStore((s) => s.brushSize)
  const setBrushSize = useCanvasStore((s) => s.setBrushSize)
  const featherPx = useCanvasStore((s) => s.featherPx)
  const setFeather = useCanvasStore((s) => s.setFeather)
  const removeBrush = useCanvasStore((s) => s.removeBrush)
  const setEditorOpen = useCanvasStore((s) => s.setEditorOpen)
  const upsertStroke = useCanvasStore((s) => s.upsertStroke)
  const undo = useCanvasStore((s) => s.undo)
  const clearStrokes = useCanvasStore((s) => s.clearStrokes)

  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const groupRef = useRef<Konva.Group>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  /** 鼠标在画布上的位置(用于笔刷预览圈,未落笔也能看到大小) */
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 缩放与平移(editor)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null) // null = 居中
  const [panMode, setPanMode] = useState(false)
  const spaceRef = useRef(false)
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const drawingRef = useRef(false)

  const baseFit = img
    ? editor
      ? Math.min((size.w - 24) / img.naturalWidth, (size.h - 24) / img.naturalHeight, 4)
      : Math.min(size.w / img.naturalWidth, maxH / img.naturalHeight, 2)
    : 1
  const contentW = img ? img.naturalWidth * baseFit : 0
  const contentH = img ? img.naturalHeight * baseFit : 0
  const effZoom = Math.min(10, Math.max(0.05, zoom))
  const effOffset = offset ?? { x: (size.w - contentW * effZoom) / 2, y: (size.h - contentH * effZoom) / 2 }

  const zoomAt = (factor: number, px?: number, py?: number): void => {
    const stage = stageRef.current
    const pointer = px !== undefined && py !== undefined ? { x: px, y: py } : (stage?.getPointerPosition() ?? { x: size.w / 2, y: size.h / 2 })
    setZoom((z) => {
      const next = Math.min(10, Math.max(0.05, z * factor))
      setOffset((o) => {
        const base = o ?? { x: (size.w - contentW * next) / 2, y: (size.h - contentH * next) / 2 }
        const cx = (pointer.x - base.x) / z
        const cy = (pointer.y - base.y) / z
        return { x: pointer.x - cx * next, y: pointer.y - cy * next }
      })
      return next
    })
  }

  // 滚轮缩放(非被动监听,锚定光标)
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !editor) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, size.w, size.h, contentW, contentH])

  // 空格按住 = 平移;Ctrl+Z 撤销;[ ] 笔刷大小
  useEffect(() => {
    if (!editor) return
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceRef.current = true
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
      if (e.key === '[') setBrushSize(useCanvasStore.getState().brushSize - 6)
      if (e.key === ']') setBrushSize(useCanvasStore.getState().brushSize + 6)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  /** 指针 → 内容归一化坐标(经缩放平移变换) */
  const pointerNormalized = (): { x: number; y: number } | null => {
    const rel = groupRef.current?.getRelativePointerPosition()
    if (!rel || !contentW || !contentH) return null
    return { x: Math.min(1, Math.max(0, rel.x / contentW)), y: Math.min(1, Math.max(0, rel.y / contentH)) }
  }

  const wantPan = (e: Konva.KonvaEventObject<MouseEvent>): boolean => panMode || spaceRef.current || e.evt.button === 1

  const handleDown = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    if (!img || !editor) return // view 模式只读预览,编辑一律在 editor 弹窗
    const stage = stageRef.current
    const pos = stage?.getPointerPosition()
    if (!pos) return
    if (wantPan(e)) {
      panRef.current = { sx: pos.x, sy: pos.y, ox: effOffset.x, oy: effOffset.y }
      return
    }
    const p = pointerNormalized()
    if (!p) return
    drawingRef.current = true
    upsertStroke({ brushId: activeBrushId, pts: [p.x, p.y], width: brushSize / 720 }, false)
  }

  const handleMove = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    const stage = stageRef.current
    const pos = stage?.getPointerPosition()
    if (pos) setHover(pos)
    if (panRef.current && pos) {
      const d = panRef.current
      setOffset({ x: d.ox + (pos.x - d.sx), y: d.oy + (pos.y - d.sy) })
      return
    }
    if (!drawingRef.current) return
    const p = pointerNormalized()
    if (!p) return
    const strokesNow = useCanvasStore.getState().strokes
    const last = strokesNow[strokesNow.length - 1]
    if (!last) return
    upsertStroke({ ...last, pts: [...last.pts, p.x, p.y] }, true)
  }

  const finishPointer = (): void => {
    drawingRef.current = false
    panRef.current = null
  }

  const usedIds = usedBrushIds(strokes)
  const regions = regionSummary(strokes)
  const cursor = editor ? (panMode ? 'grab' : 'crosshair') : 'default'
  // 笔刷在画布上的实际显示直径(与落笔宽度一致,随缩放变化)与图片像素直径
  const brushScreenPx = Math.max(2, (brushSize / 720) * contentW * (editor ? effZoom : 1))
  const brushImagePx = img ? Math.max(1, Math.round((brushSize / 720) * img.naturalWidth)) : Math.round(brushSize)

  /** 扩图正在上传/生成底图,期间禁用按钮并显示进度 */
  const [outpainting, setOutpainting] = useState(false)

  /** 快速动作:擦除(把标注区域的物体去掉) */
  const quickErase = (): void => {
    useChatStore.getState().setInputText('把编号区域内的物体擦除,用周围背景自然补齐,不要留下痕迹。')
    setEditorOpen(false)
    onFinish?.()
  }

  /** 快速动作:扩图(画布外扩 25%,透明边缘交给模型补全) */
  const quickOutpaint = async (): Promise<void> => {
    if (!img || !img.naturalWidth || outpainting) return
    const factor = 1.25
    setOutpainting(true)
    try {
      // 用主进程读出的 data: 图源:直接画 app-asset:// 的 <img> 会污染画布,toDataURL 会失败
      const dataUrl = await window.api.assets.dataUrl(asset.id)
      if (!dataUrl) throw new Error('读取图片失败')
      const source = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new window.Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('解码图片失败'))
        el.src = dataUrl
      })
      const base = await window.api.assets.upload(
        asset.sessionId,
        renderExpandedBase(source, img.naturalWidth, img.naturalHeight, factor),
        'user-upload'
      )
      const mask = await window.api.assets.upload(
        asset.sessionId,
        renderBorderMask(img.naturalWidth, img.naturalHeight, factor),
        'mask',
        base.id,
        'binary'
      )
      const store = useChatStore.getState()
      store.upsertAsset(base)
      store.upsertAsset(mask)
      store.setInputText(
        `把 ${base.id} 向外扩图:原图内容与构图完全不变,只把画布四周(+${Math.round((factor - 1) * 100)}%)的背景按原风格自然延伸补齐(蒙版区域 = 需要补全的边缘)。不要传 size 参数,沿用这张图的画布尺寸。`
      )
      clearStrokes()
      setEditorOpen(false)
      onFinish?.()
    } catch (err) {
      useChatStore.getState().setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOutpainting(false)
    }
  }

  return (
    <div
      ref={wrapRef}
      className={`relative overflow-hidden ${editor ? 'flex h-full w-full flex-1' : 'flex items-center justify-center p-2'}`}
      style={editor ? { minHeight: 0 } : undefined}
      onContextMenu={(e) => editor && e.preventDefault()}
    >
      {/* editor 工具浮层 */}
      {editor && (
        <div className="absolute left-1/2 top-3 z-10 flex max-w-[96%] -translate-x-1/2 flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap rounded-xl border border-zinc-700 bg-[#1b1d23]/95 px-2.5 py-1.5 shadow-xl backdrop-blur">
          {MASK_BRUSHES.map((b) => (
            <button
              key={b.id}
              className={`flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold transition-all ${
                activeBrushId === b.id ? 'scale-110 border-white' : 'border-transparent opacity-75 hover:opacity-100'
              }`}
              style={{ backgroundColor: `${b.color}55`, color: b.color }}
              title={`画笔 ${b.name}(第 ${b.id} 处修改)${usedIds.includes(b.id) ? ' · 已使用' : ''}`}
              onClick={() => setActiveBrush(b.id)}
            >
              {b.id}
            </button>
          ))}
          <span className="mx-0.5 h-5 w-px bg-zinc-700" />
          {/* 笔刷预览:调整大小时直观看到当前粗细 */}
          <span className="flex h-7 w-7 shrink-0 items-center justify-center" title={`笔刷预览:图上约 ${brushImagePx}px`}>
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
            className="w-24 accent-emerald-500"
            title={`笔刷 ${brushSize}px([ / ] 调整)`}
          />
          <span className="w-16 shrink-0 text-center font-mono text-[10px] text-zinc-400">
            {brushSize} · {brushImagePx}px
          </span>
          <span className="mx-0.5 h-5 w-px bg-zinc-700" />
          <input
            type="range"
            min={0}
            max={40}
            value={featherPx}
            onChange={(e) => setFeather(Number(e.target.value))}
            className="w-16 accent-emerald-500"
            title="蒙版羽化:边缘过渡像素(0 = 硬边)"
          />
          <span className="w-14 text-center font-mono text-[10px] text-zinc-400">羽化 {featherPx}</span>
          <span className="mx-0.5 h-5 w-px bg-zinc-700" />
          {regions.map((r) => (
            <span key={r.id} className="flex items-center gap-1 rounded-full bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-300">
              <span style={{ color: r.color }}>●</span>#{r.id}
              <span className="text-zinc-500">×{r.count}</span>
              <button className="text-zinc-500 hover:text-red-400" title={`删除第 ${r.id} 处笔迹`} onClick={() => removeBrush(r.id)}>
                ✕
              </button>
            </span>
          ))}
          {regions.length > 0 && <span className="mx-0.5 h-5 w-px bg-zinc-700" />}
          <button className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800" disabled={!strokes.length} onClick={undo} title="撤销 (Ctrl+Z)">
            撤销
          </button>
          <button className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800" disabled={!strokes.length} onClick={clearStrokes} title="清空全部笔迹">
            清空
          </button>
          <button
            className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
            disabled={!strokes.length}
            onClick={quickErase}
            title="把这几个标注区域里的物体擦除,由模型用周围背景补齐"
          >
            擦除
          </button>
          <button
            className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
            disabled={!img || outpainting}
            onClick={() => void quickOutpaint()}
            title="画布向外扩 25%:原图不动,边缘交给模型补全背景"
          >
            {outpainting ? '扩图中…' : '扩图'}
          </button>
          <span className="mx-0.5 h-5 w-px bg-zinc-700" />
          <button
            className={`rounded px-2 py-1 text-[11px] ${panMode ? 'bg-emerald-600 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}
            onClick={() => setPanMode((p) => !p)}
            title="平移模式(或按住空格拖拽 / 中键拖拽)"
          >
            ✋
          </button>
          <button className="rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800" onClick={() => zoomAt(1 / 1.25)} title="缩小">
            −
          </button>
          <span className="w-10 text-center font-mono text-[10px] text-zinc-400">{Math.round(effZoom * 100)}%</span>
          <button className="rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800" onClick={() => zoomAt(1.25)} title="放大">
            +
          </button>
          <button
            className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
            onClick={() => {
              setZoom(1)
              setOffset(null)
            }}
            title="适配窗口"
          >
            适配
          </button>
        </div>
      )}

      {editor && (
        <p className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/60 px-3 py-1 text-[10px] text-zinc-400 backdrop-blur">
          滚轮缩放 · 空格/✋/中键平移 · [{usedIds.length ? `已标记 ${usedIds.length} 处(编号 ${usedIds.join('、')})` : '尚未涂抹'}]
        </p>
      )}

      {img && (
        <Stage
          ref={stageRef}
          width={editor ? size.w : contentW}
          height={editor ? size.h : contentH}
          style={{ cursor, borderRadius: 8, display: 'block' }}
          onMouseDown={handleDown}
          onMouseMove={handleMove}
          onMouseUp={finishPointer}
          onMouseLeave={() => {
            finishPointer()
            setHover(null)
          }}
        >
          <Layer>
            <Group ref={groupRef} x={editor ? effOffset.x : 0} y={editor ? effOffset.y : 0} scaleX={editor ? effZoom : 1} scaleY={editor ? effZoom : 1}>
              <KImage image={img} width={contentW} height={contentH} />
              {strokes.map((stroke, i) => (
                <Line
                  key={i}
                  points={stroke.pts.flatMap((v, idx) => (idx % 2 === 0 ? [v * contentW, stroke.pts[idx + 1] * contentH] : []))}
                  stroke={brushOf(stroke.brushId).color}
                  strokeWidth={Math.max(1, stroke.width * contentW)}
                  opacity={0.55}
                  lineCap="round"
                  lineJoin="round"
                  listening={false}
                />
              ))}
            </Group>
          </Layer>
        </Stage>
      )}

      {/* 笔刷实时预览:鼠标一进画布就能看到具体大小,未落笔也显示 */}
      {editor && hover && !panMode && (
        <div className="pointer-events-none absolute z-30" style={{ left: hover.x, top: hover.y }}>
          <div
            className="absolute rounded-full border border-white/85 bg-white/10"
            style={{
              width: brushScreenPx,
              height: brushScreenPx,
              transform: 'translate(-50%, -50%)',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.35)'
            }}
          />
          <span
            className="absolute whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[10px] leading-none text-zinc-100"
            style={{ transform: `translate(${brushScreenPx / 2 + 6}px, ${-brushScreenPx / 2 - 4}px)` }}
          >
            {brushImagePx}px
          </span>
        </div>
      )}
    </div>
  )
}
