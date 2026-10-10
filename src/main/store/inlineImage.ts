// 送模型的图片内联:统一缩放 + 重新编码后再 base64,避免把几十 MB 原图塞进对话请求体
// 背景:2026-10-10 实测——导入 3 张 8192×6144 实拍(约 20MB/张)后,单次请求体膨胀到 ≈90MB,
//      超过 settings.chatTimeoutMs(默认 120s 硬 deadline)被掐断,表现为界面「出错」。
// 策略:原图仍在磁盘上原样保留(生图/编辑/蒙版用的是原图),只对「送给 LLM 看的副本」做压缩。
//      ① 本来就够小 → 原样返回,零成本零画质损失(带透明的图另放宽边长,见 INLINE_ALPHA_MAX_EDGE)
//      ② 否则缩到长边上限,再按 INLINE_MAX_BYTES(真正上网的 base64 量)编码:PNG 源优先 PNG 保透明,超限才退 JPEG
//      ③ 结果按 资产 id + 源文件 size/mtime 在内存里缓存,同一张图一轮对话里只编码一次

import { nativeImage } from 'electron'
import fs from 'node:fs'
import type { ImageAsset } from '@shared/types'
import { assetAbsolutePath } from './assets'

/** 内联图长边上限(视觉模型辨认足够,再大只是烧带宽) */
export const INLINE_MAX_EDGE = 1280
/** 蒙版图的长边上限:上面可能有小编号,压太狠会读不出来(色块 PNG 本身很小,放宽代价低) */
export const INLINE_MASK_MAX_EDGE = 2048
/**
 * 带透明的图(蒙版、抠图)允许原样直传的边长上限。
 * 实测(nativeImage):3000×3000 的平色透明 PNG 只有 104KB,但 resize 之后透明区的 RGB
 * 被插值成噪声,PNG 直接涨到 7.15MB —— 缩放反而更糟,所以这类图优先原样直传。
 */
export const INLINE_ALPHA_MAX_EDGE = 4096
/** 单张内联图目标上限:按真正上网的 base64 文本量算(原始字节 base64 后约 ×4/3) */
export const INLINE_MAX_BYTES = 1_500_000
const INLINE_JPEG_QUALITY = 82
const INLINE_JPEG_QUALITY_FALLBACK = 70
/** 缓存条数上限:超出后丢最旧的(代价只是重新编码一次,不会无限涨内存) */
const CACHE_MAX_ENTRIES = 40

/** 原始字节 base64 之后的文本量 */
function b64Bytes(rawLen: number): number {
  return Math.ceil(rawLen / 3) * 4
}

export interface InlineImage {
  /** data:image/...;base64,... */
  dataUrl: string
  /** base64 之后的字节数(用于请求体预算) */
  bytes: number
  width?: number
  height?: number
  mime: string
  /** 是否做了压缩(未压缩=原图直传) */
  compressed: boolean
}

/** 编码结果缓存:key = 资产 id + 源文件 size:mtime(源文件变了自然失效) */
const cache = new Map<string, InlineImage>()

function cacheKey(id: string, size: number, mtimeMs: number): string {
  return `${id}:${size}:${mtimeMs}`
}

function remember(key: string, value: InlineImage): InlineImage {
  cache.set(key, value)
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return value
}

function dataUrlOf(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

function plainResult(mime: string, buffer: Buffer, width?: number, height?: number): InlineImage {
  const dataUrl = dataUrlOf(mime, buffer)
  return { dataUrl, bytes: dataUrl.length, width, height, mime, compressed: false }
}

/** 长边缩放到 edge 以内(只缩不放),保持比例 */
function fitEdge(img: Electron.NativeImage, edge: number): Electron.NativeImage {
  const { width, height } = img.getSize()
  if (!width || !height) return img
  if (Math.max(width, height) <= edge) return img
  return width >= height ? img.resize({ width: edge, quality: 'good' }) : img.resize({ height: edge, quality: 'good' })
}

export interface InlineSource {
  id: string
  kind: ImageAsset['kind']
  mime: string
  width?: number
  height?: number
  /** 蒙版必须保透明(接口蒙版的透明区=待修改区域),优先 PNG 编码 */
  keepAlpha?: boolean
}

/** 由磁盘文件生成内联副本。传入绝对路径,便于脱离会话/DB 单独测试(scripts/verify-fix.cjs) */
export function prepareInlineImageFromFile(source: InlineSource, srcPath: string): InlineImage {
  let stat: fs.Stats
  try {
    stat = fs.statSync(srcPath)
  } catch {
    throw new Error(`图片文件不可读:${srcPath}`)
  }
  const key = cacheKey(source.id, stat.size, stat.mtimeMs)
  const hit = cache.get(key)
  if (hit) return hit

  const buffer = fs.readFileSync(srcPath)
  const rawMime = source.mime || 'image/png'
  const keepAlpha = source.keepAlpha ?? source.kind === 'mask'
  const rawEdge = Math.max(source.width ?? 0, source.height ?? 0)

  // ① 已经够小(带透明的图放宽边长):原样直传,零画质损失、零重编码成本
  const passEdge = keepAlpha ? INLINE_ALPHA_MAX_EDGE : INLINE_MAX_EDGE
  if (b64Bytes(buffer.length) <= INLINE_MAX_BYTES && rawEdge > 0 && rawEdge <= passEdge) {
    return remember(key, plainResult(rawMime, buffer, source.width, source.height))
  }

  let img: Electron.NativeImage
  try {
    img = nativeImage.createFromBuffer(buffer)
  } catch {
    img = nativeImage.createEmpty()
  }
  if (img.isEmpty()) {
    // 解不出的格式(或异常大图):退回原图,由请求体预算决定是否丢弃
    return remember(key, plainResult(rawMime, buffer, source.width, source.height))
  }

  const outerEdge = keepAlpha ? INLINE_MASK_MAX_EDGE : INLINE_MAX_EDGE
  const scaled = fitEdge(img, outerEdge)
  let size = scaled.getSize()

  // ② 编码:PNG 源(含蒙版)优先 PNG 保透明;PNG 超限先降一档边长再试,仍超限才退 JPEG
  let outMime = 'image/jpeg'
  let outBuf: Buffer = Buffer.alloc(0)
  if (keepAlpha || rawMime.includes('png') || rawMime.includes('webp')) {
    const png = scaled.toPNG()
    if (b64Bytes(png.length) <= INLINE_MAX_BYTES) {
      outMime = 'image/png'
      outBuf = png
    } else if (Math.max(size.width, size.height) > INLINE_MAX_EDGE) {
      const smaller = fitEdge(scaled, INLINE_MAX_EDGE)
      const png2 = smaller.toPNG()
      if (b64Bytes(png2.length) <= INLINE_MAX_BYTES) {
        outMime = 'image/png'
        outBuf = png2
        size = smaller.getSize()
      }
    }
  }
  if (!outBuf.length) {
    // 兜底 JPEG:有损但体积小得多。若这是蒙版,透明区会变黑底——只影响"给模型看的副本",
    // 真正拿去 edit_image 的仍是磁盘上的原图。
    const jpeg = scaled.toJPEG(INLINE_JPEG_QUALITY)
    outMime = 'image/jpeg'
    outBuf = jpeg
    if (b64Bytes(jpeg.length) > INLINE_MAX_BYTES) {
      const smaller = fitEdge(scaled, Math.round(INLINE_MAX_EDGE * 0.75))
      const fallback = smaller.toJPEG(INLINE_JPEG_QUALITY_FALLBACK)
      if (fallback.length < jpeg.length) {
        outBuf = fallback
        size = smaller.getSize()
      }
    }
  }
  if (!outBuf.length) {
    return remember(key, plainResult(rawMime, buffer, source.width, source.height))
  }

  const dataUrl = dataUrlOf(outMime, outBuf)
  return remember(key, {
    dataUrl,
    bytes: dataUrl.length,
    width: size.width,
    height: size.height,
    mime: outMime,
    compressed: true
  })
}

/** 由资产元数据生成内联副本(自动定位磁盘文件) */
export function prepareInlineImage(asset: ImageAsset): InlineImage {
  return prepareInlineImageFromFile(
    { id: asset.id, kind: asset.kind, mime: asset.mime, width: asset.width, height: asset.height },
    assetAbsolutePath(asset)
  )
}
