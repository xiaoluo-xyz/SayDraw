// 本地合成内核(纯函数,不依赖 electron / DOM):
// 所有输入输出都是「直通 alpha 的 RGBA」,可以在主进程(nativeImage)与渲染进程(canvas)两个宿主里跑,
// 也可以用 node 直接单测(scripts/verify-composite.mjs)。
//
// 为什么不用 sharp:项目一直坚持零原生依赖;nativeImage.toBitmap() 能拿到并写回原始像素,
// 贴图/换色/圆角/拼接这些算子自己写足够,还省掉打包时 asarUnpack + ABI 重建的麻烦。

export interface RgbaImage {
  data: Uint8Array
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Blend = 'normal' | 'multiply' | 'screen'

export type Rgba = [number, number, number, number]

const clamp255 = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n))
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** 颜色解析:#rgb / #rrggbb / #rrggbbaa / "12,34,56" ;无法解析返回 null */
export function parseColor(input: unknown): Rgba | null {
  if (Array.isArray(input) && input.length >= 3) {
    return [clamp255(Number(input[0])), clamp255(Number(input[1])), clamp255(Number(input[2])), input[3] === undefined ? 255 : clamp255(Number(input[3]))]
  }
  const text = String(input ?? '').trim()
  if (!text) return null
  if (/^#?[0-9a-f]{3}$/i.test(text) || /^#?[0-9a-f]{4}$/i.test(text)) {
    const hex = text.replace('#', '')
    const parts = hex.split('').map((c) => parseInt(c + c, 16))
    return [parts[0], parts[1], parts[2], parts[3] ?? 255]
  }
  if (/^#?[0-9a-f]{6}$/i.test(text) || /^#?[0-9a-f]{8}$/i.test(text)) {
    const hex = text.replace('#', '')
    const num = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return [num(0), num(1), num(2), hex.length === 8 ? num(3) : 255]
  }
  const csv = text.split(/[,\s]+/).map(Number)
  if (csv.length >= 3 && csv.every((n, i) => i > 3 || Number.isFinite(n))) {
    return [clamp255(csv[0]), clamp255(csv[1]), clamp255(csv[2]), csv[3] === undefined ? 255 : clamp255(csv[3])]
  }
  return null
}

export function makeImage(width: number, height: number, fill?: Rgba): RgbaImage {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const data = new Uint8Array(w * h * 4)
  if (fill) {
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = fill[0]
      data[i * 4 + 1] = fill[1]
      data[i * 4 + 2] = fill[2]
      data[i * 4 + 3] = fill[3]
    }
  }
  return { data, width: w, height: h }
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { data: new Uint8Array(img.data), width: img.width, height: img.height }
}

export function pixelAt(img: RgbaImage, x: number, y: number): Rgba {
  const ix = Math.min(img.width - 1, Math.max(0, x | 0))
  const iy = Math.min(img.height - 1, Math.max(0, y | 0))
  const i = (iy * img.width + ix) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
}

function setPixel(img: RgbaImage, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const i = (y * img.width + x) * 4
  img.data[i] = clamp255(r)
  img.data[i + 1] = clamp255(g)
  img.data[i + 2] = clamp255(b)
  img.data[i + 3] = clamp255(a)
}

/** 双线性采样(直通 alpha;按 alpha 加权避免透明边缘发黑) */
function sampleBilinear(img: RgbaImage, fx: number, fy: number): Rgba {
  const x = Math.min(img.width - 1, Math.max(0, fx))
  const y = Math.min(img.height - 1, Math.max(0, fy))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(img.width - 1, x0 + 1)
  const y1 = Math.min(img.height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const w00 = (1 - tx) * (1 - ty)
  const w10 = tx * (1 - ty)
  const w01 = (1 - tx) * ty
  const w11 = tx * ty
  const p00 = pixelAt(img, x0, y0)
  const p10 = pixelAt(img, x1, y0)
  const p01 = pixelAt(img, x0, y1)
  const p11 = pixelAt(img, x1, y1)
  const a = p00[3] * w00 + p10[3] * w10 + p01[3] * w01 + p11[3] * w11
  if (a <= 0.0001) return [0, 0, 0, 0]
  const ch = (idx: number): number =>
    (p00[idx] * p00[3] * w00 + p10[idx] * p10[3] * w10 + p01[idx] * p01[3] * w01 + p11[idx] * p11[3] * w11) / a
  return [clamp255(ch(0)), clamp255(ch(1)), clamp255(ch(2)), clamp255(a)]
}

/** 裁剪(越界自动收到有效区;结果至少 1×1) */
export function cropImage(img: RgbaImage, rect: Rect): RgbaImage {
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const x1 = Math.min(img.width, Math.round(rect.x + rect.w))
  const y1 = Math.min(img.height, Math.round(rect.y + rect.h))
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const out = makeImage(w, h)
  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * img.width + x0) * 4
    out.data.set(img.data.subarray(srcStart, srcStart + w * 4), y * w * 4)
  }
  return out
}

/** 等比缩放到指定尺寸(双线性) */
export function scaleImage(img: RgbaImage, width: number, height: number): RgbaImage {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (w === img.width && h === img.height) return cloneImage(img)
  const out = makeImage(w, h)
  for (let y = 0; y < h; y++) {
    const sy = h === 1 ? 0 : ((y + 0.5) * img.height) / h - 0.5
    for (let x = 0; x < w; x++) {
      const sx = w === 1 ? 0 : ((x + 0.5) * img.width) / w - 0.5
      const p = sampleBilinear(img, sx, sy)
      setPixel(out, x, y, p[0], p[1], p[2], p[3])
    }
  }
  return out
}

/** 等比缩放到能装进 maxW×maxH 的最大尺寸(不放大) */
export function fitInside(img: RgbaImage, maxW: number, maxH: number, allowUpscale = false): RgbaImage {
  const s = Math.min(maxW / img.width, maxH / img.height)
  const scale = allowUpscale ? s : Math.min(1, s)
  if (Math.abs(scale - 1) < 0.0005) return cloneImage(img)
  return scaleImage(img, Math.round(img.width * scale), Math.round(img.height * scale))
}

/** 画布扩边/定尺寸:原图居中放进去,其余填 fill(默认透明) */
export function expandCanvas(img: RgbaImage, width: number, height: number, fill?: Rgba, anchor: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' = 'center'): RgbaImage {
  const out = makeImage(width, height, fill ?? [0, 0, 0, 0])
  let ox = 0
  let oy = 0
  if (anchor === 'center') {
    ox = Math.round((out.width - img.width) / 2)
    oy = Math.round((out.height - img.height) / 2)
  } else if (anchor.includes('right')) ox = out.width - img.width
  if (anchor.includes('bottom')) oy = out.height - img.height
  for (let y = 0; y < img.height; y++) {
    const dy = y + oy
    if (dy < 0 || dy >= out.height) continue
    for (let x = 0; x < img.width; x++) {
      const dx = x + ox
      if (dx < 0 || dx >= out.width) continue
      const si = (y * img.width + x) * 4
      const di = (dy * out.width + dx) * 4
      out.data[di] = img.data[si]
      out.data[di + 1] = img.data[si + 1]
      out.data[di + 2] = img.data[si + 2]
      out.data[di + 3] = img.data[si + 3]
    }
  }
  return out
}

function blendChannel(mode: Blend, src: number, dst: number): number {
  if (mode === 'multiply') return (src * dst) / 255
  if (mode === 'screen') return 255 - ((255 - src) * (255 - dst)) / 255
  return src
}

/**
 * 贴图:把 src 的 srcRect 区域(像素坐标)绘制到 dst 的 dstRect 区域(像素坐标)。
 * 直接改 dst。opacity 0-1;blend 为与底图的混合方式(默认 normal = source-over)。
 */
export function pasteImage(
  dst: RgbaImage,
  src: RgbaImage,
  srcRect: Rect,
  dstRect: Rect,
  options: { opacity?: number; blend?: Blend } = {}
): void {
  const opacity = options.opacity === undefined ? 1 : clamp01(options.opacity)
  const blend = options.blend ?? 'normal'
  const dw = Math.max(1, Math.round(dstRect.w))
  const dh = Math.max(1, Math.round(dstRect.h))
  const ox = Math.round(dstRect.x)
  const oy = Math.round(dstRect.y)
  for (let y = 0; y < dh; y++) {
    const dy = y + oy
    if (dy < 0 || dy >= dst.height) continue
    for (let x = 0; x < dw; x++) {
      const dx = x + ox
      if (dx < 0 || dx >= dst.width) continue
      const sx = srcRect.x + ((x + 0.5) * srcRect.w) / dw - 0.5
      const sy = srcRect.y + ((y + 0.5) * srcRect.h) / dh - 0.5
      const s = sampleBilinear(src, sx, sy)
      const sa = (s[3] / 255) * opacity
      if (sa <= 0) continue
      const di = (dy * dst.width + dx) * 4
      const da = dst.data[di + 3] / 255
      const sr = blendChannel(blend, s[0], dst.data[di])
      const sg = blendChannel(blend, s[1], dst.data[di + 1])
      const sb = blendChannel(blend, s[2], dst.data[di + 2])
      const outA = sa + da * (1 - sa)
      if (outA <= 0) continue
      for (let c = 0; c < 3; c++) {
        const sc = c === 0 ? sr : c === 1 ? sg : sb
        const dc = dst.data[di + c]
        dst.data[di + c] = clamp255((sc * sa + dc * da * (1 - sa)) / outA)
      }
      dst.data[di + 3] = clamp255(outA * 255)
    }
  }
}

/** 非透明像素的包围盒(用于"自动取主体"贴图);全透明返回 null */
export function alphaBBox(img: RgbaImage, threshold = 8): Rect | null {
  let minX = img.width
  let minY = img.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const toRgb = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return [toRgb(h + 1 / 3) * 255, toRgb(h) * 255, toRgb(h - 1 / 3) * 255]
}

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

export interface RecolorOptions {
  /** 只改这块区域(mask 里 alpha 不为 0 的像素);不传 = 整图 */
  mask?: RgbaImage
  /** mask 的语义:regionInside='opaque' 用不透明处,*=transparent 用透明处(与应用的蒙版约定一致:透明=待改) */
  maskRegion?: 'opaque' | 'transparent'
  /** 色相偏移(度) */
  hue?: number
  /** 饱和度乘数(1 = 不变) */
  saturation?: number
  /** 明度偏移(-1..1,0 = 不变) */
  lightness?: number
  /** 对比度乘数(1 = 不变) */
  contrast?: number
  /** 色温:-1 冷 … +1 暖 */
  temperature?: number
  /** 换色时保持原亮度(只改色相/饱和) */
  preserveLuma?: boolean
}

/** 调色/局部换色(就地修改) */
export function recolor(img: RgbaImage, options: RecolorOptions): void {
  const { hue = 0, saturation = 1, lightness = 0, contrast = 1, temperature = 0, preserveLuma = false, mask } = options
  const region = options.maskRegion ?? 'opaque'
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let weight = 1
      if (mask) {
        const mx = Math.min(mask.width - 1, Math.floor((x * mask.width) / img.width))
        const my = Math.min(mask.height - 1, Math.floor((y * mask.height) / img.height))
        const ma = mask.data[(my * mask.width + mx) * 4 + 3]
        weight = region === 'transparent' ? 1 - ma / 255 : ma / 255
        if (weight <= 0.001) continue
      }
      const i = (y * img.width + x) * 4
      if (img.data[i + 3] === 0) continue
      const before = [img.data[i], img.data[i + 1], img.data[i + 2]] as [number, number, number]
      const beforeLuma = luma(before[0], before[1], before[2])
      // ① 色相 / 饱和度(保持 HSL 的明度,避免换色就变暗)
      const [h, s, l] = rgbToHsl(before[0], before[1], before[2])
      let [r, g, b] = hslToRgb(((h + hue / 360) % 1 + 1) % 1, clamp01(s * saturation), l)
      // ② preserveLuma:只把"换色/去色"造成的亮度漂移拉回原亮度,不抵消显式的明暗调整
      if (preserveLuma) {
        const after = luma(r, g, b)
        if (after > 1) {
          const k = beforeLuma / after
          r *= k
          g *= k
          b *= k
        }
      }
      // ③ 明度(HSL 的 l 上加减,直观对应"亮/暗")
      if (lightness !== 0) {
        const [h2, s2, l2] = rgbToHsl(clamp255(r), clamp255(g), clamp255(b))
        const shifted = hslToRgb(h2, s2, clamp01(l2 + lightness))
        r = shifted[0]
        g = shifted[1]
        b = shifted[2]
      }
      // ④ 对比度 / 色温
      if (contrast !== 1) {
        r = (r - 128) * contrast + 128
        g = (g - 128) * contrast + 128
        b = (b - 128) * contrast + 128
      }
      if (temperature !== 0) {
        r += temperature * 26
        b -= temperature * 26
      }
      for (let c = 0; c < 3; c++) {
        const value = c === 0 ? r : c === 1 ? g : b
        img.data[i + c] = clamp255(img.data[i + c] + (value - before[c]) * weight)
      }
    }
  }
}

/** 圆角矩形的覆盖率(-1..1 的近似 SDF,边缘 1px 抗锯齿) */
function roundRectCoverage(px: number, py: number, w: number, h: number, r: number): number {
  const cx = w / 2
  const cy = h / 2
  const rr = Math.max(0, Math.min(r, Math.min(cx, cy)))
  const dx = Math.abs(px - cx) - (cx - rr)
  const dy = Math.abs(py - cy) - (cy - rr)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - rr
  return clamp01(0.5 - outside)
}

/** 圆角 + 可选描边/底色(返回新图) */
export function roundCorners(
  img: RgbaImage,
  radius: number,
  options: { stroke?: number; strokeColor?: Rgba; background?: Rgba } = {}
): RgbaImage {
  const stroke = Math.max(0, Math.round(options.stroke ?? 0))
  const strokeColor = options.strokeColor ?? [0, 0, 0, 255]
  const background = options.background
  const out = background ? makeImage(img.width, img.height, background) : makeImage(img.width, img.height)
  const innerW = Math.max(1, img.width - stroke * 2)
  const innerH = Math.max(1, img.height - stroke * 2)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      const cover = roundRectCoverage(cx, cy, img.width, img.height, radius)
      const di = (y * img.width + x) * 4
      const srcA = (img.data[di + 3] / 255) * cover
      // 底色 + 底图
      const ba = out.data[di + 3] / 255
      const oa = srcA + ba * (1 - srcA)
      for (let c = 0; c < 3; c++) {
        out.data[di + c] = clamp255((img.data[di + c] * srcA + out.data[di + c] * ba * (1 - srcA)) / (oa || 1))
      }
      out.data[di + 3] = clamp255(oa * 255)
      // 描边:外轮廓覆盖减去内轮廓覆盖 = 环(内矩形原点在 stroke 处,坐标要平移)
      if (stroke > 0) {
        const inner = roundRectCoverage(cx - stroke, cy - stroke, innerW, innerH, Math.max(0, radius - stroke))
        const ring = clamp01(cover - inner)
        if (ring > 0.001) {
          const a = ring * (strokeColor[3] / 255)
          const da = out.data[di + 3] / 255
          const roa = a + da * (1 - a)
          for (let c = 0; c < 3; c++) {
            out.data[di + c] = clamp255((strokeColor[c] * a + out.data[di + c] * da * (1 - a)) / (roa || 1))
          }
          out.data[di + 3] = clamp255(roa * 255)
        }
      }
    }
  }
  return out
}

/** 叠加 10×10 坐标网格(用于让模型读出归一化坐标);就地修改 */
export function drawGrid(img: RgbaImage, options: { cells?: number; color?: Rgba; thickness?: number } = {}): void {
  const cells = Math.max(2, Math.min(20, Math.round(options.cells ?? 10)))
  const color = options.color ?? [255, 64, 64, 120]
  const thickness = options.thickness ?? Math.max(1, Math.round(Math.min(img.width, img.height) / 500))
  const alpha = color[3] / 255
  const paint = (x: number, y: number): void => {
    for (let oy = 0; oy < thickness; oy++) {
      for (let ox = 0; ox < thickness; ox++) {
        const px = Math.min(img.width - 1, x + ox)
        const py = Math.min(img.height - 1, y + oy)
        const i = (py * img.width + px) * 4
        for (let c = 0; c < 3; c++) img.data[i + c] = clamp255(img.data[i + c] * (1 - alpha) + color[c] * alpha)
        img.data[i + 3] = clamp255(Math.max(img.data[i + 3], 255 * alpha))
      }
    }
  }
  for (let i = 0; i <= cells; i++) {
    const x = Math.min(img.width - 1, Math.round((i * img.width) / cells))
    const y = Math.min(img.height - 1, Math.round((i * img.height) / cells))
    for (let yy = 0; yy < img.height; yy++) paint(x, yy)
    for (let xx = 0; xx < img.width; xx++) paint(xx, y)
  }
}

export interface GridOptions {
  cols?: number
  gap?: number
  margin?: number
  background?: Rgba
}

/** 拼接:多张图按网格排列(contain 进格子,居中),返回新图 */
export function gridImages(images: RgbaImage[], options: GridOptions = {}): RgbaImage {
  const list = images.filter(Boolean)
  if (!list.length) return makeImage(1, 1)
  const cols = Math.max(1, Math.min(list.length, Math.round(options.cols ?? Math.ceil(Math.sqrt(list.length)))))
  const rows = Math.ceil(list.length / cols)
  const gap = Math.max(0, Math.round(options.gap ?? Math.round(Math.min(...list.map((i) => Math.min(i.width, i.height))) * 0.03)))
  const margin = Math.max(0, Math.round(options.margin ?? gap))
  const cellW = Math.max(...list.map((i) => i.width))
  const cellH = Math.max(...list.map((i) => i.height))
  const width = margin * 2 + cols * cellW + (cols - 1) * gap
  const height = margin * 2 + rows * cellH + (rows - 1) * gap
  const out = makeImage(width, height, options.background ?? [255, 255, 255, 255])
  list.forEach((img, idx) => {
    const col = idx % cols
    const row = Math.floor(idx / cols)
    const fitted = fitInside(img, cellW, cellH)
    const dx = margin + col * (cellW + gap) + Math.round((cellW - fitted.width) / 2)
    const dy = margin + row * (cellH + gap) + Math.round((cellH - fitted.height) / 2)
    pasteImage(out, fitted, { x: 0, y: 0, w: fitted.width, h: fitted.height }, { x: dx, y: dy, w: fitted.width, h: fitted.height })
  })
  return out
}

/** 归一化坐标(0-1)→ 像素矩形;支持越界(由下游裁剪) */
export function normRectToPixels(rect: { x: number; y: number; w: number; h: number }, width: number, height: number): Rect {
  return {
    x: rect.x * width,
    y: rect.y * height,
    w: Math.max(1, rect.w * width),
    h: Math.max(1, rect.h * height)
  }
}

/** 给模型/用户看的矩形描述(像素) */
export function rectText(rect: Rect): string {
  return `[${Math.round(rect.x)}, ${Math.round(rect.y)}, ${Math.round(rect.w)}, ${Math.round(rect.h)}]`
}

// ---------- 抠图 / 背景移除 ----------
//
// 为什么必须有本地抠图:生图模型做不出"保留原像素"的抠图 —— 它只会重画一张,键帽、铭牌、
// 键位都会变(2026-10-21 实测:用户要"把键盘抠出来",模型连出两批共 6 张,每张细节都不一样,
// 19 分钟没结果)。抠图的正确做法是"算出来",不是"画出来":
//   1) 背景干净(纯色/渐变/影棚白底)→ autoCutout 直接从四边做区域生长,零成本、像素级保真;
//   2) 背景复杂(真实照片、有投影、主体与背景同色)→ 让模型只出**黑白剪影蒙版**,
//      再用 cutoutWithMask 把原图像素按蒙版切下来 —— 模型只负责"哪儿是主体",像素仍然来自原图。

/** 边缘羽化/主体连通的公共参数 */
export interface CutoutEdgeOptions {
  /** 边缘羽化半径(px);不填按短边自适应(约 0.15%,最少 1px) */
  featherPx?: number
  /** 铺底色:不填/'transparent' = 透明;支持 #rrggbb / "255,255,255" */
  background?: string | null
  /** 裁到主体包围盒(留 padPercent 边距) */
  trim?: boolean
  /** 裁紧时四周留白(占短边比例,默认 0.02) */
  padPercent?: number
}

export interface AutoCutoutOptions extends CutoutEdgeOptions {
  /** 相邻像素颜色差阈值(三项绝对差之和,默认 30);越大越激进,背景有渐变时可调大 */
  tolerance?: number
  /** 强边缘阈值取梯度分布的分位数(默认 0.9):调低=更多像素当墙(抠得更紧),调高=墙更少(容易漏进主体) */
  edgePercent?: number
  /** 计算蒙版用的最长边(默认 1600):大图先缩小再放大 alpha,省内存也更稳 */
  maskMaxSide?: number
}

export interface CutoutResult {
  image: RgbaImage
  /** 保留下来的前景占比(0-1);过小说明抠坏了(通常是背景与主体同色) */
  coverage: number
  /** 边框一圈颜色的离散程度:小于 18 视为"背景干净" */
  borderSpread: number
  /** 计算蒙版时实际使用的最长边 */
  maskSide: number
  /** 边缘羽化半径(实际生效值) */
  featherPx: number
  /** 是否做了裁紧 */
  trimmed: boolean
}

const lumaOf = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b

/** 只保留最大连通块(主体),其余碎块当背景扔掉;内部空洞由 fillHoles 补回 */
function cleanAlpha(alpha: Uint8Array, w: number, h: number): void {
  const n = w * h
  const label = new Int32Array(n)
  const stack = new Int32Array(n)
  let best = 0
  let bestCount = 0
  let nextId = 0
  for (let i = 0; i < n; i++) {
    if (alpha[i] === 0 || label[i]) continue
    nextId++
    let sp = 0
    stack[sp++] = i
    label[i] = nextId
    let count = 0
    while (sp) {
      const idx = stack[--sp]
      count++
      const x = idx % w
      const y = (idx - x) / w
      if (x > 0 && alpha[idx - 1] && !label[idx - 1]) {
        label[idx - 1] = nextId
        stack[sp++] = idx - 1
      }
      if (x < w - 1 && alpha[idx + 1] && !label[idx + 1]) {
        label[idx + 1] = nextId
        stack[sp++] = idx + 1
      }
      if (y > 0 && alpha[idx - w] && !label[idx - w]) {
        label[idx - w] = nextId
        stack[sp++] = idx - w
      }
      if (y < h - 1 && alpha[idx + w] && !label[idx + w]) {
        label[idx + w] = nextId
        stack[sp++] = idx + w
      }
    }
    if (count > bestCount) {
      bestCount = count
      best = nextId
    }
  }
  if (best === 0) return
  for (let i = 0; i < n; i++) if (alpha[i] && label[i] !== best) alpha[i] = 0
}

/** 把受洞围住的背景补回前景(避免主体内部出现透明孔) */
function fillHoles(alpha: Uint8Array, w: number, h: number): void {
  const n = w * h
  const outside = new Uint8Array(n)
  const stack = new Int32Array(n)
  let sp = 0
  const seed = (i: number): void => {
    if (outside[i] || alpha[i]) return
    outside[i] = 1
    stack[sp++] = i
  }
  for (let x = 0; x < w; x++) {
    seed(x)
    seed((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    seed(y * w)
    seed(y * w + w - 1)
  }
  while (sp) {
    const idx = stack[--sp]
    const x = idx % w
    const y = (idx - x) / w
    if (x > 0) seed(idx - 1)
    if (x < w - 1) seed(idx + 1)
    if (y > 0) seed(idx - w)
    if (y < h - 1) seed(idx + w)
  }
  for (let i = 0; i < n; i++) if (!alpha[i] && !outside[i]) alpha[i] = 255
}

/** 可分离盒式模糊(三遍近似高斯),只在 alpha 上做,边缘自然不锯齿 */
function blurAlpha(alpha: Uint8Array, w: number, h: number, radius: number): void {
  const r = Math.max(1, Math.round(radius))
  if (r < 1) return
  const tmp = new Float32Array(w * h)
  const src = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) src[i] = alpha[i]
  const passH = (input: Float32Array, output: Float32Array): void => {
    for (let y = 0; y < h; y++) {
      const row = y * w
      let sum = 0
      for (let x = -r; x <= r; x++) sum += input[row + Math.min(w - 1, Math.max(0, x))]
      for (let x = 0; x < w; x++) {
        output[row + x] = sum / (2 * r + 1)
        sum -= input[row + Math.min(w - 1, Math.max(0, x - r))] // eslint-disable-line
        sum += input[row + Math.min(w - 1, Math.max(0, x + r + 1))] // eslint-disable-line
      }
    }
  }
  const passV = (input: Float32Array, output: Float32Array): void => {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let y = -r; y <= r; y++) sum += input[Math.min(h - 1, Math.max(0, y)) * w + x]
      for (let y = 0; y < h; y++) {
        output[y * w + x] = sum / (2 * r + 1)
        sum -= input[Math.min(h - 1, Math.max(0, y - r)) * w + x] // eslint-disable-line
        sum += input[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x] // eslint-disable-line
      }
    }
  }
  passH(src, tmp)
  passV(tmp, src)
  for (let i = 0; i < w * h; i++) alpha[i] = clamp255(src[i])
}

/** 双线性放大单通道蒙版(把 maskMaxSide 上的 alpha 铺回原分辨率) */
function upscaleAlpha(alpha: Uint8Array, w: number, h: number, outW: number, outH: number): Uint8Array {
  if (w === outW && h === outH) return alpha
  const out = new Uint8Array(outW * outH)
  for (let y = 0; y < outH; y++) {
    const fy = ((y + 0.5) * h) / outH - 0.5
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)))
    const y1 = Math.min(h - 1, y0 + 1)
    const ty = Math.max(0, Math.min(1, fy - y0))
    for (let x = 0; x < outW; x++) {
      const fx = ((x + 0.5) * w) / outW - 0.5
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)))
      const x1 = Math.min(w - 1, x0 + 1)
      const tx = Math.max(0, Math.min(1, fx - x0))
      const a = alpha[y0 * w + x0] * (1 - tx) + alpha[y0 * w + x1] * tx
      const b = alpha[y1 * w + x0] * (1 - tx) + alpha[y1 * w + x1] * tx
      out[y * outW + x] = Math.round(a * (1 - ty) + b * ty)
    }
  }
  return out
}

/** 把 alpha 写进图片:铺底色(可选)并裁紧(可选) */
function applyAlpha(img: RgbaImage, alpha: Uint8Array, opts: CutoutEdgeOptions): { image: RgbaImage; trimmed: boolean; coverage: number } {
  const bg = opts.background && opts.background !== 'transparent' ? parseColor(opts.background) : null
  const out = cloneImage(img)
  let sum = 0
  for (let i = 0; i < img.width * img.height; i++) {
    const a = alpha[i]
    sum += a
    const o = i * 4
    if (bg) {
      const k = a / 255
      out.data[o] = clamp255(out.data[o] * k + bg[0] * (1 - k))
      out.data[o + 1] = clamp255(out.data[o + 1] * k + bg[1] * (1 - k))
      out.data[o + 2] = clamp255(out.data[o + 2] * k + bg[2] * (1 - k))
      out.data[o + 3] = 255
    } else {
      out.data[o + 3] = clamp255((out.data[o + 3] * a) / 255)
    }
  }
  const coverage = sum / (255 * Math.max(1, img.width * img.height))
  let trimmed = false
  if (opts.trim) {
    // 裁切框必须按 **alpha** 算:铺了底色之后整张图都是不透明的,按像素找包围盒会裁不掉
    let minX = img.width
    let minY = img.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (alpha[y * img.width + x] > 8) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX >= 0) {
      const pad = Math.round(Math.min(img.width, img.height) * clamp01(opts.padPercent ?? 0.02))
      const x = Math.max(0, minX - pad)
      const y = Math.max(0, minY - pad)
      const w = Math.min(img.width - x, maxX - minX + 1 + pad * 2)
      const h = Math.min(img.height - y, maxY - minY + 1 + pad * 2)
      return { image: cropImage(out, { x, y, w, h }), trimmed: true, coverage }
    }
  }
  return { image: out, trimmed, coverage }
}

/**
 * 自动抠图 = 梯度墙 + 区域生长:
 *   1) 灰度 Sobel 求出强边缘当"墙"(主体轮廓、桌面折边、纸张边);
 *   2) 从四边泛洪,既不穿墙,也不跨过颜色突变 —— 背景的柔和投影(梯度低)会被吃掉,
 *      主体的硬轮廓(梯度高)会挡住泛洪;
 *   3) 前景 = 没被泛洪到的像素,只留最大连通块,再把紧贴主体的墙像素补回来(避免细一圈);
 *   4) 填洞(键帽缝隙等内部空洞重新变实心)+ 羽化。
 *
 * 为什么不用"全局背景色模型":2026-10-21 实测,白色键盘的暗部与深灰垫子的高光同色,
 * 按颜色聚类分不开(会把按键当背景吃掉);而梯度是局部信息,不受这种同色干扰。
 * 背景杂、有投影、主体与背景同色的情况也能用;实在不行再走 cutoutWithMask(模型只出剪影)。
 */
export function autoCutout(img: RgbaImage, opts: AutoCutoutOptions = {}): CutoutResult {
  const tolerance = Math.max(4, Math.min(120, opts.tolerance ?? 30))
  const maskMaxSide = Math.max(256, Math.min(4096, opts.maskMaxSide ?? 1600))
  const edgePercent = Math.min(0.99, Math.max(0.5, opts.edgePercent ?? 0.9))
  const smallest = Math.min(img.width, img.height)
  const scale = Math.min(1, maskMaxSide / Math.max(img.width, img.height))
  const mw = Math.max(16, Math.round(img.width * scale))
  const mh = Math.max(16, Math.round(img.height * scale))
  const small = mw === img.width && mh === img.height ? cloneImage(img) : scaleImage(img, mw, mh)
  const n = mw * mh
  const d = small.data

  // 1) 灰度 + 3×3 平滑 + Sobel 梯度
  const gray = new Float32Array(n)
  for (let i = 0; i < n; i++) gray[i] = lumaOf(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
  const smooth = new Float32Array(n)
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      let sum = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(mh - 1, Math.max(0, y + dy)) * mw
        for (let dx = -1; dx <= 1; dx++) sum += gray[yy + Math.min(mw - 1, Math.max(0, x + dx))]
      }
      smooth[y * mw + x] = sum / 9
    }
  }
  const gAt = (x: number, y: number): number => smooth[Math.min(mh - 1, Math.max(0, y)) * mw + Math.min(mw - 1, Math.max(0, x))]
  const grad = new Float32Array(n)
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const gx = gAt(x + 1, y - 1) + 2 * gAt(x + 1, y) + gAt(x + 1, y + 1) - gAt(x - 1, y - 1) - 2 * gAt(x - 1, y) - gAt(x - 1, y + 1)
      const gy = gAt(x - 1, y + 1) + 2 * gAt(x, y + 1) + gAt(x + 1, y + 1) - gAt(x - 1, y - 1) - 2 * gAt(x, y - 1) - gAt(x + 1, y - 1)
      grad[y * mw + x] = Math.sqrt(gx * gx + gy * gy) / 4
    }
  }
  // 阈值取分位数,但保底 8:纯色背景整张图的梯度≈0,不能"分位数"把半个画面当墙
  const sorted = Float32Array.from(grad).sort()
  const wallThreshold = Math.max(8, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * edgePercent))] ?? 8)
  const wall = new Uint8Array(n)
  for (let i = 0; i < n; i++) wall[i] = grad[i] >= wallThreshold ? 1 : 0

  // 2) 区域生长(BFS):不穿墙 + 相邻像素色差 ≤ 容差
  const isBg = new Uint8Array(n)
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0
  const push = (i: number): void => {
    if (isBg[i] || wall[i]) return
    isBg[i] = 1
    queue[qt++] = i
  }
  for (let x = 0; x < mw; x++) {
    push(x)
    push((mh - 1) * mw + x)
  }
  for (let y = 0; y < mh; y++) {
    push(y * mw)
    push(y * mw + mw - 1)
  }
  const diffAt = (i: number, j: number): number =>
    Math.abs(d[i * 4] - d[j * 4]) + Math.abs(d[i * 4 + 1] - d[j * 4 + 1]) + Math.abs(d[i * 4 + 2] - d[j * 4 + 2])
  while (qh < qt) {
    const idx = queue[qh++]
    const x = idx % mw
    const y = (idx - x) / mw
    if (x > 0 && !isBg[idx - 1] && !wall[idx - 1] && diffAt(idx, idx - 1) <= tolerance) push(idx - 1)
    if (x < mw - 1 && !isBg[idx + 1] && !wall[idx + 1] && diffAt(idx, idx + 1) <= tolerance) push(idx + 1)
    if (y > 0 && !isBg[idx - mw] && !wall[idx - mw] && diffAt(idx, idx - mw) <= tolerance) push(idx - mw)
    if (y < mh - 1 && !isBg[idx + mw] && !wall[idx + mw] && diffAt(idx, idx + mw) <= tolerance) push(idx + mw)
  }

  // 3) 前景 = 既没被泛洪也不是墙 → 只留最大连通块
  const core = new Uint8Array(n)
  for (let i = 0; i < n; i++) core[i] = !isBg[i] && !wall[i] ? 255 : 0
  cleanAlpha(core, mw, mh)

  // 4) 边缘回补:向"没被泛洪到"的方向膨胀 2px,把主体轮廓上的墙像素带回来(否则边缘会细一圈)
  let grown = core
  for (let pass = 0; pass < 2; pass++) {
    const out = new Uint8Array(n)
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const i = y * mw + x
        if (grown[i]) {
          out[i] = 255
          continue
        }
        if (isBg[i]) continue
        const up = y > 0 && grown[i - mw]
        const down = y < mh - 1 && grown[i + mw]
        const left = x > 0 && grown[i - 1]
        const right = x < mw - 1 && grown[i + 1]
        out[i] = up || down || left || right ? 255 : 0
      }
    }
    grown = out
  }

  // 5) 填洞 + 统计
  fillHoles(grown, mw, mh)
  const alpha = grown

  let borderN = 0
  let borderSum = 0
  let borderSumSq = 0
  const addBorder = (i: number): void => {
    const l = lumaOf(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
    borderN++
    borderSum += l
    borderSumSq += l * l
  }
  const band = Math.max(1, Math.round(Math.min(mw, mh) * 0.01))
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      if (x < band || y < band || x >= mw - band || y >= mh - band) addBorder(y * mw + x)
    }
  const borderMean = borderSum / Math.max(1, borderN)
  const borderSpread = Math.sqrt(Math.max(0, borderSumSq / Math.max(1, borderN) - borderMean * borderMean))

  // 6) alpha 放大到原尺寸 + 羽化 + 铺底/裁紧
  const full = upscaleAlpha(alpha, mw, mh, img.width, img.height)
  const feather = Math.max(0, Math.round(opts.featherPx ?? Math.max(1, Math.round(smallest * 0.0015))))
  if (feather > 0) blurAlpha(full, img.width, img.height, feather)
  const applied = applyAlpha(img, full, opts)
  return {
    image: applied.image,
    coverage: applied.coverage,
    borderSpread,
    maskSide: Math.max(mw, mh),
    featherPx: feather,
    trimmed: applied.trimmed
  }
}

export interface CutoutMaskOptions extends CutoutEdgeOptions {
  /** 蒙版反了(白=背景/黑=主体)时置 true;默认约定「白/亮 = 保留」 */
  invertMask?: boolean
}

/**
 * 用一张黑白蒙版把原图切下来(白/亮=保留,黑=去掉;反了就传 invertMask:true)。
 * 这是"像素级抠图"的正路:蒙版可以由生图模型只画剪影(它做剪影比画键盘可靠得多),
 * 但**最终像素全部来自原图**,不存在重绘。
 */
export function cutoutWithMask(img: RgbaImage, mask: RgbaImage, opts: CutoutMaskOptions = {}): CutoutResult {
  const mw = mask.width
  const mh = mask.height
  const n = mw * mh
  const luma = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const a = mask.data[o + 3] / 255
    // 透明区域当成"不要"(常见于 PNG 蒙版)
    luma[i] = clamp255(lumaOf(mask.data[o], mask.data[o + 1], mask.data[o + 2]) * a)
  }
  const invert = opts.invertMask === true
  const alpha = new Uint8Array(n)
  for (let i = 0; i < n; i++) alpha[i] = invert ? 255 - luma[i] : luma[i]
  cleanAlpha(alpha, mw, mh)
  fillHoles(alpha, mw, mh)
  let full = upscaleAlpha(alpha, mw, mh, img.width, img.height)
  const smallest = Math.min(img.width, img.height)
  const feather = Math.max(0, Math.round(opts.featherPx ?? Math.max(1, Math.round(smallest * 0.0015))))
  if (feather > 0) blurAlpha(full, img.width, img.height, feather)
  const applied = applyAlpha(img, full, { ...opts })
  return { image: applied.image, coverage: applied.coverage, borderSpread: 0, maskSide: Math.max(mw, mh), featherPx: feather, trimmed: applied.trimmed }
}
