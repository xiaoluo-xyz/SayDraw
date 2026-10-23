// 画布面板(侧栏):图片预览 + 蒙版笔迹预览;蒙版编辑一律进大窗口编辑器

import { useState } from 'react'
import { useChatStore } from '../stores/chat'
import { useCanvasStore } from '../stores/canvas'
import { useViewerStore } from '../stores/viewer'
import MaskStage from './MaskStage'
import { usedBrushIds } from '../lib/mask'
import { formatCost } from '@shared/cost'

export default function ImageCanvas() {
  const baseAssetId = useCanvasStore((s) => s.baseAssetId)
  const assets = useChatStore((s) => s.assets)
  const brushMode = useCanvasStore((s) => s.brushMode)
  const setBrushMode = useCanvasStore((s) => s.setBrushMode)
  const strokes = useCanvasStore((s) => s.strokes)
  const clearStrokes = useCanvasStore((s) => s.clearStrokes)
  const maskDataUrl = useCanvasStore((s) => s.maskDataUrl)
  const setEditorOpen = useCanvasStore((s) => s.setEditorOpen)
  const promote = useChatStore((s) => s.promote)
  const regenerate = useChatStore((s) => s.regenerate)
  const [busy, setBusy] = useState(false)

  const asset = baseAssetId ? assets[baseAssetId] : null

  if (!asset) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-[#15171c]">
        <header className="border-b border-zinc-800/80 px-3 py-2">
          <h2 className="text-xs font-semibold tracking-wide text-zinc-300">🖼 画布</h2>
        </header>
        <div className="flex h-40 items-center justify-center p-2 text-center text-[11px] text-zinc-600">
          生成 / 上传的图片会显示在这里,点击聊天中的图片即可载入
        </div>
      </section>
    )
  }

  const usedIds = usedBrushIds(strokes)

  return (
    <section className="rounded-xl border border-zinc-800 bg-[#15171c]">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <h2 className="mr-auto text-xs font-semibold tracking-wide text-zinc-300">🖼 画布</h2>
        {asset.draft && (
          <button
            className="rounded-lg bg-amber-400 px-2.5 py-1 text-[11px] font-medium text-black hover:bg-amber-300"
            title="把这张候选设为正式版本(其余同批候选保持待选)"
            onClick={() => void promote(asset.id)}
          >
            ✓ 选用这张
          </button>
        )}
        {brushMode && maskDataUrl && (
          <button className="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800" onClick={clearStrokes} disabled={!strokes.length}>
            清除蒙版
          </button>
        )}
        <button
          className={`rounded-lg px-2.5 py-1 text-[11px] ${brushMode ? 'bg-emerald-600 text-white' : 'border border-zinc-700 text-zinc-300 hover:border-emerald-500 hover:text-emerald-300'}`}
          title={brushMode ? '蒙版编辑中:点击打开大窗口编辑器' : '涂抹蒙版:在大窗口编辑器中精细标注修改区域(支持编号画笔多处修改)'}
          onClick={() => {
            setBrushMode(true)
            setEditorOpen(true)
          }}
        >
          🖌 {maskDataUrl ? `蒙版${usedIds.length ? ` · ${usedIds.length} 处` : ''} · 编辑` : '涂抹蒙版'}
        </button>
      </header>

      <div
        className="p-2"
        onContextMenu={(e) => {
          if (asset && asset.kind !== 'mask') {
            e.preventDefault()
            void window.api.assets.contextMenu(asset.id)
          }
        }}
        onDoubleClick={() => {
          if (asset && asset.kind !== 'mask') useViewerStore.getState().open(asset.id)
        }}
        title={asset ? '双击放大查看 · 右键复制/另存为' : undefined}
      >
        <MaskStage asset={asset} mode="view" maxH={380} />
      </div>

      {(asset.meta?.model || asset.meta?.local || asset.kind !== 'user-upload') && (
        <div className="border-t border-zinc-800/80 px-3 py-2 text-[10px] text-zinc-500">
          {asset.meta?.local && (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-300">本地合成</span>
                <span className="text-emerald-300">¥0</span>
                {asset.width && asset.height && (
                  <span>
                    {asset.width}×{asset.height}
                  </span>
                )}
                <span className="text-zinc-600">未调用生图模型</span>
              </div>
              {asset.meta.ops?.length ? <p className="mt-1 leading-relaxed text-zinc-500">{asset.meta.ops.join(' · ')}</p> : null}
            </>
          )}
          {asset.meta?.model && (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-zinc-400">{asset.meta.model}</span>
                {(asset.meta.size || asset.meta.ratio) && <span>{asset.meta.size ?? asset.meta.ratio}</span>}
                {asset.meta.quality && <span>quality {asset.meta.quality}</span>}
                {asset.meta.variants ? <span>候选 ×{asset.meta.variants}</span> : null}
                {typeof asset.meta.elapsedMs === 'number' && <span>{(asset.meta.elapsedMs / 1000).toFixed(0)}s</span>}
                {typeof asset.meta.cost === 'number' && asset.meta.cost > 0 && (
                  <span className="text-emerald-300">{formatCost(asset.meta.cost)}</span>
                )}
                {asset.meta.dropped?.length ? <span className="text-amber-400">已降级 {asset.meta.dropped.join('/')}</span> : null}
              </div>
              {asset.meta.actualSize && asset.meta.size && asset.meta.actualSize !== asset.meta.size && (
                <p className="mt-0.5 text-amber-400">实际返回 {asset.meta.actualSize}(请求 {asset.meta.size} 未生效)</p>
              )}
            </>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {!asset.meta?.local && (
              <button
                className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-40"
                disabled={busy || !asset.prompt}
                title="用同一段提示词与参数再出一张(不经过对话模型)"
                onClick={() => {
                  setBusy(true)
                  void regenerate(asset.id).finally(() => setBusy(false))
                }}
              >
                {busy ? '复现中…' : '↻ 同参再生成'}
              </button>
            )}
            <button
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-40"
              disabled={!asset.prompt}
              title="导出提示词与生成参数(.recipe.json)"
              onClick={() => void window.api.assets.exportRecipe(asset.id)}
            >
              ⇩ 导出参数
            </button>
            <button
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
              title="按多比例裁切导出成品 + 交付清单"
              onClick={() => useCanvasStore.getState().setExportOpen(true)}
            >
              ⇩ 多比例
            </button>
          </div>
        </div>
      )}

      {maskDataUrl && (
        <p className="border-t border-zinc-800/80 px-3 py-2 text-[11px] text-amber-400/90">
          🖌 蒙版已就绪{usedIds.length > 1 ? `(编号 ${usedIds.join('、')} 共 ${usedIds.length} 处)` : ''}:在输入框描述
          {usedIds.length > 1 ? '每个编号' : ''}要改成什么,发送时自动附带
        </p>
      )}
    </section>
  )
}
