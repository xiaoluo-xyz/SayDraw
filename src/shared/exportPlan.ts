// 交付导出:同一张图按多种比例/尺寸批量导出(PNG/JPEG/WebP),并生成交付清单
// 纯函数:切图方案(中心裁切)+ 命名规则 + 清单文本,便于单独验证

export interface ExportRatioMeta {
  id: string
  label: string
  /** 宽/高 */
  value: number
}

export const EXPORT_RATIOS: ExportRatioMeta[] = [
  { id: '1:1', label: '1x1', value: 1 },
  { id: '4:3', label: '4x3', value: 4 / 3 },
  { id: '16:9', label: '16x9', value: 16 / 9 },
  { id: '9:16', label: '9x16', value: 9 / 16 }
]

export const EXPORT_FORMATS = ['png', 'jpeg', 'webp'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export interface ExportPlan {
  ratio: string
  label: string
  width: number
  height: number
  /** 从源图裁切的区域(中心裁切,保持目标比例) */
  crop: { x: number; y: number; w: number; h: number }
}

/** 按比例与长边生成切图方案(中心裁切,不拉伸) */
export function planExports(sourceW: number, sourceH: number, ratios: string[], longEdge: number): ExportPlan[] {
  if (!sourceW || !sourceH || longEdge <= 0) return []
  const plans: ExportPlan[] = []
  for (const id of ratios) {
    const meta = EXPORT_RATIOS.find((r) => r.id === id)
    if (!meta) continue
    const aspect = meta.value
    const width = aspect >= 1 ? Math.round(longEdge) : Math.round(longEdge * aspect)
    const height = aspect >= 1 ? Math.round(longEdge / aspect) : Math.round(longEdge)

    // 中心裁切:取源图中与目标比例一致的最大区域
    const srcAspect = sourceW / sourceH
    let w = sourceW
    let h = sourceH
    if (srcAspect > aspect) w = Math.round(sourceH * aspect)
    else if (srcAspect < aspect) h = Math.round(sourceW / aspect)
    w = Math.min(sourceW, Math.max(1, w))
    h = Math.min(sourceH, Math.max(1, h))
    const x = Math.max(0, Math.round((sourceW - w) / 2))
    const y = Math.max(0, Math.round((sourceH - h) / 2))
    plans.push({ ratio: id, label: meta.label, width, height, crop: { x, y, w, h } })
  }
  return plans
}

/** 文件名:前缀(会话/资产)+ 比例 + 尺寸,去掉文件名非法字符 */
export function exportFileName(prefix: string, plan: ExportPlan, ext: string): string {
  const safe = (prefix || 'saydraw')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return `${safe}_${plan.label}_${plan.width}x${plan.height}.${ext}`
}

export interface ManifestInput {
  title: string
  sourceSize: string
  assetId: string
  prompt?: string
  meta?: Record<string, unknown>
  plans: ExportPlan[]
  format: string
  watermark?: string
  exportedAt: string
}

/** 交付清单(markdown):每张导出的比例/尺寸 + 提示词与参数,便于归档与复现 */
export function buildManifest(input: ManifestInput): string {
  const lines: string[] = []
  lines.push(`# 交付清单 · ${input.title}`)
  lines.push('')
  lines.push(`- 导出时间:${input.exportedAt}`)
  lines.push(`- 源图:${input.assetId}(${input.sourceSize})`)
  lines.push(`- 格式:${input.format}`)
  if (input.watermark) lines.push(`- 水印:${input.watermark}`)
  lines.push('')
  lines.push('| 比例 | 尺寸 | 文件 |')
  lines.push('|---|---|---|')
  for (const plan of input.plans) {
    lines.push(`| ${plan.ratio} | ${plan.width}×${plan.height} | ${exportFileName(input.title, plan, input.format)} |`)
  }
  if (input.prompt) {
    lines.push('')
    lines.push('## 提示词')
    lines.push('')
    lines.push('```')
    lines.push(input.prompt)
    lines.push('```')
  }
  if (input.meta && Object.keys(input.meta).length) {
    lines.push('')
    lines.push('## 生成参数')
    lines.push('')
    for (const [k, v] of Object.entries(input.meta)) {
      if (v === undefined || v === null || v === '') continue
      lines.push(`- ${k}:${Array.isArray(v) ? v.join(', ') : String(v)}`)
    }
  }
  return lines.join('\n')
}
