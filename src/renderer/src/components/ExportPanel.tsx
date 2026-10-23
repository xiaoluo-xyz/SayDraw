// 多比例交付:把当前图按 1:1 / 4:3 / 16:9 / 9:16 批量切成成品 + 交付清单
// 裁切走 canvas 中心裁切(不拉伸),导出由主进程写盘

import { useMemo, useState } from 'react'
import {
  EXPORT_FORMATS,
  EXPORT_RATIOS,
  buildManifest,
  exportFileName,
  planExports,
  type ExportFormat
} from '@shared/exportPlan'
import { useCanvasStore } from '../stores/canvas'
import { useChatStore } from '../stores/chat'

const LONG_EDGES = [1024, 2048, 3840]

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('读取源图失败'))
    img.src = url
  })
}

function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number, text: string): void {
  const fontSize = Math.max(12, Math.round(width * 0.028))
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = Math.round(fontSize * 0.35)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillText(text, width - Math.round(width * 0.03), height - Math.round(height * 0.03))
  ctx.shadowBlur = 0
}

export default function ExportPanel() {
  const open = useCanvasStore((s) => s.exportOpen)
  const setOpen = useCanvasStore((s) => s.setExportOpen)
  const baseAssetId = useCanvasStore((s) => s.baseAssetId)
  const asset = useChatStore((s) => (baseAssetId ? s.assets[baseAssetId] : undefined))

  const [ratios, setRatios] = useState<string[]>(EXPORT_RATIOS.map((r) => r.id))
  const [longEdge, setLongEdge] = useState(2048)
  const [format, setFormat] = useState<ExportFormat>('png')
  const [quality, setQuality] = useState(0.9)
  const [watermark, setWatermark] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<string | null>(null)

  const width = asset?.width ?? 0
  const height = asset?.height ?? 0
  const plans = useMemo(() => planExports(width, height, ratios, longEdge), [width, height, ratios, longEdge])
  if (!open || !asset) return null

  const toggleRatio = (id: string): void => {
    setRatios((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]))
  }

  const doExport = async (): Promise<void> => {
    if (!plans.length) return
    setBusy(true)
    setResult(null)
    try {
      const dataUrl = await window.api.assets.dataUrl(asset.id)
      if (!dataUrl) throw new Error('读取源图失败')
      const img = await loadImage(dataUrl)
      const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp'
      const prefix = asset.id.replace(/^asset-/, '').slice(-8)

      // 逐张编码 + 逐张写盘:一次 IPC 只送一张图,避免几十 MB 的单个消息把主进程卡住
      let dir = ''
      let saved = 0
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]
        setProgress(`导出中 ${i + 1}/${plans.length}`)
        const canvas = document.createElement('canvas')
        canvas.width = plan.width
        canvas.height = plan.height
        const ctx = canvas.getContext('2d')!
        if (format !== 'png') {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, plan.width, plan.height)
        }
        ctx.drawImage(img, plan.crop.x, plan.crop.y, plan.crop.w, plan.crop.h, 0, 0, plan.width, plan.height)
        if (watermark.trim()) drawWatermark(ctx, plan.width, plan.height, watermark.trim())
        const file = { fileName: exportFileName(prefix, plan, format), dataUrl: canvas.toDataURL(mime, quality) }
        // 第一张不带 dir:由主进程弹文件夹选择框;之后沿用同一个目录
        const res = await window.api.assets.exportSet(dir ? { files: [file], dir } : { files: [file] })
        if (!res.ok) {
          setResult('已取消')
          return
        }
        dir = res.dir
        saved += res.saved
      }

      setProgress('写交付清单…')
      const manifest = buildManifest({
        title: asset.id,
        sourceSize: `${width}×${height}`,
        assetId: asset.id,
        prompt: asset.prompt,
        meta: asset.meta as unknown as Record<string, unknown>,
        plans,
        format,
        watermark: watermark.trim() || undefined,
        exportedAt: new Date().toLocaleString('zh-CN')
      })
      await window.api.assets.exportSet({ files: [], manifest, dir })
      setResult(`已导出 ${saved} 张 → ${dir}`)
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-[#171a20] shadow-2xl">
        <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          <h2 className="text-sm font-medium text-zinc-100">⇩ 多比例导出</h2>
          <span className="text-[10px] text-zinc-500">
            源图 {width}×{height}
          </span>
          <button className="ml-auto rounded-md px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800" onClick={() => setOpen(false)}>
            关闭
          </button>
        </header>

        <div className="space-y-3 px-4 py-3">
          <div>
            <p className="mb-1 text-[11px] text-zinc-400">比例(中心裁切,不拉伸)</p>
            <div className="flex flex-wrap gap-1.5">
              {EXPORT_RATIOS.map((r) => (
                <button
                  key={r.id}
                  className={`rounded-lg border px-2 py-1 text-[11px] ${
                    ratios.includes(r.id) ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-400'
                  }`}
                  onClick={() => toggleRatio(r.id)}
                >
                  {r.id}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
            <span>长边</span>
            <select
              className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200"
              value={longEdge}
              onChange={(e) => setLongEdge(Number(e.target.value))}
            >
              {LONG_EDGES.map((v) => (
                <option key={v} value={v}>
                  {v}px
                </option>
              ))}
            </select>
            <span className="ml-2">格式</span>
            <select
              className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {EXPORT_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </select>
            {format !== 'png' && (
              <>
                <span className="ml-2">质量</span>
                <input type="range" min={0.5} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="w-20 accent-emerald-500" />
                <span className="font-mono">{Math.round(quality * 100)}</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span>水印</span>
            <input
              value={watermark}
              onChange={(e) => setWatermark(e.target.value)}
              placeholder="可选:右下角署名/版权"
              className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600"
            />
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2">
            <p className="mb-1 text-[10px] text-zinc-500">将导出 {plans.length} 个文件 + 交付清单.md</p>
            <ul className="max-h-24 space-y-0.5 overflow-y-auto font-mono text-[10px] text-zinc-400">
              {plans.map((p) => (
                <li key={p.ratio}>
                  {p.label} · {p.width}×{p.height} · {exportFileName(asset.id.replace(/^asset-/, '').slice(-8), p, format)}
                </li>
              ))}
            </ul>
          </div>

          {busy && progress && <p className="text-[11px] text-amber-300">{progress}</p>}
          {result && <p className="text-[11px] text-emerald-300">{result}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-2.5">
          <button className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500" onClick={() => setOpen(false)}>
            取消
          </button>
          <button
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            disabled={busy || plans.length === 0}
            onClick={() => void doExport()}
          >
            {busy ? '导出中…' : '选择文件夹并导出'}
          </button>
        </footer>
      </div>
    </div>
  )
}
