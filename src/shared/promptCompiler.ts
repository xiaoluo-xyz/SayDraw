// 需求规格 ↔ 提示词:编译预览 + 画面约束行
// 之前「规避元素」只显示在面板里、从没进过提示词,模型照样把胶片边框/水印画进画面;
// 这里把规避项编译成模型能执行的约束句,并补一条"画面外装饰"护栏(用户明确要边框时不加)。

import type { ImageBrief } from './types'

/** 几乎没人想要的画面外元素;提示词本身想要(边框/画幅/拍立得…)时跳过 */
const FRAME_GUARD = '不要任何画面外装饰:边框、画幅编号、胶片齿孔、水印、签名、贴纸文字'
const FRAME_REQUESTED = /边框|画框|相框|编号|齿孔|水印|签名|贴纸|拍立得|polaroid|border|frame/i

/** 把规避元素拆成清单(只按中文顿号/逗号/分号拆,英文短语保持完整) */
export function splitNegatives(raw?: string): string[] {
  if (!raw) return []
  return raw
    .split(/[,,;;、\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
}

/**
 * 画面约束行:追加到生图/编辑提示词末尾。
 * - 有规避元素 → 明确列出「不要出现:…」
 * - 提示词没主动要求边框类元素 → 补一条画面外装饰护栏
 */
export function buildConstraintClause(brief: ImageBrief, prompt: string): string {
  const clauses: string[] = []
  const negatives = splitNegatives(brief.negativePrompts)
  if (negatives.length) clauses.push(`不要出现以下元素:${negatives.join('、')}`)
  if (!FRAME_REQUESTED.test(prompt)) clauses.push(FRAME_GUARD)
  if (!clauses.length) return ''
  const text = `画面约束(必须遵守):${clauses.join(';')}。`
  return `\n\n${text.length > 400 ? text.slice(0, 400) : text}`
}

/** 把需求规格编译成一段可直接读/复制的提示词(面板里的「编译预览」) */
export function compileBriefPrompt(brief: ImageBrief): string {
  const lines: string[] = []
  const subject = brief.subject?.trim()
  if (subject) lines.push(`主体:${subject}`)
  if (brief.composition?.trim()) lines.push(`构图:${brief.composition.trim()}`)
  if (brief.style?.trim()) lines.push(`风格:${brief.style.trim()}`)
  if (brief.colorTone?.trim()) lines.push(`光影色调:${brief.colorTone.trim()}`)

  const frame: string[] = []
  if (brief.aspectRatio?.trim()) frame.push(`比例 ${brief.aspectRatio.trim()}`)
  if (brief.resolution?.trim()) frame.push(brief.resolution.trim())
  if (brief.usage?.trim()) frame.push(`用途:${brief.usage.trim()}`)
  if (frame.length) lines.push(`规格:${frame.join(' · ')}`)

  const negatives = splitNegatives(brief.negativePrompts)
  if (negatives.length) lines.push(`避免:${negatives.join('、')}`)
  if (brief.notes?.trim()) lines.push(`补充:${brief.notes.trim()}`)

  if (!lines.length) return ''
  lines.push('', '画面约束(必须遵守):' + (negatives.length ? `不要出现以下元素:${negatives.join('、')};` : '') + FRAME_GUARD + '。')
  return lines.join('\n')
}

/** 槽位完成度:用于面板提示(必填槽位是否齐全) */
export function briefCompleteness(brief: ImageBrief, requiredKeys: (keyof ImageBrief)[]): { filled: number; total: number; missing: string[] } {
  const missing = requiredKeys.filter((k) => {
    const v = brief[k]
    return typeof v !== 'string' || !v.trim()
  })
  return { filled: requiredKeys.length - missing.length, total: requiredKeys.length, missing: missing.map(String) }
}
