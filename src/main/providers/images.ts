// OpenAI 兼容图片接口:/images/generations(文生图)与 /images/edits(编辑/蒙版重绘)
// 归一化各家差异:b64_json 或 url 返回;可选参数被拒时「逐个降级」而不是一次全丢
// (旧实现在一个参数不被支持时会把 size/quality/format 全部丢掉,导致 4K、16:9、高清被静默降成 1024 方图)

import type { ImageProfile } from '@shared/types'
import { ApiError, joinUrl, readErrorMessage, withTimeout } from './http'
import {
  describeDropped,
  probeImageSize,
  sizeText,
  withParamFallback,
  type OptionalImageParam
} from './imageMeta'

const RATIO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1408x1056',
  '3:4': '1056x1408'
}

export function ratioToSize(ratio?: string): string | undefined {
  if (!ratio) return undefined
  return RATIO_SIZE[ratio.trim()]
}

/** 显式分辨率校验:WxH(如 2048x2048);非法返回 null */
export function parseExplicitSize(size?: string): string | null {
  if (!size) return null
  const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(size.trim())
  if (!m) return null
  return `${m[1]}x${m[2]}`
}

/**
 * 常见生图端点(含 GPT-Image 系)的长边上限。
 * 2026-10-21 实测 cf.api.fan:传 3072x4096 直接被拒 ——
 * "invalid size 3072x4096. The longest edge must be less than or equal to 3840"。
 * 与其把请求发出去吃一个 400,不如本地按比例收敛,并如实告诉用户"被收敛成多少"。
 */
export const MAX_IMAGE_EDGE = 3840

/**
 * 尺寸约束(2026-10-22 实测 cf.api.fan):
 *   - 长边 ≤ 3840
 *   - 宽高都必须是 16 的倍数(传 1000x640 被拒:Width and height must both be divisible by 16)
 * 与其把请求发出去吃 400,不如本地收敛,并如实告知"原请求被改成了多少"。
 */
export const IMAGE_SIZE_MULTIPLE = 16

/** 端点最小像素量(低于它直接 400:Requested resolution is below the current minimum pixel budget) */
export const MIN_IMAGE_PIXELS = 1_048_576

/** 把尺寸收敛到:长边 ≤ MAX_IMAGE_EDGE、宽高为 16 的倍数、像素量 ≥ MIN_IMAGE_PIXELS(保持比例) */
export function clampImageSize(size: string): { size: string; clamped: boolean; from?: string } {
  const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(size.trim())
  if (!m) return { size, clamped: false }
  const w = Number(m[1])
  const h = Number(m[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { size, clamped: false }
  const k = Math.min(1, MAX_IMAGE_EDGE / Math.max(w, h))
  const snap = (v: number): number =>
    Math.max(64, Math.round((v * k) / IMAGE_SIZE_MULTIPLE) * IMAGE_SIZE_MULTIPLE)
  let nw = snap(w)
  let nh = snap(h)
  if (nw * nh < MIN_IMAGE_PIXELS) {
    const f = Math.sqrt(MIN_IMAGE_PIXELS / (nw * nh))
    const up = (v: number): number =>
      Math.min(MAX_IMAGE_EDGE, Math.max(64, Math.ceil((v * f) / IMAGE_SIZE_MULTIPLE) * IMAGE_SIZE_MULTIPLE))
    nw = up(nw)
    nh = up(nh)
    while (nw * nh < MIN_IMAGE_PIXELS && (nw < MAX_IMAGE_EDGE || nh < MAX_IMAGE_EDGE)) {
      if (nw <= nh && nw < MAX_IMAGE_EDGE) nw += IMAGE_SIZE_MULTIPLE
      else if (nh < MAX_IMAGE_EDGE) nh += IMAGE_SIZE_MULTIPLE
      else break
    }
  }
  if (nw === w && nh === h) return { size: `${w}x${h}`, clamped: false }
  return { size: `${nw}x${nh}`, clamped: true, from: `${w}x${h}` }
}

interface RawImage {
  b64_json?: string
  url?: string
}

export interface GeneratedImages {
  buffers: Buffer[]
  /** 因端点不支持而被丢弃的可选参数(需如实告知用户"画质/尺寸被降级") */
  dropped: OptionalImageParam[]
  /** 请求的分辨率(已按端点上限收敛) */
  requestedSize?: string
  /** 原请求尺寸(被本地收敛时才有值) */
  clampedFrom?: string
  /** 接口实际返回的首张分辨率 */
  actualSize?: string
}

async function extractBuffers(json: { data?: RawImage[] }, timeoutMs: number): Promise<Buffer[]> {
  const items = json.data ?? []
  const out: Buffer[] = []
  for (const item of items) {
    if (item.b64_json) {
      out.push(Buffer.from(item.b64_json, 'base64'))
    } else if (item.url) {
      const res = await fetch(item.url, { signal: withTimeout(undefined, timeoutMs) })
      if (!res.ok) throw new ApiError(`下载生成图片失败(HTTP ${res.status})`, res.status)
      out.push(Buffer.from(await res.arrayBuffer()))
    }
  }
  if (!out.length) throw new ApiError('接口未返回任何图片数据')
  return out
}

function guessMime(buffer: Buffer): string {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length > 12 && buffer.subarray(0, 4).toString() === 'RIFF') return 'image/webp'
  return 'image/png'
}

/**
 * 端点拒绝某个可选参数(HTTP 400 且报文提及参数不支持)时的判定。
 * 各家用语不一,故按关键词宽匹配,再由 imageMeta 决定丢哪一个。
 */
function isUnsupportedParamError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 400 &&
    /parameter|参数|not support|unsupported|does not support|not allowed|不支持/i.test(err.message)
  )
}

/**
 * 逐参数降级(实现见 imageMeta.withParamFallback):
 * 端点只拒绝 quality 时不会连带丢掉 size / output_format。
 */

async function postImages(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ data?: RawImage[] }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: withTimeout(signal, timeoutMs)
  })
  if (!res.ok) await readErrorMessage(res)
  return (await res.json()) as { data?: RawImage[] }
}

/** 文生图;size 显式优先,其次比例映射;quality 可覆盖模型配置(高清档) */
export async function generateImages(opts: {
  profile: ImageProfile
  prompt: string
  ratio?: string
  size?: string
  n: number
  quality?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<GeneratedImages> {
  const { profile, prompt, ratio, size, n, timeoutMs, signal } = opts
  if (!profile.baseUrl || !profile.model) throw new ApiError('生图服务配置不完整(缺 baseUrl 或模型名)')
  if (!profile.apiKey) throw new ApiError('生图服务未配置 API Key')

  const url = joinUrl(profile.baseUrl, profile.genPath || '/images/generations')
  const rawRequested = parseExplicitSize(size) ?? ratioToSize(ratio)
  const fit = rawRequested ? clampImageSize(rawRequested) : { size: '', clamped: false }
  const requested = rawRequested ? fit.size : undefined
  const quality = (opts.quality ?? '').trim() || profile.quality

  const optional: OptionalImageParam[] = []
  if (requested) optional.push('size')
  if (quality) optional.push('quality')
  if (profile.outputFormat) optional.push('output_format')

  const { value: buffers, dropped } = await withParamFallback(optional, async (active) => {
    const body: Record<string, unknown> = { model: profile.model, prompt, n }
    if (active.includes('size') && requested) body.size = requested
    if (active.includes('quality') && quality) body.quality = quality
    if (active.includes('output_format') && profile.outputFormat) body.output_format = profile.outputFormat

    const json = await postImages(url, profile.apiKey, body, timeoutMs, signal)
    return extractBuffers(json, timeoutMs)
  }, isUnsupportedParamError)

  return {
    buffers,
    dropped,
    requestedSize: requested,
    actualSize: sizeText(probeImageSize(buffers[0], guessMime(buffers[0])))
  }
}

/** 编辑图片(整图指令编辑、蒙版局部重绘、多参考图融合),multipart/form-data
 * 多张输入图按 OpenAI 系惯例用重复的 image[] 字段;蒙版仅在单图时有效 */
export async function editImage(opts: {
  profile: ImageProfile
  prompt: string
  images: { buffer: Buffer; mime: string }[]
  mask?: Buffer
  ratio?: string
  size?: string
  quality?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<GeneratedImages> {
  const { profile, prompt, images, mask, ratio, size, timeoutMs, signal } = opts
  if (!profile.baseUrl || !profile.model) throw new ApiError('生图服务配置不完整(缺 baseUrl 或模型名)')
  if (!profile.apiKey) throw new ApiError('生图服务未配置 API Key')
  if (!images.length) throw new ApiError('缺少输入图片')

  const url = joinUrl(profile.baseUrl, profile.editPath || '/images/edits')
  const rawRequested = parseExplicitSize(size) ?? ratioToSize(ratio)
  const fit = rawRequested ? clampImageSize(rawRequested) : { size: '', clamped: false }
  const requested = rawRequested ? fit.size : undefined
  const quality = (opts.quality ?? '').trim() || profile.quality

  const optional: OptionalImageParam[] = []
  if (requested) optional.push('size')
  if (quality) optional.push('quality')
  if (profile.outputFormat) optional.push('output_format')
  if (profile.inputFidelity) optional.push('input_fidelity')

  const { value: buffers, dropped } = await withParamFallback(optional, async (active) => {
    const form = new FormData()
    form.append('model', profile.model)
    form.append('prompt', prompt)
    const toBlob = (buffer: Buffer, mime: string): { blob: Blob; ext: string } => ({
      blob: new Blob([buffer], { type: mime }),
      ext: mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
    })
    if (images.length === 1) {
      const { blob, ext } = toBlob(images[0].buffer, images[0].mime)
      form.append('image', blob, `image.${ext}`)
      if (mask) form.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png')
    } else {
      for (const img of images) {
        const { blob, ext } = toBlob(img.buffer, img.mime)
        form.append('image[]', blob, `image.${ext}`)
      }
    }
    if (active.includes('size') && requested) form.append('size', requested)
    if (active.includes('quality') && quality) form.append('quality', quality)
    if (active.includes('output_format') && profile.outputFormat) form.append('output_format', profile.outputFormat)
    if (active.includes('input_fidelity') && profile.inputFidelity) form.append('input_fidelity', profile.inputFidelity)

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}` },
      body: form,
      signal: withTimeout(signal, timeoutMs)
    })
    if (!res.ok) await readErrorMessage(res)
    const json = (await res.json()) as { data?: RawImage[] }
    return extractBuffers(json, timeoutMs)
  }, isUnsupportedParamError)

  return {
    buffers,
    dropped,
    requestedSize: requested,
    clampedFrom: fit.clamped ? fit.from : undefined,
    actualSize: sizeText(probeImageSize(buffers[0], guessMime(buffers[0])))
  }
}

/** 设置页连通性测试:实际生成一张小图(会消耗少量额度) */
export async function imagePing(profile: ImageProfile, timeoutMs = 120_000): Promise<void> {
  const result = await generateImages({
    profile,
    prompt: 'a small red circle on white background',
    ratio: '1:1',
    n: 1,
    timeoutMs
  })
  if (!result.buffers.length) throw new ApiError('接口未返回图片')
}

export { describeDropped, guessMime }
