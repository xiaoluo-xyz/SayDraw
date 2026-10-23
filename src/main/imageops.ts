// 像素进出主进程:nativeImage ↔ 直通 alpha 的 RGBA 缓冲区
//
// 实测(2026-10-20,_demo/premul-probe.cjs):Electron 的 toBitmap()/createFromBitmap() 用的是
// **预乘 alpha 的 BGRA**;纯红 50% 透明读回来是 [0,0,128,128]。
// 直接拿预乘值做混合会让半透明边缘发黑,所以这里统一转成直通 alpha 再交给合成内核。

import { nativeImage } from 'electron'
import { scaleImage } from '@shared/composite'
import type { RgbaImage } from '@shared/composite'

/** 40M 像素(约 40MB×4)以上的图先缩再合成,避免一次性申请几百 MB */
export const MAX_COMPOSITE_PIXELS = 40_000_000

export function decodeRgba(buffer: Buffer): RgbaImage | null {
  const img = nativeImage.createFromBuffer(buffer)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  if (!width || !height) return null
  const bmp = img.toBitmap() // BGRA,预乘
  const pixels = width * height
  const data = new Uint8Array(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    const si = i * 4
    // 部分平台返回的 stride 可能与 width*4 不同,这里按 length 兜底
    if (si + 3 >= bmp.length) break
    const b = bmp[si]
    const g = bmp[si + 1]
    const r = bmp[si + 2]
    const a = bmp[si + 3]
    if (a === 0) {
      data[si] = 0
      data[si + 1] = 0
      data[si + 2] = 0
      data[si + 3] = 0
      continue
    }
    const un = 255 / a
    data[si] = Math.min(255, Math.round(r * un))
    data[si + 1] = Math.min(255, Math.round(g * un))
    data[si + 2] = Math.min(255, Math.round(b * un))
    data[si + 3] = a
  }
  return { data, width, height }
}

export function encodeRgba(img: RgbaImage, format: 'png' | 'jpeg', quality = 92): Buffer {
  const pixels = img.width * img.height
  const bmp = Buffer.allocUnsafe(pixels * 4)
  // jpeg 没有 alpha:先把透明区域压到白底,避免出现脏黑边
  let hasAlpha = false
  if (format === 'jpeg') {
    for (let i = 0; i < pixels; i++) {
      if (img.data[i * 4 + 3] < 250) {
        hasAlpha = true
        break
      }
    }
  }
  for (let i = 0; i < pixels; i++) {
    const si = i * 4
    let r = img.data[si]
    let g = img.data[si + 1]
    let b = img.data[si + 2]
    let a = img.data[si + 3]
    if (hasAlpha && a < 255) {
      const k = a / 255
      r = r * k + 255 * (1 - k)
      g = g * k + 255 * (1 - k)
      b = b * k + 255 * (1 - k)
      a = 255
    }
    const k = a / 255
    bmp[si] = Math.round(b * k) // B
    bmp[si + 1] = Math.round(g * k) // G
    bmp[si + 2] = Math.round(r * k) // R
    bmp[si + 3] = a
  }
  const out = nativeImage.createFromBitmap(bmp, { width: img.width, height: img.height })
  return format === 'jpeg' ? out.toJPEG(quality) : out.toPNG()
}

/** 尺寸上限保护:超限等比缩小(返回新图与是否缩过) */
export function guardSize(img: RgbaImage): { image: RgbaImage; scaled: boolean; from?: string } {
  const pixels = img.width * img.height
  if (pixels <= MAX_COMPOSITE_PIXELS) return { image: img, scaled: false }
  const k = Math.sqrt(MAX_COMPOSITE_PIXELS / pixels)
  const width = Math.max(1, Math.floor(img.width * k))
  const height = Math.max(1, Math.floor(img.height * k))
  return { image: scaleImage(img, width, height), scaled: true, from: `${img.width}x${img.height}` }
}
