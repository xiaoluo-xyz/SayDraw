// A/B 对比视图:并排看两张图(带参数行与版本关系),用于挑版/挑细节

import { assetUrl } from '@shared/ipc'
import type { ImageAsset } from '@shared/types'
import { relationOf, versionNumber } from '@shared/versionTree'
import { summarizeMeta } from '@shared/recipe'
import { useChatStore } from '../stores/chat'
import { useCanvasStore } from '../stores/canvas'

const RELATION_TEXT: Record<string, string> = {
  same: '同一张',
  'a-parent': 'A 是 B 的上一版',
  'b-parent': 'B 是 A 的上一版',
  siblings: '同一版的两次改法',
  unrelated: '两张独立作品'
}

export default function CompareOverlay() {
  const compareMode = useCanvasStore((s) => s.compareMode)
  const compareA = useCanvasStore((s) => s.compareA)
  const compareB = useCanvasStore((s) => s.compareB)
  const clearCompare = useCanvasStore((s) => s.clearCompare)
  const setBase = useCanvasStore((s) => s.setBase)
  const assetsMap = useChatStore((s) => s.assets)

  if (!compareMode || !compareA) return null
  const assets = Object.values(assetsMap)
  const a = assetsMap[compareA]
  const b = compareB ? assetsMap[compareB] : undefined
  if (!a) return null

  const relation = b ? relationOf(assets, a.id, b.id) : null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-6 backdrop-blur-sm">
      <header className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-medium text-zinc-100">⇆ A / B 对比</h2>
        {relation && <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] text-emerald-300">{RELATION_TEXT[relation]}</span>}
        {!b && <span className="text-[11px] text-zinc-400">再选一张作为 B</span>}
        <button
          className="ml-auto rounded-lg border border-zinc-600 px-3 py-1 text-xs text-zinc-200 hover:border-zinc-400"
          onClick={clearCompare}
        >
          退出对比
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <Panel label="A" asset={a} assets={assets} onUse={() => setBase(a.id)} />
        {b ? (
          <Panel label="B" asset={b} assets={assets} onUse={() => setBase(b.id)} />
        ) : (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-zinc-700 text-xs text-zinc-500">
            在版本树里再点一张图作为 B
          </div>
        )}
      </div>
    </div>
  )
}

function Panel(props: { label: string; asset: ImageAsset; assets: ImageAsset[]; onUse: () => void }) {
  const { label, asset, assets, onUse } = props
  const meta = summarizeMeta(asset.meta)
  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-zinc-700 bg-[#15171c] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-emerald-500 px-1.5 text-[10px] font-medium leading-4 text-black">{label}</span>
        <span className="text-[11px] text-zinc-300">
          {asset.kind === 'edited' ? '改版' : asset.kind === 'generated' ? '生成' : '上传'} · 第 {versionNumber(assets, asset)} 版
        </span>
        <span className="ml-auto text-[10px] text-zinc-500">
          {asset.width ?? '?'}×{asset.height ?? '?'}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-black/30 p-2">
        <img src={assetUrl(asset.sessionId, asset.fileName)} alt={asset.id} className="max-h-full max-w-full object-contain" />
      </div>
      <div className="mt-2 space-y-1">
        {meta.length > 0 && <p className="text-[10px] text-zinc-400">{meta.join(' · ')}</p>}
        {asset.prompt && (
          <p className="line-clamp-2 text-[10px] leading-snug text-zinc-500" title={asset.prompt}>
            {asset.prompt}
          </p>
        )}
        <button className="rounded-md border border-emerald-600/70 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10" onClick={onUse}>
          在画布打开这张
        </button>
      </div>
    </div>
  )
}
