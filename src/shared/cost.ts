// 成本估算:按模型单价(元/张)统计单张与会话累计,纯函数便于验证

import type { ImageAsset, ImageMeta } from './types'

/** 单张成本:优先取快照里的 cost,否则用单价兜底 */
export function assetCost(asset: ImageAsset, fallbackPrice = 0): number {
  const cost = asset.meta?.cost
  if (typeof cost === 'number' && Number.isFinite(cost)) return Math.max(0, cost)
  if (asset.kind === 'generated' || asset.kind === 'edited') return Math.max(0, fallbackPrice)
  return 0
}

/** 会话累计成本(只统计生成/编辑图,上传与蒙版不计) */
export function totalCost(assets: ImageAsset[], fallbackPrice = 0): number {
  return assets.reduce((sum, asset) => sum + assetCost(asset, fallbackPrice), 0)
}

/** 金额展示:小于 1 元保留两位,整数不带小数 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '¥0'
  if (value >= 100) return `¥${Math.round(value)}`
  return `¥${value.toFixed(2)}`
}

/** 快照里的成本:单价 × 该次实际出图张数 */
export function computeCost(meta: ImageMeta | undefined, pricePerImage: number | undefined, images: number): number | undefined {
  if (!pricePerImage || pricePerImage <= 0) return undefined
  const count = Math.max(1, images)
  return Number((pricePerImage * count).toFixed(4))
}
