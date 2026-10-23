// 保真改图工具层验收(不联网、不花额度):paint / compare_image / edit_image.protect 参数校验
//   node_modules\.bin\electron scripts\verify-fidelity-live.cjs
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, '_shots')
fs.mkdirSync(SHOTS, { recursive: true })
const posix = (p) => p.replace(/\\/g, '/')
const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saydraw-fidelity-live-'))
app.setPath('userData', path.join(tmpRoot, 'userData'))
app.setPath('sessionData', path.join(tmpRoot, 'sessionData'))
app.setPath('cache', path.join(tmpRoot, 'cache'))

function buildBundle() {
  const dir = path.join(tmpRoot, 'bundle')
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(ROOT, 'src', 'main')
  const entry = path.join(dir, 'entry.ts')
  fs.writeFileSync(
    entry,
    [
      `export { getDb } from '${posix(path.join(src, 'store/db'))}'`,
      `export { saveBufferAsset, readAssetBuffer } from '${posix(path.join(src, 'store/assets'))}'`,
      `export { execCompositeImage, execCompareImage, execEditImage } from '${posix(path.join(src, 'agent/tools'))}'`,
      `export { decodeRgba } from '${posix(path.join(src, 'imageops'))}'`
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

/** 黑壳 + 白键帽 + 金色徽标的测试图(纯色块,方便逐像素断言) */
function makeKeyboard(w = 900, h = 520) {
  const bmp = Buffer.alloc(w * h * 4)
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 4
    bmp[i] = b
    bmp[i + 1] = g
    bmp[i + 2] = r
    bmp[i + 3] = 255
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, 26, 27, 31)
  // 外壳
  for (let y = 40; y < 480; y++) for (let x = 60; x < 840; x++) put(x, y, 18, 19, 22)
  // 键帽 12×4
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 12; col++) {
      const x0 = 90 + col * 62
      const y0 = 70 + row * 95
      for (let y = y0; y < y0 + 74; y++) for (let x = x0; x < x0 + 52; x++) put(x, y, 235, 232, 224)
    }
  }
  // 金色徽标(平面贴纸,不能被换色改掉)
  for (let y = 400; y < 460; y++) for (let x = 760; x < 820; x++) put(x, y, 200, 160, 70)
  // 深色小屏
  for (let y = 400; y < 448; y++) for (let x = 650; x < 745; x++) put(x, y, 40, 44, 50)
  return bmp
}

function pixel(img, x, y) {
  const o = (y * img.width + x) * 4
  return [img.data[o], img.data[o + 1], img.data[o + 2]]
}

app.whenReady().then(async () => {
  try {
    const api = buildBundle()
    const { nativeImage } = require('electron')
    const db = api.getDb()
    const session = db.createSession('保真改图验收')
    const ctx = { sessionId: session.id, signal: new AbortController().signal, emit: () => {} }

    const w = 900
    const h = 520
    const bmp = makeKeyboard(w, h)
    const baseBuf = nativeImage.createFromBitmap(bmp, { width: w, height: h }).toPNG()
    fs.writeFileSync(path.join(SHOTS, 'fid-1-base.png'), baseBuf)
    const baseAsset = api.saveBufferAsset({ sessionId: session.id, buffer: baseBuf, mime: 'image/png', kind: 'user-upload' })
    const baseImg = api.decodeRgba(baseBuf)
    record('底图解码', Boolean(baseImg), `${baseImg && baseImg.width}×${baseImg && baseImg.height}`)

    // ---- paint ----
    const painted = api.execCompositeImage(ctx, {
      assetId: baseAsset.id,
      label: '键帽换色',
      paint: {
        targetFrom: { x: 0.5, y: 0.12 },
        color: '#ebe8e0',
        tolerance: 30,
        preserveShading: true
      }
    })
    record('paint 返回成功', painted.ok === true, painted.text.slice(0, 140))
    record('paint 产出 1 张', painted.assetIds.length === 1)
    const outAsset = db.asset(painted.assetIds[0])
    record('paint 挂版本链', outAsset.parentId === baseAsset.id)
    record('paint 记录 originAssetId', outAsset.meta.originAssetId === baseAsset.id, String(outAsset.meta.originAssetId))
    record('paint 有本地报告', Boolean(outAsset.meta.paint && outAsset.meta.paint.painted > 1000), JSON.stringify(outAsset.meta.paint && outAsset.meta.paint.painted))
    record('paint 不算生图成本', outAsset.meta.cost === 0)
    record(
      'paint 默认走 albedo(保留高光)',
      outAsset.meta.paint.mode === 'albedo' && typeof outAsset.meta.paint.highlightRetention === 'number',
      'mode=' + outAsset.meta.paint.mode + ' hr=' + outAsset.meta.paint.highlightRetention
    )

    const outImg = api.decodeRgba(api.readAssetBuffer(outAsset))
    fs.writeFileSync(path.join(SHOTS, 'fid-2-painted.png'), api.readAssetBuffer(outAsset))
    const capAfter = pixel(outImg, 116, 106)
    const bodyAfter = pixel(outImg, 80, 300)
    const badgeAfter = pixel(outImg, 790, 430)
    record('paint 键帽变黑', capAfter.every((v) => v < 70), `cap=${capAfter}`)
    record('paint 壳体不变', bodyAfter.every((v, i) => v === pixel(baseImg, 80, 300)[i]), `body=${bodyAfter}`)
    record('paint 徽标不变', badgeAfter.every((v, i) => v === pixel(baseImg, 790, 430)[i]), `badge=${badgeAfter}`)
    let illegal = 0
    let changed = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = pixel(baseImg, x, y)
        const b = pixel(outImg, x, y)
        if (a.join() === b.join()) continue
        changed++
        const l = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]
        if (l < 180) illegal++
      }
    }
    record('paint 只改原图发白的像素', illegal === 0, `changed=${changed} illegal=${illegal}`)

    // ---- compare_image ----
    const cmp = api.execCompareImage(ctx, {
      assetId: outAsset.id,
      baselineAssetId: baseAsset.id,
      region: { x: 0.08, y: 0.1, w: 0.84, h: 0.76 },
      heatmap: true
    })
    record('compare 返回成功', cmp.ok === true, cmp.text.slice(0, 160))
    record('compare 指出区域外 0 改动', cmp.text.includes('区域外改动 0.00%'), cmp.text.slice(0, 120))
    record('compare 产出热图(标注图)', cmp.assetIds.length === 1 && db.asset(cmp.assetIds[0]).kind === 'annotation', JSON.stringify(cmp.assetIds))
    const heat = db.asset(cmp.assetIds[0])
    record('compare 热图不进版本树', heat.meta.inspect === true && heat.parentId === outAsset.id)
    fs.writeFileSync(path.join(SHOTS, 'fid-3-diff.png'), api.readAssetBuffer(heat))

    // ---- compare 抓"改到别处":在区域外涂一块红 ----
    const brokenBuf = Buffer.from(bmp)
    for (let y = 10; y < 70; y++) for (let x = 10; x < 120; x++) {
      const i = (y * w + x) * 4
      brokenBuf[i] = 40
      brokenBuf[i + 1] = 40
      brokenBuf[i + 2] = 240
      brokenBuf[i + 3] = 255
    }
    const broken = api.saveBufferAsset({
      sessionId: session.id,
      buffer: nativeImage.createFromBitmap(brokenBuf, { width: w, height: h }).toPNG(),
      mime: 'image/png',
      kind: 'edited',
      parentId: baseAsset.id
    })
    const cmp2 = api.execCompareImage(ctx, { assetId: broken.id, baselineAssetId: baseAsset.id, region: { x: 0.1, y: 0.15, w: 0.8, h: 0.7 } })
    record('compare 抓到区域外改动', cmp2.ok === true && cmp2.text.includes('保真可疑'), cmp2.text.slice(0, 180))
    record('compare 报出聚集位置', /x 0\.0/.test(cmp2.text), cmp2.text.slice(0, 220))

    // ---- edit_image.protect 参数校验(不调模型) ----
    const badProtect = await api.execEditImage(ctx, { assetIds: [baseAsset.id], instruction: '改键帽', protect: { featherPx: 2 } })
    record('protect 缺 region/mask 被拒', badProtect.ok === false && badProtect.text.includes('region'), badProtect.text.slice(0, 120))
    const multi = await api.execEditImage(ctx, {
      assetIds: [baseAsset.id, outAsset.id],
      instruction: '融合',
      protect: { region: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }
    })
    record('protect 多源图被拒', multi.ok === false && multi.text.includes('单源图'), multi.text.slice(0, 120))

    // ---- paint 选不中时明确报错 ----
    const noop = api.execCompositeImage(ctx, { assetId: baseAsset.id, paint: { target: '#ebe8e0', color: '#ebe8e0', tolerance: 30 } })
    record('paint 目标色=选中色 → 拒绝空刷', noop.ok === false && noop.text.includes('等于没刷'), noop.text.slice(0, 140))

    const miss = api.execCompositeImage(ctx, { assetId: baseAsset.id, paint: { target: '#00ff00', color: '#ff00ff', tolerance: 5 } })
    record('paint 选不中 → 明确报错', miss.ok === false && miss.text.includes('没命中'), miss.text.slice(0, 120))

    // ---- maskGrow:蒙版只盖到顶面时,外扩把侧壁包进来 ----
    const maskBmp = Buffer.alloc(w * h * 4)
    for (let y = 70; y < 144; y++) {
      for (let x = 90; x < 142; x++) {
        const i = (y * w + x) * 4
        maskBmp[i] = 255
        maskBmp[i + 1] = 255
        maskBmp[i + 2] = 255
        maskBmp[i + 3] = 255
      }
    }
    const maskAsset = api.saveBufferAsset({
      sessionId: session.id,
      buffer: nativeImage.createFromBitmap(maskBmp, { width: w, height: h }).toPNG(),
      mime: 'image/png',
      kind: 'mask'
    })
    const grownPaint = api.execCompositeImage(ctx, {
      assetId: baseAsset.id,
      paint: { target: '#ff0000', maskAssetId: maskAsset.id, maskGrow: 4, preserveShading: false }
    })
    record('paint 支持 maskGrow', grownPaint.ok === true, grownPaint.text.slice(0, 140))
    const grownAsset = db.asset(grownPaint.assetIds[0])
    const grownImg = api.decodeRgba(api.readAssetBuffer(grownAsset))
    const sideWall = pixel(grownImg, 87, 106)
    record('maskGrow 把侧壁包进来', sideWall[0] === 255 && sideWall[1] === 0, `side=${sideWall}`)
    record('maskGrow 报告外扩后的覆盖', grownAsset.meta.paint.painted > 52 * 74, `${grownAsset.meta.paint.painted}px`)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    if (failed.length) {
      console.log(failed.map((f) => ' - ' + f.name).join('\n'))
      app.exit(1)
      return
    }
    app.quit()
  } catch (err) {
    console.error('FAILED:', err && err.stack ? err.stack : err)
    app.exit(1)
  }
})
