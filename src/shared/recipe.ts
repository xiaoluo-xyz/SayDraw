// 生成参数档案(.recipe.json):把一张图的提示词与参数完整描述出来,便于复现/归档/分享

import type { ImageAsset, ImageMeta } from './types'

export interface RecipeFile {
  recipeVersion: number
  app: string
  exportedAt: string
  asset: {
    id: string
    kind: ImageAsset['kind']
    width: number | null
    height: number | null
    createdAt: number
  }
  prompt: string
  meta: ImageMeta
}

export function buildRecipe(asset: ImageAsset, now: Date = new Date()): RecipeFile {
  return {
    recipeVersion: 1,
    app: 'SayDraw',
    exportedAt: now.toISOString(),
    asset: {
      id: asset.id,
      kind: asset.kind,
      width: asset.width ?? null,
      height: asset.height ?? null,
      createdAt: asset.createdAt
    },
    prompt: asset.prompt ?? '',
    meta: asset.meta ?? {}
  }
}

/** 面板上展示的一行参数摘要(缺项自动省略) */
export function summarizeMeta(meta?: ImageMeta): string[] {
  if (!meta) return []
  const parts: string[] = []
  if (meta.model) parts.push(meta.model)
  if (meta.size ?? meta.ratio) parts.push(meta.size ?? meta.ratio ?? '')
  if (meta.quality) parts.push(`quality ${meta.quality}`)
  if (meta.variants) parts.push(`候选 ×${meta.variants}`)
  if (typeof meta.elapsedMs === 'number') parts.push(`${(meta.elapsedMs / 1000).toFixed(0)}s`)
  if (meta.dropped?.length) parts.push(`已降级 ${meta.dropped.join('/')}`)
  return parts.filter(Boolean)
}
