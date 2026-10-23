// 保真改图(画布护栏)
//
// 解决的问题:模型"改 A 点、顺手把 B 点也改了",而且改完没人量化到底改了多少。
// 做法只有一句话 —— **允许改动的区域由我们指定,区域外逐像素取原图**,模型输出只是"区域内的一块补丁"。
//
// 三个能力:
//   1. applyEditGuard   把模型结果按蒙版/矩形合成回原图,区域外 0 改动;并给出量化报告
//   2. compareWithBaseline 任意两图逐像素比对:区域外改了多少、区域内边界还能不能对上原图(重绘/位移检测)
//   3. paintRegion      确定性局部换色(不重绘):"把键帽改成主体色"这类只改颜色、不能改形状的活用它
//
// 这里全部是纯函数,不依赖 electron,可单测。

import { parseColor, scaleImage, type Rgba, type RgbaImage } from './composite'

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** sRGB(0-255)→ 线性光(0-1) */
const srgbToLinear = (v: number): number => {
  const c = clamp01(v / 255)
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** 线性光(0-1)→ sRGB(0-255) */
const linearToSrgb = (v: number): number => {
  const c = clamp01(v)
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return s * 255
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / Math.max(1e-6, e1 - e0))
  return t * t * (3 - 2 * t)
}

/** 归一化矩形(0-1,相对整张图) */
export interface GuardRect {
  x: number
  y: number
  w: number
  h: number
}

/** user = 应用里的涂抹蒙版约定(透明=待改);image = 普通图,白/亮=可改 */
export type MaskKind = 'user' | 'image'

/** 自动护栏参数:不给选取也能"只留成片改动、还原零散噪点" */
export interface AutoGuardOptions {
  /** 判定"这个像素变了"的通道差阈值(0-255),默认 6 */
  threshold?: number
  /** 保留的最小连通块面积(占全图比例),默认 0.0004 */
  minIslandShare?: number
  /** 保留区向外扩张(占图宽比例,默认 0.008):把改动的软边、贴邻的阴影一起留下 */
  growShare?: number
  /** 羽化半径(分析分辨率像素),默认 2 */
  featherPx?: number
}

export interface AutoGuardStats {
  /** 模型改动被切成的连通块总数 */
  islands: number
  /** 其中被判成"成片改动"、保留的块数 */
  kept: number
  /** 保留区域占全图比例 */
  keptCoverage: number
  /** 被还原的改动占"模型原本改动"的比例 */
  revertedShare: number
  minIslandShare: number
  growShare: number
}

export interface GuardOptions {
  /** 只允许改这块矩形(0-1) */
  region?: GuardRect
  /** 只允许改蒙版覆盖的地方 */
  mask?: RgbaImage
  maskKind?: MaskKind
  invertMask?: boolean
  /** 羽化半径(像素,按原图尺寸) */
  featherPx?: number
  /** 边界锚定率低于它判"可疑",默认 0.72 */
  minAnchor?: number
  /**
   * 自动护栏:既没给 region 也没给 mask 时,把模型改动里"成片"的部分留下、
   * 零散噪点还原。换材质/换色本来就是一大片,桌面纹理那种逐像素噪点不成片。
   */
  auto?: boolean | AutoGuardOptions
  /** 报告里标注基线资产 */
  baselineAssetId?: string
}

export interface ChangedRegion {
  x: number
  y: number
  w: number
  h: number
  /** 占整图面积比例 */
  share: number
}

export interface EditGuardReport {
  baselineAssetId?: string
  /** 允许改动区域占全图比例 */
  allowedCoverage: number
  /** 允许区域内"确实变了"的比例 */
  insideChangedRatio: number
  /** 合成前,模型在允许区域外改掉的像素占比(诊断用) */
  modelOutsideChangedRatio: number
  /** 合成后,交付图在允许区域外改掉的像素占比(应为 0) */
  deliveredOutsideChangedRatio: number
  /**
   * 边界锚定率:区域内"模型新画出来的边界"有多少能在原图上找到依托(±2px)。
   * 换色/位移很小 → 接近 1;整块重绘/键位乱掉 → 明显偏低。null = 区域内边界太少,判不了。
   */
  edgeAnchor: number | null
  /** 区域内原图边界被保留的比例(换色把对比改没了会降低,只作参考) */
  originalEdgeCoverage: number | null
  /** 区域内新边界占模型输出边界的比例 */
  newEdgeRatio: number
  sizeMatched: boolean
  /** 区域外改动聚集处(最多 3 块) */
  outsideRegions: ChangedRegion[]
  /** 自动护栏统计(仅 auto 模式有) */
  autoGuard?: AutoGuardStats
  verdict: 'ok' | 'suspect'
  note: string
}

export interface LocalPaintReport {
  /** 实际被改写的像素数 */
  painted: number
  /** 占全图比例 */
  coverage: number
  target: [number, number, number]
  /** 改完后该区域的平均色 */
  mean: [number, number, number]
  /** 与目标色的加权差(0-255,越小越准) */
  meanDelta: number
  sourceMean: [number, number, number]
  /** 换色模式:shade=明暗染色(旧);albedo=反照率换色(保留原高光) */
  mode: PaintMode
  /** albedo 模式估计出的白点(线性 0-1),用来把"白键帽"归一化 */
  whitePoint?: [number, number, number]
  /** 原图最亮 2% 的像素里,换色后亮度仍保留 ≥80% 的比例(越高越像"同一材质换色") */
  highlightRetention?: number
}

// ---------- 基础工具 ----------

interface Scaled {
  image: RgbaImage
  /** 分析图相对原图的比例 */
  sx: number
  sy: number
}

/** 分析用的降采样副本(长边 ≤ maxSide),避免 4K 图上的逐像素统计太慢 */
function analysisImage(img: RgbaImage, maxSide = 1600): Scaled {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
  if (scale >= 0.999) return { image: img, sx: 1, sy: 1 }
  return {
    image: scaleImage(img, Math.round(img.width * scale), Math.round(img.height * scale)),
    sx: 1,
    sy: 1
  }
}

/** 可分离盒式模糊(Float32,0..255;边缘钳制) */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius))
  if (r <= 0) return src.slice()
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const win = r * 2 + 1
  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / win
      const addX = Math.min(w - 1, x + r + 1)
      const subX = Math.max(0, x - r)
      sum += src[y * w + addX] - src[y * w + subX]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win
      const addY = Math.min(h - 1, y + r + 1)
      const subY = Math.max(0, y - r)
      sum += tmp[addY * w + x] - tmp[subY * w + x]
    }
  }
  return out
}

/** 可分离最大值滤波(把蒙版向外扩张 r 像素;用于把键帽侧壁一起包进选区) */
function dilateMask(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius))
  if (r <= 0) return src
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let k = -r; k <= r; k++) {
        const s = src[y * w + Math.min(w - 1, Math.max(0, x + k))]
        if (s > v) v = s
      }
      tmp[y * w + x] = v
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let k = -r; k <= r; k++) {
        const s = tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
        if (s > v) v = s
      }
      out[y * w + x] = v
    }
  }
  return out
}

/** 矩形掩码(0..1),边界 1px 抗锯齿 */
function rectMask(w: number, h: number, rect: GuardRect): Float32Array {
  const m = new Float32Array(w * h)
  const x0 = Math.max(0, Math.floor(rect.x * w))
  const y0 = Math.max(0, Math.floor(rect.y * h))
  const x1 = Math.min(w, Math.ceil((rect.x + rect.w) * w))
  const y1 = Math.min(h, Math.ceil((rect.y + rect.h) * h))
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 255
  return m
}

function intersectMask(dst: Float32Array, src: Float32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = (dst[i] * src[i]) / 255
}

function invertMask(m: Float32Array): void {
  for (let i = 0; i < m.length; i++) m[i] = 255 - m[i]
}

/** 按 GuardOptions 生成允许改动的掩码(分辨率 = 传进来的 w×h 分析图) */
function buildAllowedMask(w: number, h: number, opts: GuardOptions, featherPx = 0): Float32Array {
  const hard = opts.region ? rectMask(w, h, opts.region) : null
  let mask: Float32Array = hard ?? new Float32Array(w * h).fill(255)

  if (opts.mask) {
    const scaled = scaleImage(opts.mask, w, h)
    const kind = opts.maskKind ?? 'image'
    const inv = opts.invertMask === true
    for (let i = 0; i < w * h; i++) {
      const a = scaled.data[i * 4 + 3] / 255
      // user:透明=可改;image:亮/白=可改(用亮度,兼容白底黑主体的剪影蒙版)
      let v = kind === 'user' ? 1 - a : luma(scaled.data[i * 4], scaled.data[i * 4 + 1], scaled.data[i * 4 + 2]) / 255
      if (inv) v = 1 - v
      mask[i] *= v
    }
  }
  if (featherPx > 0) {
    mask = boxBlur(mask, w, h, featherPx)
    // 羽化只向内淡出:矩形外仍保持 0,保证"允许区域外逐像素来自原图"
    if (hard) for (let i = 0; i < w * h; i++) mask[i] *= hard[i] > 0 ? 1 : 0
  }
  return mask
}

/**
 * 自动护栏:不需要用户/模型给选区。
 * 把"模型改了哪里"做成图,再按连通块切:成片的改动(换色、换材质、整块重画)留下,
 * 零散到不成片的逐像素噪点(桌面纹理、压缩噪点、背景抖动)还原成原图。
 */
function buildAutoGuardMask(
  baseline: RgbaImage,
  edited: RgbaImage,
  opts: AutoGuardOptions = {}
): { mask: RgbaImage; stats: AutoGuardStats } {
  const w = baseline.width
  const h = baseline.height
  const n = w * h
  const threshold = Math.max(1, opts.threshold ?? 6)
  const minIslandShare = Math.max(0, opts.minIslandShare ?? 0.0004)
  const growShare = Math.max(0, opts.growShare ?? 0.008)
  const feather = Math.max(0, opts.featherPx ?? 2)
  const changed = new Uint8Array(n)
  let changedCount = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const d = Math.max(
      Math.abs(baseline.data[o] - edited.data[o]),
      Math.abs(baseline.data[o + 1] - edited.data[o + 1]),
      Math.abs(baseline.data[o + 2] - edited.data[o + 2])
    )
    if (d > threshold) {
      changed[i] = 1
      changedCount++
    }
  }
  const minArea = Math.max(16, Math.round(minIslandShare * n))
  const label = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  const areas: number[] = [0]
  let islands = 0
  for (let start = 0; start < n; start++) {
    if (!changed[start] || label[start] !== -1) continue
    islands++
    label[start] = islands
    let top = 0
    stack[top++] = start
    let area = 0
    while (top > 0) {
      const idx = stack[--top]
      area++
      const x = idx % w
      const y = (idx - x) / w
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        const row = ny * w
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const nb = row + nx
          if (!changed[nb] || label[nb] !== -1) continue
          label[nb] = islands
          stack[top++] = nb
        }
      }
    }
    areas.push(area)
  }
  const keep = new Float32Array(n)
  let kept = 0
  let keptPixels = 0
  for (let lb = 1; lb <= islands; lb++) if (areas[lb] >= minArea) kept++
  for (let i = 0; i < n; i++) {
    const lb = label[i]
    if (lb > 0 && areas[lb] >= minArea) {
      keep[i] = 255
      keptPixels++
    }
  }
  const grown = dilateMask(keep, w, h, Math.round(growShare * w))
  const soft = feather > 0 ? boxBlur(grown, w, h, feather) : grown
  const mask: RgbaImage = { width: w, height: h, data: new Uint8Array(n * 4) }
  let coverage = 0
  for (let i = 0; i < n; i++) {
    const v = clamp255(soft[i])
    const o = i * 4
    mask.data[o] = v
    mask.data[o + 1] = v
    mask.data[o + 2] = v
    mask.data[o + 3] = 255
    if (v >= 128) coverage++
  }
  return {
    mask,
    stats: {
      islands,
      kept,
      keptCoverage: coverage / n,
      revertedShare: changedCount ? Math.max(0, 1 - keptPixels / changedCount) : 0,
      minIslandShare,
      growShare
    }
  }
}

function maskStats(mask: Float32Array, w: number, h: number): number {
  let sum = 0
  for (let i = 0; i < w * h; i++) sum += mask[i] / 255
  return sum / (w * h)
}

interface EdgeMap {
  mag: Float32Array
  edge: Uint8Array
  w: number
  h: number
}

function edgeMap(img: RgbaImage, threshold = 28): EdgeMap {
  const { width: w, height: h, data } = img
  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    gray[i] = (luma(data[o], data[o + 1], data[o + 2]) * data[o + 3]) / 255
  }
  const mag = new Float32Array(w * h)
  const edge = new Uint8Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const tl = gray[i - w - 1]
      const t = gray[i - w]
      const tr = gray[i - w + 1]
      const l = gray[i - 1]
      const r = gray[i + 1]
      const bl = gray[i + w - 1]
      const b = gray[i + w]
      const br = gray[i + w + 1]
      const gx = tr + 2 * r + br - tl - 2 * l - bl
      const gy = bl + 2 * b + br - tl - 2 * t - tr
      const m = Math.sqrt(gx * gx + gy * gy) / 4
      mag[i] = m
      if (m >= threshold) edge[i] = 1
    }
  }
  return { mag, edge, w, h }
}

/** 可分离最大值滤波(给边界图做容差膨胀,±r 像素) */
function dilateEdge(edge: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  const r = Math.max(0, Math.round(radius))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let k = -r; k <= r && !v; k++) v = edge[y * w + Math.min(w - 1, Math.max(0, x + k))]
      tmp[y * w + x] = v
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let k = -r; k <= r && !v; k++) v = tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
      out[y * w + x] = v
    }
  }
  return out
}

interface EdgeAgreement {
  anchor: number | null
  coverage: number | null
  newRatio: number
  targetEdges: number
  originalEdges: number
}

function edgeAgreement(base: EdgeMap, target: EdgeMap, mask: Float32Array): EdgeAgreement {
  const dilate = 1 // ±2px 容差(半径 1 的 5×5 近似;先横向再纵向=±2)
  const nearBase = dilateEdge(base.edge, base.w, base.h, dilate)
  const nearTarget = dilateEdge(target.edge, target.w, target.h, dilate)
  let targetEdges = 0
  let matched = 0
  let originalEdges = 0
  let kept = 0
  for (let i = 0; i < base.w * base.h; i++) {
    if (mask[i] < 128) continue
    if (target.edge[i]) {
      targetEdges++
      if (nearBase[i]) matched++
    }
    if (base.edge[i]) {
      originalEdges++
      if (nearTarget[i]) kept++
    }
  }
  return {
    anchor: targetEdges >= 60 ? matched / targetEdges : null,
    coverage: originalEdges >= 60 ? kept / originalEdges : null,
    newRatio: targetEdges > 0 ? 1 - matched / targetEdges : 0,
    targetEdges,
    originalEdges
  }
}

function resizeTo(img: RgbaImage, w: number, h: number): { image: RgbaImage; matched: boolean } {
  if (img.width === w && img.height === h) return { image: img, matched: true }
  return { image: scaleImage(img, w, h), matched: false }
}

function toRgba(r: number, g: number, b: number): [number, number, number] {
  return [Math.round(r), Math.round(g), Math.round(b)]
}

/** 区域外改动聚集处:粗粒度连通域(降采样 2×2 加速),按面积取前 3 */
function changedIslands(changed: Uint8Array, w: number, h: number, maxBoxes = 3): ChangedRegion[] {
  const step = 2
  const cw = Math.ceil(w / step)
  const ch = Math.ceil(h / step)
  const small = new Uint8Array(cw * ch)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (changed[y * w + x]) small[(y / step | 0) * cw + (x / step | 0)] = 1
    }
  }
  const seen = new Uint8Array(cw * ch)
  const boxes: ChangedRegion[] = []
  const stack: number[] = []
  for (let sy = 0; sy < ch; sy++) {
    for (let sx = 0; sx < cw; sx++) {
      const start = sy * cw + sx
      if (!small[start] || seen[start]) continue
      seen[start] = 1
      stack.length = 0
      stack.push(start)
      let minX = sx
      let maxX = sx
      let minY = sy
      let maxY = sy
      let count = 0
      while (stack.length) {
        const cur = stack.pop() as number
        const cx = cur % cw
        const cy = (cur / cw) | 0
        count++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        if (cx > 0 && small[cur - 1] && !seen[cur - 1]) {
          seen[cur - 1] = 1
          stack.push(cur - 1)
        }
        if (cx < cw - 1 && small[cur + 1] && !seen[cur + 1]) {
          seen[cur + 1] = 1
          stack.push(cur + 1)
        }
        if (cy > 0 && small[cur - cw] && !seen[cur - cw]) {
          seen[cur - cw] = 1
          stack.push(cur - cw)
        }
        if (cy < ch - 1 && small[cur + cw] && !seen[cur + cw]) {
          seen[cur + cw] = 1
          stack.push(cur + cw)
        }
      }
      const share = (count * step * step) / (w * h)
      if (share < 0.0008) continue
      boxes.push({
        x: minX / cw,
        y: minY / ch,
        w: (maxX - minX + 1) / cw,
        h: (maxY - minY + 1) / ch,
        share
      })
    }
  }
  boxes.sort((a, b) => b.share - a.share)
  return boxes.slice(0, maxBoxes)
}

function noteOf(report: Omit<EditGuardReport, 'note'>): string {
  const parts: string[] = []
  parts.push(`允许区域占 ${(report.allowedCoverage * 100).toFixed(1)}%`)
  if (report.insideChangedRatio < 0.002) parts.push('区域内几乎没变化(模型可能没听指令)')
  else parts.push(`区域内改动 ${(report.insideChangedRatio * 100).toFixed(1)}%`)
  if (report.autoGuard) {
    const g = report.autoGuard
    parts.push(`自动护栏:把改动切成 ${g.islands} 块,留下 ${g.kept} 块成片改动(占 ${(g.keptCoverage * 100).toFixed(1)}%)`)
    parts.push(`还原零散噪点 ${(g.revertedShare * 100).toFixed(1)}%(桌面纹理/压缩噪点这类逐像素抖动)`)
  } else {
    parts.push(
      report.modelOutsideChangedRatio > 0.0005
        ? `区域外模型原本动了 ${(report.modelOutsideChangedRatio * 100).toFixed(2)}%(已用原图像素还原)`
        : '区域外模型没动'
    )
  }
  if (report.edgeAnchor !== null) parts.push(`边界锚定 ${report.edgeAnchor.toFixed(2)}`)
  if (report.verdict === 'suspect') {
    if (report.autoGuard && report.autoGuard.keptCoverage < 0.002) {
      parts.push('自动护栏一块成片改动都没留下(模型可能只做了逐像素抖动)')
    } else {
      parts.push(
        report.modelOutsideChangedRatio > 0.005
          ? '模型改到了不该改的地方'
          : '区域内出现大量原图没有的新边界,疑似重绘/位移'
      )
    }
  }
  return parts.join('；')
}

// ---------- 1. 把模型结果合成回原图 ----------

export function applyEditGuard(
  baseline: RgbaImage,
  edited: RgbaImage,
  opts: GuardOptions = {}
): { image: RgbaImage; report: EditGuardReport } {
  const { image: fit, matched } = resizeTo(edited, baseline.width, baseline.height)
  const baseA = analysisImage(baseline)
  const editA = analysisImage(fit)
  // 自动护栏:没给 region/mask 时,用"模型实际改了哪里"反推允许区域(只留成片改动)
  const auto =
    opts.auto && !opts.region && !opts.mask
      ? buildAutoGuardMask(baseA.image, editA.image, typeof opts.auto === 'object' ? opts.auto : {})
      : null
  const guardOpts: GuardOptions = auto
    ? { ...opts, mask: auto.mask, maskKind: 'image', invertMask: false }
    : opts
  const scale = Math.max(baseline.width, baseline.height) / 1600
  const featherPx = (guardOpts.featherPx ?? 0) / Math.max(0.0001, scale)
  const mask = buildAllowedMask(baseline.width, baseline.height, guardOpts, featherPx)
  const out: RgbaImage = {
    width: baseline.width,
    height: baseline.height,
    data: new Uint8Array(baseline.width * baseline.height * 4)
  }
  let deliveredOutside = 0
  for (let i = 0; i < baseline.width * baseline.height; i++) {
    const o = i * 4
    const a = mask[i] / 255
    if (a <= 0.0001) {
      out.data[o] = baseline.data[o]
      out.data[o + 1] = baseline.data[o + 1]
      out.data[o + 2] = baseline.data[o + 2]
      out.data[o + 3] = baseline.data[o + 3]
      if (
        out.data[o] !== baseline.data[o] ||
        out.data[o + 1] !== baseline.data[o + 1] ||
        out.data[o + 2] !== baseline.data[o + 2]
      )
        deliveredOutside++
      continue
    }
    out.data[o] = clamp255(baseline.data[o] * (1 - a) + fit.data[o] * a)
    out.data[o + 1] = clamp255(baseline.data[o + 1] * (1 - a) + fit.data[o + 1] * a)
    out.data[o + 2] = clamp255(baseline.data[o + 2] * (1 - a) + fit.data[o + 2] * a)
    out.data[o + 3] = clamp255(baseline.data[o + 3] * (1 - a) + fit.data[o + 3] * a)
  }

  const maskA = buildAllowedMask(
    baseA.image.width,
    baseA.image.height,
    guardOpts,
    (guardOpts.featherPx ?? 0) * Math.min(baseA.image.width / baseline.width, baseA.image.height / baseline.height)
  )
  const bw = baseA.image.width
  const bh = baseA.image.height
  const baseEdges = edgeMap(baseA.image)
  const editEdges = edgeMap(editA.image)
  const agreement = edgeAgreement(baseEdges, editEdges, maskA)
  let insideChanged = 0
  let insideTotal = 0
  let modelOutside = 0
  const outsideMap = new Uint8Array(bw * bh)
  for (let i = 0; i < bw * bh; i++) {
    const o = i * 4
    const d = Math.max(
      Math.abs(baseA.image.data[o] - editA.image.data[o]),
      Math.abs(baseA.image.data[o + 1] - editA.image.data[o + 1]),
      Math.abs(baseA.image.data[o + 2] - editA.image.data[o + 2])
    )
    const changed = d > 8
    const allowed = maskA[i] >= 128
    if (allowed) {
      insideTotal++
      if (changed) insideChanged++
    } else if (changed) {
      modelOutside++
      outsideMap[i] = 1
    }
  }
  const reportBase = {
    ...(opts.baselineAssetId ? { baselineAssetId: opts.baselineAssetId } : {}),
    allowedCoverage: maskStats(maskA, bw, bh),
    insideChangedRatio: insideTotal ? insideChanged / insideTotal : 0,
    modelOutsideChangedRatio: modelOutside / (bw * bh),
    deliveredOutsideChangedRatio: deliveredOutside / (baseline.width * baseline.height),
    edgeAnchor: agreement.anchor,
    originalEdgeCoverage: agreement.coverage,
    newEdgeRatio: agreement.newRatio,
    sizeMatched: matched,
    outsideRegions: changedIslands(outsideMap, bw, bh),
    ...(auto ? { autoGuard: auto.stats } : {}),
    verdict: 'ok' as const
  }
  // 合成后区域外必然是原图;判可疑只看"区域内是否被整块重绘"(锚定率极低)。
  // 模型在区域外动过什么,记在 report 里给用户看,但已经被护栏还原,不算这次交付的缺陷。
  // 自动护栏模式下,允许区域本身就是从"改哪儿"反推出来的,锚定率没有判据意义,只看留下了多少。
  const severeRedraw =
    !auto && agreement.anchor !== null && agreement.anchor < (opts.minAnchor ?? 0.72) * 0.75
  const autoEmpty = Boolean(auto) && (auto?.stats.keptCoverage ?? 0) < 0.002
  const suspect = deliveredOutside > 0 || severeRedraw || autoEmpty
  const report: EditGuardReport = {
    ...reportBase,
    verdict: suspect ? 'suspect' : 'ok',
    note: ''
  }
  report.note = noteOf(report)
  return { image: out, report }
}

// ---------- 2. 跟原图逐像素比对 ----------

export interface CompareResult {
  report: EditGuardReport
  heatmap?: RgbaImage
}

export function compareWithBaseline(
  baseline: RgbaImage,
  target: RgbaImage,
  opts: GuardOptions & { heatmap?: boolean } = {}
): CompareResult {
  const { image: fit, matched } = resizeTo(target, baseline.width, baseline.height)
  const scaleBase = baseline.width / 1600
  const baseA = scaleBase > 1 ? scaleImage(baseline, Math.round(baseline.width / scaleBase), Math.round(baseline.height / scaleBase)) : baseline
  const fitA = scaleBase > 1 ? scaleImage(fit, Math.round(fit.width / scaleBase), Math.round(fit.height / scaleBase)) : fit
  const bw = baseA.width
  const bh = baseA.height
  const feather = (opts.featherPx ?? 0) / Math.max(0.0001, scaleBase)
  const mask = buildAllowedMask(bw, bh, opts, feather)
  const changed = new Uint8Array(bw * bh)
  const outsideMap = new Uint8Array(bw * bh)
  let insideChanged = 0
  let insideTotal = 0
  let outside = 0
  for (let i = 0; i < bw * bh; i++) {
    const o = i * 4
    const allowed = mask[i] >= 128
    if (allowed) insideTotal++
    const d = Math.max(
      Math.abs(baseA.data[o] - fitA.data[o]),
      Math.abs(baseA.data[o + 1] - fitA.data[o + 1]),
      Math.abs(baseA.data[o + 2] - fitA.data[o + 2])
    )
    if (d > 8) {
      changed[i] = 1
      if (allowed) insideChanged++
      else {
        outside++
        outsideMap[i] = 1
      }
    }
  }
  const allowedCoverage = maskStats(mask, bw, bh)
  const baseEdges = edgeMap(baseA)
  const targetEdges = edgeMap(fitA)
  const agreement = edgeAgreement(baseEdges, targetEdges, mask)
  const islands = changedIslands(outsideMap, bw, bh)
  const outsideRatio = outside / (bw * bh)
  const reportBase = {
    ...(opts.baselineAssetId ? { baselineAssetId: opts.baselineAssetId } : {}),
    allowedCoverage,
    insideChangedRatio: insideTotal ? insideChanged / insideTotal : 0,
    modelOutsideChangedRatio: outsideRatio,
    deliveredOutsideChangedRatio: outsideRatio,
    edgeAnchor: agreement.anchor,
    originalEdgeCoverage: agreement.coverage,
    newEdgeRatio: agreement.newRatio,
    sizeMatched: matched,
    outsideRegions: islands,
    verdict: 'ok' as const
  }
  const suspect =
    outsideRatio > 0.01 ||
    (islands[0]?.share ?? 0) > 0.003 ||
    (agreement.anchor !== null && agreement.anchor < (opts.minAnchor ?? 0.72))
  const report: EditGuardReport = { ...reportBase, verdict: suspect ? 'suspect' : 'ok', note: '' }
  report.note = noteOf(report)

  let heatmap: RgbaImage | undefined
  if (opts.heatmap) {
    heatmap = { width: bw, height: bh, data: new Uint8Array(bw * bh * 4) }
    for (let i = 0; i < bw * bh; i++) {
      const o = i * 4
      const g = luma(baseA.data[o], baseA.data[o + 1], baseA.data[o + 2]) * 0.34
      let r = g
      let gg = g
      let b = g
      if (changed[i]) {
        if (mask[i] >= 128) {
          r = 255
          gg = 54
          b = 48
        } else {
          r = 255
          gg = 214
          b = 0
        }
      }
      heatmap.data[o] = clamp255(r)
      heatmap.data[o + 1] = clamp255(gg)
      heatmap.data[o + 2] = clamp255(b)
      heatmap.data[o + 3] = 255
    }
  }
  return heatmap ? { report, heatmap } : { report }
}

// ---------- 3. 确定性局部换色(不重绘) ----------

/**
 * shade  = 按原明暗比例染色(旧行为:保留白塑料的高光结构,深色时会像涂层)
 * albedo = 反照率换色:把"白色塑料的漫反射"换成目标色,原图高光尽量保留
 */
export type PaintMode = 'shade' | 'albedo'

export interface PaintOptions {
  /** 换色模式,默认 shade(兼容旧行为);工具层默认 albedo */
  mode?: PaintMode
  /** albedo 模式:高光保留强度 0-1,默认 0(哑光);亮面/金属再调高(1=高光完全不染) */
  highlightProtect?: number
  /** albedo 模式:暗部提亮 0-1,默认 0(黑塑料暗部太死时可加一点环境光) */
  shadowLift?: number
  /** 目标色(#rrggbb / rgb());与 targetFrom 二选一 */
  target?: string | Rgba
  /** 从底图这个位置(0-1)取目标色,例如键盘主体 */
  targetFrom?: { x: number; y: number }
  /** 只选接近这个颜色的像素(源图颜色),例如白色键帽 */
  color?: string
  /** 颜色容差 0-160,默认 42 */
  tolerance?: number
  mask?: RgbaImage
  maskKind?: MaskKind
  invertMask?: boolean
  /** 蒙版向外扩张的像素数(0-16):蒙版只盖到顶面时,用它把侧壁一起包进来 */
  growPx?: number
  region?: GuardRect
  exclude?: GuardRect[]
  /** 保留原图明暗/纹理,默认 true */
  preserveShading?: boolean
  /** 0-1,默认 1 */
  strength?: number
  featherPx?: number
}

function colorDistance(data: Uint8Array, o: number, target: [number, number, number]): number {
  return (
    0.3 * Math.abs(data[o] - target[0]) +
    0.59 * Math.abs(data[o + 1] - target[1]) +
    0.11 * Math.abs(data[o + 2] - target[2])
  )
}

function sampleAverage(img: RgbaImage, nx: number, ny: number, radius = 3): [number, number, number] {
  const cx = Math.round(clamp01(nx) * (img.width - 1))
  const cy = Math.round(clamp01(ny) * (img.height - 1))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const ix = Math.min(img.width - 1, Math.max(0, x))
      const iy = Math.min(img.height - 1, Math.max(0, y))
      const o = (iy * img.width + ix) * 4
      if (img.data[o + 3] < 8) continue
      r += img.data[o]
      g += img.data[o + 1]
      b += img.data[o + 2]
      n++
    }
  }
  if (!n) return [128, 128, 128]
  return [r / n, g / n, b / n]
}

export function paintRegion(img: RgbaImage, opts: PaintOptions): { image: RgbaImage; report: LocalPaintReport } {
  const selector = opts.color ? parseColor(opts.color) : null
  const target: [number, number, number] = opts.targetFrom
    ? sampleAverage(img, opts.targetFrom.x, opts.targetFrom.y)
    : (() => {
        const t = typeof opts.target === 'string' ? parseColor(opts.target) : opts.target
        if (!t) return [0, 0, 0] as [number, number, number]
        return [t[0], t[1], t[2]] as [number, number, number]
      })()
  const tolerance = Math.max(0, opts.tolerance ?? 42)
  const w = img.width
  const h = img.height
  const mask = buildAllowedMask(w, h, { region: opts.region, mask: opts.mask, maskKind: opts.maskKind, invertMask: opts.invertMask }, 0)
  const grown =
    opts.growPx && opts.growPx > 0
      ? dilateMask(mask, w, h, (opts.growPx * w) / Math.max(1, img.width))
      : mask
  const weight = new Float32Array(w * h)
  let meanSource = 0
  let sampled = 0
  let srcR = 0
  let srcG = 0
  let srcB = 0
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    if (img.data[o + 3] < 8) continue
    let v = grown[i] / 255
    if (selector) {
      const d = colorDistance(img.data, o, [selector[0], selector[1], selector[2]])
      v *= d <= tolerance ? 1 : d >= tolerance * 1.35 ? 0 : (tolerance * 1.35 - d) / (tolerance * 0.35)
    }
    if (v <= 0.002) continue
    weight[i] = v
    meanSource += luma(img.data[o], img.data[o + 1], img.data[o + 2]) * v
    srcR += img.data[o] * v
    srcG += img.data[o + 1] * v
    srcB += img.data[o + 2] * v
    sampled += v
  }
  const sourceMeanLuma = sampled > 0 ? meanSource / sampled : 0
  const sourceMeanColor: [number, number, number] = sampled
    ? toRgba(srcR / sampled, srcG / sampled, srcB / sampled)
    : [0, 0, 0]
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let sumLuma = 0
  let painted = 0
  const strength = clamp01(opts.strength ?? 1)
  const preserve = opts.preserveShading !== false
  const out: RgbaImage = { width: w, height: h, data: new Uint8Array(img.data) }
  const scale = Math.max(w, h) / 1600
  const feather = (opts.featherPx ?? 0) / Math.max(0.0001, scale)
  if (feather > 0.2) {
    const blurred = boxBlur(weight.map((v) => v * 255), w, h, feather)
    for (let i = 0; i < w * h; i++) weight[i] = blurred[i] / 255
  }
  const excludeRects = opts.exclude ?? []
  for (const rect of excludeRects) {
    const m = rectMask(w, h, rect)
    for (let i = 0; i < w * h; i++) if (m[i] > 0) weight[i] = 0
  }

  // ---- albedo 模式:估计"白塑料"的白点,把漫反射换成目标色,高光保留 ----
  const albedoMode = opts.mode === 'albedo' && preserve
  const targetLin: [number, number, number] = [srgbToLinear(target[0]), srgbToLinear(target[1]), srgbToLinear(target[2])]
  const whitePoint: [number, number, number] = [0.8, 0.8, 0.8]
  const k: [number, number, number] = [1, 1, 1]
  if (albedoMode) {
    const bins = 256
    const hist = [new Float64Array(bins), new Float64Array(bins), new Float64Array(bins)]
    let total = 0
    for (let i = 0; i < w * h; i++) {
      if (weight[i] < 0.05) continue
      const o = i * 4
      const lin = [srgbToLinear(img.data[o]), srgbToLinear(img.data[o + 1]), srgbToLinear(img.data[o + 2])]
      for (let c = 0; c < 3; c++) {
        const idx = Math.min(bins - 1, Math.max(0, Math.round(lin[c] * (bins - 1))))
        hist[c][idx] += weight[i]
      }
      total += weight[i]
    }
    if (total > 1) {
      for (let c = 0; c < 3; c++) {
        const want = total * 0.97
        let acc = 0
        let idx = bins - 1
        for (let b = 0; b < bins; b++) {
          acc += hist[c][b]
          if (acc >= want) {
            idx = b
            break
          }
        }
        whitePoint[c] = Math.max(0.05, idx / (bins - 1))
      }
    }
    for (let c = 0; c < 3; c++) {
      k[c] = Math.min(2, Math.max(0, targetLin[c] / whitePoint[c]))
    }
  }
  const wpLuma = Math.max(1e-4, luma(whitePoint[0], whitePoint[1], whitePoint[2]))
  let hlTotal = 0
  let hlKept = 0
  const highlightProtect = clamp01(opts.highlightProtect ?? 0)
  const shadowLift = clamp01(opts.shadowLift ?? 0)

  // 高光掩码 = 高频正残差(比局部平均更亮的部分)+ 真正过曝的像素。
  // 这样平坦的白色键帽不会被整块当成高光,只有真正的反射亮斑/亮边被保留。
  let specMap: Float32Array | undefined
  if (albedoMode) {
    const lumaMap = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const o = i * 4
      lumaMap[i] = luma(img.data[o], img.data[o + 1], img.data[o + 2])
    }
    const radius = Math.max(4, Math.round(Math.min(w, h) * 0.006))
    const blurMap = boxBlur(lumaMap, w, h, radius)
    specMap = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) specMap[i] = Math.max(0, lumaMap[i] - blurMap[i])
  }

  for (let i = 0; i < w * h; i++) {
    const v = weight[i] * strength
    if (v <= 0.002) continue
    const o = i * 4
    const srcL = luma(img.data[o], img.data[o + 1], img.data[o + 2])
    let r: number
    let g: number
    let b: number
    if (albedoMode) {
      const lr = srgbToLinear(img.data[o])
      const lg = srgbToLinear(img.data[o + 1])
      const lb = srgbToLinear(img.data[o + 2])
      const rel = clamp01((0.2126 * lr + 0.7152 * lg + 0.0722 * lb) / wpLuma)
      const spec = specMap ? specMap[i] / 255 : 0
      const clipped = img.data[o] >= 248 && img.data[o + 1] >= 248 && img.data[o + 2] >= 248
      const h = Math.max(smoothstep(0.025, 0.14, spec), clipped ? 0.7 : 0) * highlightProtect
      const lift = shadowLift * (1 - rel) * 0.15
      r = linearToSrgb(lr * k[0] * (1 - h) + lr * h + targetLin[0] * lift)
      g = linearToSrgb(lg * k[1] * (1 - h) + lg * h + targetLin[1] * lift)
      b = linearToSrgb(lb * k[2] * (1 - h) + lb * h + targetLin[2] * lift)
      if (specMap && spec > 0.03 && rel >= 0.9) {
        hlTotal++
        const newL = luma(r, g, b)
        if (newL >= srcL * 0.8) hlKept++
      }
    } else if (preserve) {
      // 保留相对明暗(ratio),再叠回高频细节(shade),所以键帽的倒角、主体的磨砂都还在
      const ratio = sourceMeanLuma > 1 ? Math.min(1.6, Math.max(0.55, srcL / sourceMeanLuma)) : 1
      const shade = (srcL - sourceMeanLuma) * 0.55
      r = target[0] * ratio + shade
      g = target[1] * ratio + shade
      b = target[2] * ratio + shade
    } else {
      r = target[0]
      g = target[1]
      b = target[2]
    }
    out.data[o] = clamp255(img.data[o] * (1 - v) + r * v)
    out.data[o + 1] = clamp255(img.data[o + 1] * (1 - v) + g * v)
    out.data[o + 2] = clamp255(img.data[o + 2] * (1 - v) + b * v)
    // 统计"实际看出来被改写"的像素:蒙版抗锯齿/羽化产生的 1-5% 权重边缘不算,
    // 否则外扩 4px 会把覆盖率从 33% 虚报成 73%。
    if (v >= 0.05) {
      painted++
      sumR += out.data[o]
      sumG += out.data[o + 1]
      sumB += out.data[o + 2]
      sumLuma += luma(out.data[o], out.data[o + 1], out.data[o + 2])
    }
  }
  const mean: [number, number, number] = painted
    ? toRgba(sumR / painted, sumG / painted, sumB / painted)
    : [0, 0, 0]
  const targetLuma = luma(target[0], target[1], target[2])
  const meanDelta = painted ? Math.abs(luma(mean[0], mean[1], mean[2]) - targetLuma) : 0
  return {
    image: out,
    report: {
      painted,
      coverage: painted / (w * h),
      target: toRgba(target[0], target[1], target[2]),
      mean,
      meanDelta,
      sourceMean: sourceMeanColor,
      mode: albedoMode ? 'albedo' : 'shade',
      ...(albedoMode
        ? {
            whitePoint: [whitePoint[0], whitePoint[1], whitePoint[2]] as [number, number, number],
            highlightRetention: hlTotal ? hlKept / hlTotal : 0
          }
        : {})
    }
  }
}

/** 把报告压成一句人话(工具返回给模型看) */
export function guardSummary(report: EditGuardReport): string {
  const bits: string[] = []
  bits.push(`区域外 ${(report.deliveredOutsideChangedRatio * 100).toFixed(2)}% 改动`)
  if (report.edgeAnchor !== null) bits.push(`边界锚定 ${report.edgeAnchor.toFixed(2)}`)
  bits.push(report.verdict === 'ok' ? '保真通过' : '保真可疑')
  return bits.join(' · ')
}
