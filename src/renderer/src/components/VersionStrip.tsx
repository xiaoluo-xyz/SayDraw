import { useEffect } from 'react'
import { assetUrl } from '@shared/ipc'
import type { ImageAsset } from '@shared/types'
import { buildVersionTree, childCount, flattenTree, versionNumber } from '@shared/versionTree'
import { formatCost, totalCost } from '@shared/cost'
import { useChatStore } from '../stores/chat'
import { useCanvasStore } from '../stores/canvas'
import { useViewerStore } from '../stores/viewer'

const KIND_ICON: Record<ImageAsset['kind'], string> = {
  'user-upload': '⬆',
  generated: '✦',
  edited: '✎',
  mask: '🖌',
  annotation: '⌗'
}

export default function VersionStrip() {
  const assets = useChatStore((s) => s.assets)
  const baseAssetId = useCanvasStore((s) => s.baseAssetId)
  const setBase = useCanvasStore((s) => s.setBase)
  const compareMode = useCanvasStore((s) => s.compareMode)
  const compareA = useCanvasStore((s) => s.compareA)
  const compareB = useCanvasStore((s) => s.compareB)
  const toggleCompare = useCanvasStore((s) => s.toggleCompare)
  const pickCompare = useCanvasStore((s) => s.pickCompare)

  const all = Object.values(assets).filter((a) => a.kind !== 'mask')
  // 候选(待选)不进版本树,单独成组,避免把树撑乱
  const confirmed = all.filter((a) => !a.draft)
  const drafts = all.filter((a) => a.draft).sort((a, b) => a.createdAt - b.createdAt)
  const rows = flattenTree(buildVersionTree(confirmed))
  const spent = totalCost(all)

  // 未选择时自动定位到最新一张正式图
  useEffect(() => {
    if (!baseAssetId && confirmed.length > 0) {
      setBase(confirmed[confirmed.length - 1].id)
    }
  }, [baseAssetId, confirmed, setBase])

  const handleClick = (asset: ImageAsset): void => {
    if (compareMode) {
      pickCompare(asset.id)
      return
    }
    setBase(asset.id)
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-[#15171c]">
      <header className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <h2 className="mr-auto text-xs font-semibold tracking-wide text-zinc-300">🗂 版本树</h2>
        {spent > 0 && <span className="text-[10px] text-emerald-300/90">≈{formatCost(spent)}</span>}
        <span className="text-[10px] text-zinc-500">{confirmed.length} 张</span>
        <button
          className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
            compareMode ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:border-emerald-500 hover:text-emerald-300'
          }`}
          title="A/B 对比:点两张图并排看(再点一次退出)"
          onClick={toggleCompare}
        >
          ⇆ {compareMode ? '对比中' : '对比'}
        </button>
      </header>

      {compareMode && (
        <p className="border-b border-zinc-800/80 px-3 py-1.5 text-[10px] text-zinc-500">
          点两张图选 A / B
          {compareA ? ' · 已选 A' : ''}
          {compareB ? ' · 已选 B' : ''}
          {compareA && compareB ? ' · 打开对比视图' : ''}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="px-3 py-4 text-center text-[11px] text-zinc-600">暂无图片;每次生成 / 编辑都会记录版本</p>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto p-2">
          {rows.map(({ asset, depth }) => {
            const isBase = asset.id === baseAssetId
            const isA = asset.id === compareA
            const isB = asset.id === compareB
            const kids = childCount(confirmed, asset.id)
            return (
              <button
                key={asset.id}
                className={`flex w-full items-center gap-2 rounded-lg border px-1.5 py-1 text-left ${
                  isBase
                    ? 'border-emerald-500 ring-1 ring-emerald-500/50'
                    : 'border-zinc-700/60 hover:border-zinc-500'
                }`}
                style={{ marginLeft: Math.min(depth, 6) * 12 }}
                onClick={() => handleClick(asset)}
                onDoubleClick={() => useViewerStore.getState().open(asset.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  void window.api.assets.contextMenu(asset.id)
                }}
                title={`${asset.kind === 'edited' ? '编辑' : asset.kind === 'generated' ? '生成' : '上传'} · 第 ${versionNumber(confirmed, asset)} 版${
                  asset.meta?.model ? ` · ${asset.meta.model}` : ''
                }${asset.meta?.size ? ` · ${asset.meta.size}` : ''}\n${new Date(asset.createdAt).toLocaleTimeString()}`}
              >
                <span className="relative shrink-0">
                  <img src={assetUrl(asset.sessionId, asset.fileName)} alt={asset.id} className="h-9 w-9 rounded object-cover" />
                  <span className="absolute -left-1 -top-1 rounded bg-black/70 px-0.5 text-[8px] leading-3 text-zinc-300">
                    {KIND_ICON[asset.kind]}
                  </span>
                  {(isA || isB) && (
                    <span className="absolute -right-1 -top-1 rounded bg-emerald-500 px-1 text-[8px] leading-3 font-medium text-black">
                      {isA ? 'A' : 'B'}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] text-zinc-300">
                    {depth > 0 && <span className="mr-1 text-zinc-600">↳</span>}
                    {asset.kind === 'user-upload' ? '上传' : asset.kind === 'edited' ? `改版 ${versionNumber(confirmed, asset)}` : `生成 ${versionNumber(confirmed, asset)}`}
                    {kids > 0 && <span className="ml-1 text-emerald-400/80">+{kids}</span>}
                  </span>
                  <span className="block truncate text-[9px] text-zinc-500">
                    {asset.meta?.size ?? (asset.width && asset.height ? `${asset.width}x${asset.height}` : '—')} ·{' '}
                    {new Date(asset.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}

      {drafts.length > 0 && (
        <div className="border-t border-zinc-800/80 px-2 py-2">
          <p className="mb-1 px-0.5 text-[10px] text-amber-300/90">待选候选 {drafts.length} 张(选用后进版本树)</p>
          <div className="grid grid-cols-4 gap-2">
            {drafts.map((asset) => (
              <button
                key={asset.id}
                className={`group relative overflow-hidden rounded-lg border border-dashed ${
                  asset.id === baseAssetId ? 'border-amber-400 ring-1 ring-amber-400/60' : 'border-amber-500/50 hover:border-amber-400'
                }`}
                onClick={() => handleClick(asset)}
                onDoubleClick={() => useViewerStore.getState().open(asset.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  void window.api.assets.contextMenu(asset.id)
                }}
                title="待选候选:在画布点「✓ 选用这张」转正"
              >
                <img src={assetUrl(asset.sessionId, asset.fileName)} alt={asset.id} className="aspect-square w-full object-cover" />
                <span className="absolute right-1 top-1 rounded bg-amber-400/95 px-1 text-[9px] leading-4 font-medium text-black">待选</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
