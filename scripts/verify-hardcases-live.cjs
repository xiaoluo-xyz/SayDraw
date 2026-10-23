// 困难图实测(真实生图模型,会产生费用):键盘换色 / 标签改一行 / 护栏合成
//
//   node_modules\.bin\electron scripts\verify-hardcases-live.cjs [keyboard|paint|label|all]
//
// 产物写入 _shots/hardcases/,指标写入 _shots/hardcases/report.json
// 说明:键盘素材已做 EXIF 方向归一化(_demo/hardcases/keyboard.jpg,2880×2160)。
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, '_shots', 'hardcases')
fs.mkdirSync(SHOTS, { recursive: true })
const posix = (p) => p.replace(/\\/g, '/')
const which = (process.argv[2] || 'all').toLowerCase()

app.disableHardwareAcceleration()
// 直接复用正式应用的设置(加密 Key 走同一份 safeStorage)
app.setPath('userData', path.join(app.getPath('appData'), 'SayDraw'))

function buildBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saydraw-hardcases-'))
  const entry = path.join(dir, 'entry.ts')
  fs.writeFileSync(
    entry,
    [
      `export { getSettings } from '${posix(path.join(ROOT, 'src/main/store/settings'))}'`,
      `export { editImage } from '${posix(path.join(ROOT, 'src/main/providers/images'))}'`,
      `export { decodeRgba, encodeRgba } from '${posix(path.join(ROOT, 'src/main/imageops'))}'`,
      `export * from '${posix(path.join(ROOT, 'src/shared/fidelity'))}'`,
      `export * from '${posix(path.join(ROOT, 'src/shared/composite'))}'`
    ].join('\n'),
    'utf8'
  )
  const outfile = path.join(dir, 'bundle.cjs')
  require('esbuild').buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    alias: { '@shared': posix(path.join(ROOT, 'src', 'shared')) },
    outfile,
    logLevel: 'warning'
  })
  return require(outfile)
}

function loadImage(mod, file) {
  const img = mod.decodeRgba(fs.readFileSync(file))
  if (!img) throw new Error(`无法解码 ${file}`)
  return img
}

/** 白色键帽掩码:亮度阈值 → 腐蚀断开与外壳的亮桥 → 连通域 → 去掉贴边/最大块(外壳框) → 膨胀回键帽侧面 */
function buildKeycapMask(img) {
  const w = img.width
  const h = img.height
  const n = w * h
  const bright = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const l = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
    if (l > 150 && img.data[o + 3] > 128) bright[i] = 1
  }
  const minMax = (src, radius, wantMax) => {
    const tmp = new Uint8Array(n)
    const out = new Uint8Array(n)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = wantMax ? 0 : 1
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k))
          const s = src[y * w + xx]
          v = wantMax ? (s > v ? s : v) : (s < v ? s : v)
        }
        tmp[y * w + x] = v
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = wantMax ? 0 : 1
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k))
          const s = tmp[yy * w + x]
          v = wantMax ? (s > v ? s : v) : (s < v ? s : v)
        }
        out[y * w + x] = v
      }
    }
    return out
  }
  const core = minMax(minMax(bright, 2, false), 2, false) // 腐蚀 2px:细亮桥断开
  const comp = new Int32Array(n).fill(-1)
  const stats = []
  const stack = []
  let id = 0
  for (let start = 0; start < n; start++) {
    if (!core[start] || comp[start] >= 0) continue
    comp[start] = id
    stack.length = 0
    stack.push(start)
    let area = 0
    let minX = w
    let maxX = 0
    let minY = h
    let maxY = 0
    let border = false
    while (stack.length) {
      const cur = stack.pop()
      const x = cur % w
      const y = (cur / w) | 0
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3) border = true
      if (x > 0 && core[cur - 1] && comp[cur - 1] < 0) { comp[cur - 1] = id; stack.push(cur - 1) }
      if (x < w - 1 && core[cur + 1] && comp[cur + 1] < 0) { comp[cur + 1] = id; stack.push(cur + 1) }
      if (y > 0 && core[cur - w] && comp[cur - w] < 0) { comp[cur - w] = id; stack.push(cur - w) }
      if (y < h - 1 && core[cur + w] && comp[cur + w] < 0) { comp[cur + w] = id; stack.push(cur + w) }
    }
    stats.push({ id, area, border })
    id++
  }
  const big = stats.reduce((a, b) => (b.area > a.area ? b : a), { area: 0, id: -1 })
  const keep = new Set(
    stats
      .filter((s) => !s.border && s.id !== big.id && s.area >= Math.max(400, n * 0.0001) && s.area <= n * 0.04)
      .map((s) => s.id)
  )
  const keptCore = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (comp[i] >= 0 && keep.has(comp[i])) keptCore[i] = 1
  const grown = minMax(minMax(keptCore, 3, true), 3, true)
  const mask = { width: w, height: h, data: new Uint8Array(n * 4) }
  let count = 0
  for (let i = 0; i < n; i++) {
    if (!grown[i]) continue
    const o = i * 4
    const l = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
    if (l < 85) continue // 不跨进键缝阴影
    mask.data[o] = 255
    mask.data[o + 1] = 255
    mask.data[o + 2] = 255
    mask.data[o + 3] = 255
    count++
  }
  return { mask, kept: count, components: stats.length, keptComponents: keep.size }
}
function lumaStats(img, mask, rect) {
  let sum = 0
  let count = 0
  const x0 = Math.max(0, Math.floor(rect.x * img.width))
  const y0 = Math.max(0, Math.floor(rect.y * img.height))
  const x1 = Math.min(img.width, Math.ceil((rect.x + rect.w) * img.width))
  const y1 = Math.min(img.height, Math.ceil((rect.y + rect.h) * img.height))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * img.width + x
      if (mask && mask.data[i * 4 + 3] < 128) continue
      const o = i * 4
      sum += 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
      count++
    }
  }
  return count ? sum / count : 0
}

function rectDiffRatio(a, b, rect) {
  const x0 = Math.max(0, Math.floor(rect.x * a.width))
  const y0 = Math.max(0, Math.floor(rect.y * a.height))
  const x1 = Math.min(a.width, Math.ceil((rect.x + rect.w) * a.width))
  const y1 = Math.min(a.height, Math.ceil((rect.y + rect.h) * a.height))
  let changed = 0
  let total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * a.width + x) * 4
      const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]))
      if (d > 10) changed++
      total++
    }
  }
  return total ? changed / total : 0
}

function savePng(mod, img, name) {
  const file = path.join(SHOTS, name)
  fs.writeFileSync(file, mod.encodeRgba(img, 'png'))
  return file
}

function metrics(mod, original, output, opts) {
  const region = opts.region
  const cmp = mod.compareWithBaseline(original, output, { region, heatmap: true })
  const heat = savePng(mod, cmp.heatmap, `${opts.tag}-diff.png`)
  const out = { tag: opts.tag, diff: heat, report: JSON.parse(JSON.stringify(cmp.report)) }
  if (opts.capMask) out.capLumaAfter = Number(lumaStats(output, opts.capMask, { x: 0, y: 0, w: 1, h: 1 }).toFixed(1))
  if (opts.badgeRect) out.badgeChanged = Number(rectDiffRatio(original, output, opts.badgeRect).toFixed(4))
  return out
}

async function run() {
  const mod = buildBundle()
  const settings = mod.getSettings()
  const profile = settings.activeImageProfile()
  if (!profile) throw new Error('未配置生图服务')
  const timeoutMs = settings.load().imageTimeoutMs ?? 300000
  const results = []
  const kbFile = path.join(ROOT, '_demo', 'hardcases', 'keyboard.jpg')
  const kb = loadImage(mod, kbFile)
  const badgeRect = { x: 0.905, y: 0.565, w: 0.055, h: 0.075 }
  const capsBox = { x: 0.09, y: 0.14, w: 0.82, h: 0.57 }
  const keycaps = buildKeycapMask(kb)
  console.log(`keyboard ${kb.width}x${kb.height} keycap mask: ${keycaps.keptComponents} 块 / ${keycaps.kept} px`)

  if (which === 'all' || which === 'keyboard') {
    const prompt =
      '把画面里键盘上的白色键帽全部改成黑色键帽（帽面纯黑，侧面保留一点高光），键盘外壳保持原来的米白色不动。' +
      '键帽的排列布局、每个按键的大小和位置、右下角的 SayoDevice 小徽标、深色小屏幕必须完全保持原样，不要重绘键盘。'
    const started = Date.now()
    console.log('→ 调模型:键盘键帽换色(无护栏)…')
    const res = await mod.editImage({
      profile,
      prompt,
      images: [{ buffer: fs.readFileSync(kbFile), mime: 'image/jpeg' }],
      size: `${kb.width}x${kb.height}`,
      timeoutMs,
      signal: undefined
    })
    console.log(`  模型返回 ${res.buffers.length} 张，${((Date.now() - started) / 1000).toFixed(1)}s`)
    const output = mod.decodeRgba(res.buffers[0])
    const file = savePng(mod, output, 'keyboard-model.png')
    const m = metrics(mod, kb, output, { tag: 'keyboard-model', region: capsBox, capMask: keycaps.mask, badgeRect })
    m.tag = 'keyboard-model'
    m.file = file
    m.prompt = prompt
    m.cost = profile.pricePerImage ?? 0
    m.seconds = Math.round((Date.now() - started) / 1000)
    m.capLumaBefore = Number(lumaStats(kb, keycaps.mask, { x: 0, y: 0, w: 1, h: 1 }).toFixed(1))
    results.push(m)
    console.log(`  保真: 区域外 ${(m.report.modelOutsideChangedRatio * 100).toFixed(2)}% / 锚定 ${m.report.edgeAnchor} / 徽标改动 ${m.badgeChanged}`)
  }

  if (which === 'all' || which === 'paint') {
    const started = Date.now()
    const kb2File = path.join(ROOT, '_demo', 'hardcases', 'keyboard_black.png')
    const kb2 = loadImage(mod, kb2File)
    const res = mod.paintRegion(kb2, {
      targetFrom: { x: 0.5, y: 0.12 }, // 从键盘上沿壳体取样(黑)
      color: '#e9e6dd', // 只选白色键帽
      tolerance: 30,
      preserveShading: true,
      featherPx: 1
    })
    const file = savePng(mod, res.image, 'keyboard-black-paint.png')
    const m = metrics(mod, kb2, res.image, { tag: 'keyboard-black-paint', region: { x: 0, y: 0, w: 1, h: 1 } })
    m.tag = 'keyboard-black-paint'
    m.file = file
    m.cost = 0
    m.seconds = Math.round((Date.now() - started) / 1000)
    m.paint = JSON.parse(JSON.stringify(res.report))
    const px = (img, nx, ny) => {
      const x = Math.round(nx * (img.width - 1))
      const y = Math.round(ny * (img.height - 1))
      const o = (y * img.width + x) * 4
      return [img.data[o], img.data[o + 1], img.data[o + 2]]
    }
    const near = (a, b, tol = 6) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol
    m.badgeRingKept = near(px(kb2, 0.844, 0.69), [200, 162, 74])
    m.badgeCenterKept = near(px(kb2, 0.84, 0.72), [23, 24, 26])

    results.push(m)
    console.log(`  换色:命中 ${(res.report.coverage * 100).toFixed(1)}% / 徽标改动 ${(m.badgeChanged * 100).toFixed(2)}% / 锚定 ${m.report.edgeAnchor}`)
  }
  if (which === 'all' || which === 'label') {
    const labelFile = path.join(ROOT, '_demo', 'hardcases', 'label_text.png')
    const label = loadImage(mod, labelFile)
    const line = { x: 0.02, y: 0.245, w: 0.46, h: 0.075 }
    const prompt = '把标签上的 S/N 2024-09-0017-A 改成 S/N 2025-01-0042-A。只改这一行，其它文字、条码、红色徽标、边框全部保持原样。'
    const started = Date.now()
    console.log('→ 调模型:标签改一行(带 protect 护栏)…')
    const res = await mod.editImage({
      profile,
      prompt,
      images: [{ buffer: fs.readFileSync(labelFile), mime: 'image/png' }],
      size: `${label.width}x${label.height}`,
      timeoutMs
    })
    console.log(`  模型返回 ${res.buffers.length} 张，${((Date.now() - started) / 1000).toFixed(1)}s`)
    const output = mod.decodeRgba(res.buffers[0])
    const rawFile = savePng(mod, output, 'label-raw.png')
    const guarded = mod.applyEditGuard(label, output, { region: line, featherPx: 2, baselineAssetId: 'label_text.png' })
    const file = savePng(mod, guarded.image, 'label-guard.png')
    const rawMetrics = metrics(mod, label, output, { tag: 'label-guard', region: line })
    const m = { ...rawMetrics, tag: 'label-guard', modelReport: rawMetrics.report, report: guarded.report }
    m.rawFile = rawFile
    m.file = file
    m.guard = JSON.parse(JSON.stringify(guarded.report))
    m.cost = profile.pricePerImage ?? 0
    m.seconds = Math.round((Date.now() - started) / 1000)
    results.push(m)
    // 其它行是否被模型动过(护栏前)
    const otherLines = { x: 0.02, y: 0.30, w: 0.62, h: 0.30 }
    m.otherLinesChangedByModel = Number(rectDiffRatio(label, output, otherLines).toFixed(4))
    console.log(`  模型在其它行改掉 ${(m.otherLinesChangedByModel * 100).toFixed(2)}%，护栏后区域外 ${(m.guard.deliveredOutsideChangedRatio * 100).toFixed(2)}%`)
  }

  if (which === 'guardonly') {
    // 不调模型:用已经存下来的 label-raw.png 重新做一次护栏合成(用于复核判定口径)
    const labelFile = path.join(ROOT, '_demo', 'hardcases', 'label_text.png')
    const label = loadImage(mod, labelFile)
    const raw = loadImage(mod, path.join(SHOTS, 'label-raw.png'))
    const line = { x: 0.02, y: 0.245, w: 0.46, h: 0.075 }
    const guarded = mod.applyEditGuard(label, raw, { region: line, featherPx: 2, baselineAssetId: 'label_text.png' })
    const rawMetrics = metrics(mod, label, raw, { tag: 'label-guard', region: line })
    const m = { ...rawMetrics, tag: 'label-guard', modelReport: rawMetrics.report, report: guarded.report }
    m.rawFile = path.join(SHOTS, 'label-raw.png')
    m.file = savePng(mod, guarded.image, 'label-guard.png')
    m.guard = JSON.parse(JSON.stringify(guarded.report))
    m.cost = 0
    m.seconds = 0
    m.otherLinesChangedByModel = Number(rectDiffRatio(label, raw, { x: 0.02, y: 0.30, w: 0.62, h: 0.30 }).toFixed(4))
    results.push(m)
    console.log(`  复核:区域外 ${(m.guard.deliveredOutsideChangedRatio * 100).toFixed(2)}% / 锚定 ${m.guard.edgeAnchor} / verdict ${m.guard.verdict}`)
  }

  const reportFile = path.join(SHOTS, 'report.json')
  let prev = []
  try { prev = JSON.parse(fs.readFileSync(reportFile, 'utf8')).results || [] } catch { /* 首次运行 */ }
  const merged = [...prev.filter((p) => !results.some((r) => r.tag === p.tag)), ...results]
  fs.writeFileSync(reportFile, JSON.stringify({ model: profile.model, provider: profile.name, results: merged }, null, 2), 'utf8')
  console.log(`\n报告:${reportFile}`)
  app.quit()
}

app.whenReady().then(() =>
  run().catch((err) => {
    console.error('FAILED:', err && err.stack ? err.stack : err)
    app.exit(1)
  })
)
