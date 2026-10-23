// 本地合成端到端验收(不联网、不花额度):用真实图片调真工具,输出写到 _shots/ 供肉眼复核
//
// 用法:node_modules\.bin\electron scripts\verify-composite-live.cjs
//
// 验证:
//   1. composite_image 贴图(裁剪源区域 → 目标矩形)+ 局部调色 + 圆角,产出新版本、meta.local、¥0
//   2. 贴上去的位置真的变了(逐像素对比),区域外保持原样
//   3. inspect_grid 产出坐标网格标注图(annotation,不进版本树)
//   4. collage 拼接 N 张 → 尺寸与格子内容正确
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, '_shots')
fs.mkdirSync(SHOTS, { recursive: true })

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const posix = (p) => p.replace(/\\/g, '/')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saydraw-composite-'))
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
      `export { saveBufferAsset, readAssetBuffer, assetAbsolutePath } from '${posix(path.join(src, 'store/assets'))}'`,
      `export { execCompositeImage, execInspectGrid } from '${posix(path.join(src, 'agent/tools'))}'`,
      `export { decodeRgba } from '${posix(path.join(src, 'imageops'))}'`
    ].join('\n'),
    'utf8'
  )
  const esbuild = require('esbuild')
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    alias: { '@shared': posix(path.join(ROOT, 'src', 'shared')) },
    outfile: path.join(dir, 'bundle.cjs'),
    logLevel: 'warning'
  })
  return require(path.join(dir, 'bundle.cjs'))
}

/** 造一张有方向性纹理的测试图(左上红→右下蓝,带一条白色竖条),便于肉眼判断贴图位置 */
function makePatternPng(w, h) {
  const { nativeImage } = require('electron')
  const bmp = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const t = x / w
      const u = y / h
      bmp[i] = Math.round(255 * (1 - t)) // B
      bmp[i + 1] = Math.round(60 * u) // G
      bmp[i + 2] = Math.round(255 * t) // R
      bmp[i + 3] = 255
      if (x > w * 0.45 && x < w * 0.55) {
        bmp[i] = 255
        bmp[i + 1] = 255
        bmp[i + 2] = 255
      }
    }
  }
  return nativeImage.createFromBitmap(bmp, { width: w, height: h }).toPNG()
}

/** 生成一个「抠图 PNG」:中间一块橙色方块,四周透明(用来验证 from:'auto' 自动取主体) */
function makeCutoutPng(w, h) {
  const { nativeImage } = require('electron')
  const bmp = Buffer.alloc(w * h * 4)
  const x0 = Math.round(w * 0.3)
  const x1 = Math.round(w * 0.7)
  const y0 = Math.round(h * 0.25)
  const y1 = Math.round(h * 0.75)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      bmp[i] = 40
      bmp[i + 1] = 150
      bmp[i + 2] = 240
      bmp[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(bmp, { width: w, height: h }).toPNG()
}

function pixelAt(buffer, x, y) {
  const { nativeImage } = require('electron')
  const img = nativeImage.createFromBuffer(buffer)
  const size = img.getSize()
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null
  const bmp = img.toBitmap()
  const i = (y * size.width + x) * 4
  return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]] // R,G,B,A(直通近似,仅用于比较差异)
}

const same = (a, b, tol = 6) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol)
const diff = (a, b) => (a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : 999)

app.whenReady().then(() => {
  try {
    const api = buildBundle()
    const db = api.getDb()
    const session = db.createSession('本地合成验收')
    const ctx = { sessionId: session.id, signal: new AbortController().signal, emit: () => {} }

    // ---- 素材 ----
    const baseBuf = makePatternPng(480, 480)
    const cutoutBuf = makeCutoutPng(200, 200)
    const base = api.saveBufferAsset({ sessionId: session.id, buffer: baseBuf, mime: 'image/png', kind: 'generated' })
    const cutout = api.saveBufferAsset({ sessionId: session.id, buffer: cutoutBuf, mime: 'image/png', kind: 'user-upload' })
    fs.writeFileSync(path.join(SHOTS, 'comp-1-base.png'), baseBuf)
    fs.writeFileSync(path.join(SHOTS, 'comp-2-cutout.png'), cutoutBuf)

    // ---- 1. 贴图 + 调色 + 圆角 ----
    const ret = api.execCompositeImage(ctx, {
      assetId: base.id,
      label: '贴图+调暗+圆角',
      paste: { assetId: cutout.id, to: { x: 0.32, y: 0.32, w: 0.36, h: 0.36 } },
      recolor: { lightness: -0.12, preserveLuma: true },
      corners: { radius: 0.05, stroke: 3, strokeColor: '#111111' }
    })
    record('composite_image 返回成功', ret.ok === true, ret.text.slice(0, 120))
    record('产出 1 张新图', ret.assetIds.length === 1, JSON.stringify(ret.assetIds))

    const outAsset = db.asset(ret.assetIds[0])
    const outBuf = api.readAssetBuffer(outAsset)
    fs.writeFileSync(path.join(SHOTS, 'comp-3-pasted.png'), outBuf)
    record('meta.local = true', outAsset.meta && outAsset.meta.local === true, JSON.stringify(outAsset.meta && outAsset.meta.ops))
    record('成本 0', outAsset.meta && outAsset.meta.cost === 0, String(outAsset.meta && outAsset.meta.cost))
    record('挂着底图做版本链', outAsset.parentId === base.id, String(outAsset.parentId))
    record('尺寸保持', outAsset.width === 480 && outAsset.height === 480, `${outAsset.width}×${outAsset.height}`)

    // 贴图区域中心应该变成橙色系(抠图那块);区域外应保持底色(只是被调暗)
    const center = pixelAt(outBuf, 240, 240)
    const outside = pixelAt(outBuf, 30, 240)
    const baseCenter = pixelAt(baseBuf, 240, 240)
    record('贴图区域被覆盖(中心不再是底图条纹)', diff(center, baseCenter) > 40, `中心 ${center} vs 原 ${baseCenter}`)
    record('贴图区域是抠图颜色(橙)', center[0] > 120 && center[1] > 60 && center[2] < 120, String(center))
    record('区域外仍是底图底色(蓝色通道主导且被调暗)', outside[2] > 150 && outside[0] < 80, String(outside))

    // 圆角:左上角应透明(alpha 明显变小),中心不透明
    const corner = pixelAt(outBuf, 2, 2)
    const inner = pixelAt(outBuf, 240, 240)
    record('圆角生效(角落 alpha 降低)', corner[3] < 200, `角落 alpha=${corner[3]}`)
    record('圆角内仍不透明', inner[3] > 240, `中心 alpha=${inner[3]}`)

    // ---- 2. 坐标网格标注 ----
    const grid = api.execInspectGrid(ctx, { assetId: base.id, cells: 10 })
    record('inspect_grid 成功', grid.ok === true, grid.text.slice(0, 80))
    const gridAsset = db.asset(grid.assetIds[0])
    record('网格是 annotation(不进版本树)', gridAsset.kind === 'annotation', gridAsset.kind)
    const gridBuf = api.readAssetBuffer(gridAsset)
    fs.writeFileSync(path.join(SHOTS, 'comp-4-grid.png'), gridBuf)
    const onLine = pixelAt(gridBuf, 48, 25) // 10 格 → x=48 是第 1 条竖网格线
    const offLine = pixelAt(gridBuf, 60, 25) // x=60,y=25 都不在网格线上
    record('网格线画在 1/10 位置', diff(onLine, pixelAt(baseBuf, 48, 25)) > 20, `${onLine}`)
    record('非网格线保持原图', same(offLine, pixelAt(baseBuf, 60, 25), 12), `${offLine}`)

    // ---- 3. 拼接 ----
    const collage = api.execCompositeImage(ctx, {
      assetId: base.id,
      label: '两张拼一张',
      collage: { assetIds: [base.id, cutout.id], cols: 2, gap: 10, margin: 12, background: '#ffffff' }
    })
    record('collage 成功', collage.ok === true, collage.text.slice(0, 80))
    const collAsset = db.asset(collage.assetIds[0])
    fs.writeFileSync(path.join(SHOTS, 'comp-5-collage.png'), api.readAssetBuffer(collAsset))
    // 单元格尺寸 = max(480,200) = 480 → 宽 = 12*2 + 480*2 + 10 = 994;高 = 12*2+480 = 504
    record('拼接尺寸正确', collAsset.width === 994 && collAsset.height === 504, `${collAsset.width}×${collAsset.height}`)

    // ---- 4. 参数校验 ----
    const empty = api.execCompositeImage(ctx, { assetId: base.id })
    record('空操作被拒绝并说明原因', empty.ok === false && /至少给一个/.test(empty.text), empty.text.slice(0, 60))
    const badRect = api.execCompositeImage(ctx, { assetId: base.id, paste: { assetId: cutout.id, to: { x: 0, y: 0, w: 0, h: 0 } } })
    record('无宽高的贴图矩形被拒绝', badRect.ok === false, badRect.text.slice(0, 60))
    const maskAsBase = api.execInspectGrid(ctx, { assetId: 'asset-not-exist' })
    record('不存在的图给出明确报错', maskAsBase.ok === false && /不存在/.test(maskAsBase.text), maskAsBase.text)

    // ---- 5. 性能 ----
    const t0 = Date.now()
    api.execCompositeImage(ctx, {
      assetId: base.id,
      paste: { assetId: cutout.id, to: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } },
      recolor: { temperature: 0.3 }
    })
    record('整条链路(解码+合成+编码+落盘)< 2s', Date.now() - t0 < 2000, `${Date.now() - t0}ms`)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
    if (failed.length) console.log(failed.map((f) => ' - ' + f.name).join('\n'))
    app.exit(failed.length ? 1 : 0)
  } catch (err) {
    console.log('FAIL  未捕获异常:' + (err && err.stack ? err.stack : String(err)))
    app.exit(1)
  }
})
