// 保真改图内核单测(纯函数,不联网、不调生图)
//   npm run verify:fidelity
//
// 覆盖:
//   A. paintRegion —— 只改选中像素、几何零变化、徽标可排除、保留明暗
//   A2. albedo 换色 —— 暗部变目标色、高光保留率、蒙版外不动、maskGrow
//   B. applyEditGuard —— 区域外逐像素等于基线、位移/重绘判可疑、自动护栏、尺寸不一致
//   C. compareWithBaseline —— 区域外改动统计、边界锚定、差异热图
//   D. 性能与大体量兜底
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const posix = (p) => p.replace(/\\/g, '/')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saydraw-fidelity-'))
const entry = path.join(tmp, 'entry.ts')
fs.writeFileSync(
  entry,
  `export * from '${posix(path.join(ROOT, 'src/shared/fidelity'))}'\nexport * from '${posix(path.join(ROOT, 'src/shared/composite'))}'\n`,
  'utf8'
)
const outfile = path.join(tmp, 'bundle.mjs')
buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning'
})
const {
  applyEditGuard,
  compareWithBaseline,
  paintRegion,
  guardSummary,
  makeImage,
  pixelAt,
  scaleImage
} = await import(pathToFileURL(outfile).href)

let pass = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name + (detail ? ` (${detail})` : ''))
    console.log(`FAIL  ${name}${detail ? '  - ' + detail : ''}`)
  }
}
function eq(name, actual, expected, tolerance = 0) {
  const ok =
    typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected) <= tolerance
      : JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, typeof expected === 'number' ? `期望 ${expected}±${tolerance} 实得 ${actual}` : '')
}

// ---------- 合成素材:黑色键盘 + 白色键帽 + 金色徽标 ----------
const BODY = [26, 26, 30]
const CAP = [242, 240, 233]
const BADGE = [206, 158, 62]
const W = 480
const H = 300

function rect(img, x, y, w, h, rgba) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue
      const i = (yy * img.width + xx) * 4
      img.data[i] = rgba[0]
      img.data[i + 1] = rgba[1]
      img.data[i + 2] = rgba[2]
      img.data[i + 3] = rgba[3] ?? 255
    }
  }
}

function circle(img, cx, cy, r, rgba) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
      const i = (y * img.width + x) * 4
      img.data[i] = rgba[0]
      img.data[i + 1] = rgba[1]
      img.data[i + 2] = rgba[2]
      img.data[i + 3] = 255
    }
  }
}

/** 键帽区 */
const CAPS = { x: 0.08, y: 0.18, w: 0.84, h: 0.72 }
function makeKeyboard() {
  const img = makeImage(W, H, [BODY[0], BODY[1], BODY[2], 255])
  // 外壳高光/阴影,方便验"保留明暗"
  rect(img, 0, 0, W, 18, [34, 34, 38])
  rect(img, 0, H - 22, W, 22, [18, 18, 21])
  // 金色徽标(平贴在壳体上,不是键帽)
  circle(img, 44, 40, 16, BADGE)
  circle(img, 44, 40, 8, [120, 86, 28])
  // 8x4 白色键帽,带轻微上亮下暗
  let n = 0
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 8; col++) {
      const cx = 34 + col * 53
      const cy = 78 + row * 48
      rect(img, cx, cy, 44, 36, CAP)
      rect(img, cx, cy, 44, 6, [250, 249, 245])
      rect(img, cx, cy + 30, 44, 6, [226, 224, 217])
      n++
    }
  }
  return { img, caps: n * 44 * 36 }
}
const base = makeKeyboard().img

function diffCount(a, b) {
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++
  }
  return n
}

function outsideDiffCount(img, baseline, rectNorm) {
  let n = 0
  for (let y = 0; y < baseline.height; y++) {
    for (let x = 0; x < baseline.width; x++) {
      const inside =
        x >= rectNorm.x * baseline.width &&
        x < (rectNorm.x + rectNorm.w) * baseline.width &&
        y >= rectNorm.y * baseline.height &&
        y < (rectNorm.y + rectNorm.h) * baseline.height
      if (inside) continue
      const i = (y * baseline.width + x) * 4
      if (
        img.data[i] !== baseline.data[i] ||
        img.data[i + 1] !== baseline.data[i + 1] ||
        img.data[i + 2] !== baseline.data[i + 2]
      )
        n++
    }
  }
  return n
}

function insideDiffCount(img, baseline, rectNorm) {
  let n = 0
  for (let y = 0; y < baseline.height; y++) {
    for (let x = 0; x < baseline.width; x++) {
      const inside =
        x >= rectNorm.x * baseline.width &&
        x < (rectNorm.x + rectNorm.w) * baseline.width &&
        y >= rectNorm.y * baseline.height &&
        y < (rectNorm.y + rectNorm.h) * baseline.height
      if (!inside) continue
      const i = (y * baseline.width + x) * 4
      if (
        img.data[i] !== baseline.data[i] ||
        img.data[i + 1] !== baseline.data[i + 1] ||
        img.data[i + 2] !== baseline.data[i + 2]
      )
        n++
    }
  }
  return n
}

/** 某点 RGB 是否与另一张图完全一致(忽略 alpha) */
function samePixel(a, ax, ay, b, bx = ax, by = ay) {
  const i = (ay * a.width + ax) * 4
  const j = (by * b.width + bx) * 4
  return a.data[i] === b.data[j] && a.data[i + 1] === b.data[j + 1] && a.data[i + 2] === b.data[j + 2]
}

// ---------- A. paintRegion ----------
{
  const res = paintRegion(base, { target: '#1a1a1e', color: '#f2f0e9', tolerance: 40 })
  const cap = pixelAt(res.image, 56, 96)
  const body = pixelAt(res.image, 430, 20)
  check('paint 键帽变成目标色', Math.abs(cap[0] - 0x1a) <= 4 && Math.abs(cap[2] - 0x1e) <= 4, `cap=${cap}`)
  check('paint 壳体像素逐像素不变', body[0] === BODY[0] && body[1] === BODY[1] && body[2] === BODY[2], `body=${body}`)
  check('paint 报告命中像素数', res.report.painted > 3000, `painted=${res.report.painted}`)
  check(
    'paint 只改动了原图发白的像素(徽标没被连坐)',
    samePixel(res.image, 44, 40, base),
    `badge=${pixelAt(res.image, 44, 40)} base=${pixelAt(base, 44, 40)}`
  )

  // region + exclude:徽标在自己那块里,把它排除掉
  const ex = paintRegion(base, {
    target: '#202024',
    color: '#f2f0e9',
    tolerance: 60,
    region: { x: 0, y: 0, w: 0.3, h: 0.4 },
    exclude: [{ x: 0, y: 0, w: 0.15, h: 0.2 }]
  })
  check('paint exclude 生效(排除块内零改动)', insideDiffCount(ex.image, base, { x: 0, y: 0, w: 0.15, h: 0.2 }) === 0)
  check('paint region 生效(区域外零改动)', outsideDiffCount(ex.image, base, { x: 0, y: 0, w: 0.3, h: 0.4 }) === 0)

  // targetFrom:从壳体取样 = 壳体颜色
  const fromBody = paintRegion(base, { targetFrom: { x: 0.9, y: 0.15 }, color: '#f2f0e9', tolerance: 40 })
  const picked = pixelAt(fromBody.image, 56, 96)
  check('paint targetFrom 取样 = 壳体颜色', Math.abs(picked[0] - 26) <= 3, `cap=${picked}`)

  // 选不中(bad color + 小容差)→ 零改动
  const none = paintRegion(base, { target: '#ff0000', color: '#0000ff', tolerance: 4 })
  check('paint 选不中时零改动', none.report.painted === 0 && diffCount(base, none.image) === 0)

  // 蒙版语义:user = 透明处可改
  const mask = makeImage(W, H, [0, 0, 0, 0])
  rect(mask, 300, 80, 120, 160, [0, 0, 0, 255]) // 不透明 = 别动
  const masked = paintRegion(base, { target: '#ff0000', mask, maskKind: 'user', strength: 1 })
  check('paint 蒙版语义:透明处被改', pixelAt(masked.image, 56, 96)[0] > 200, `cap=${pixelAt(masked.image, 56, 96)}`)
  check(
    'paint 蒙版语义:不透明处不动',
    pixelAt(masked.image, 360, 200).join(',') === pixelAt(base, 360, 200).join(','),
    `px=${pixelAt(masked.image, 360, 200)}`
  )
}

// ---------- A2. albedo:换的是材质颜色,不是盖一层 ----------
{
  const alb = paintRegion(base, { target: '#2a2b30', color: '#f2f0e9', tolerance: 40, mode: 'albedo' })
  const capTop = pixelAt(alb.image, 56, 96)
  check('albedo 键帽接近目标色', Math.abs(capTop[0] - 42) <= 8 && Math.abs(capTop[2] - 48) <= 8, `cap=${capTop}`)
  check('albedo 报告模式', alb.report.mode === 'albedo')
  check('albedo 报告白点(线性 ≤1)', Boolean(alb.report.whitePoint) && alb.report.whitePoint.every((v) => v > 0 && v <= 1))
  check(
    'albedo 亮面仍比暗面亮(明暗没被抹平)',
    (() => {
      const top = pixelAt(alb.image, 56, 82)[0]
      const bottom = pixelAt(alb.image, 56, 108)[0]
      return top > bottom + 2
    })(),
    `top=${pixelAt(alb.image, 56, 82)[0]} bottom=${pixelAt(alb.image, 56, 108)[0]}`
  )

  // shade 模式会把高光一起压掉(旧行为)
  const oldShade = paintRegion(base, { target: '#2a2b30', color: '#f2f0e9', tolerance: 40, mode: 'shade' })
  check('shade 模式会压暗暗面', pixelAt(oldShade.image, 56, 108)[0] < 120)

  // 蒙版:只改左半边,右半边逐像素等于基线
  const half = makeImage(W, H, [0, 0, 0, 255])
  rect(half, 0, 0, Math.round(W / 2), H, [255, 255, 255, 255])
  const halfPaint = paintRegion(base, { target: '#2a2b30', mask: half, maskKind: 'image', mode: 'albedo' })
  check(
    'albedo 蒙版外不动',
    samePixel(halfPaint.image, 430, 20, base) && pixelAt(halfPaint.image, 56, 96)[0] < 80,
    `body=${pixelAt(halfPaint.image, 430, 20)} cap=${pixelAt(halfPaint.image, 56, 96)}`
  )

  // maskGrow:模型只画到键帽顶面,侧壁要一起包进来
  const tight = makeImage(W, H, [0, 0, 0, 255])
  rect(tight, 40, 84, 32, 24, [255, 255, 255, 255])
  const flat = paintRegion(base, { target: '#2a2b30', mask: tight, maskKind: 'image', mode: 'albedo' })
  const grown = paintRegion(base, { target: '#2a2b30', mask: tight, maskKind: 'image', mode: 'albedo', growPx: 5 })
  check('maskGrow 扩大改写范围', grown.report.painted > flat.report.painted, `${flat.report.painted} -> ${grown.report.painted}`)
  check('maskGrow 约等于外扩 5px', grown.report.painted >= 1400 && grown.report.painted <= 2800, `painted=${grown.report.painted}`)
  const edge = pixelAt(grown.image, 76, 96)
  check('maskGrow 越过原蒙版边界(侧壁被盖住)', edge[0] < 120, `edge=${edge}`)
  check('maskGrow 不影响远处像素', samePixel(grown.image, 300, 20, base))
}

// ---------- B. applyEditGuard ----------
{
  // 模型"乱改":键位整体横移 9px + 区域外涂抹(模拟改 A 顺手改了 B)
  const edited = { width: W, height: H, data: new Uint8Array(base.data) }
  for (let y = 60; y < 280; y++) {
    for (let x = 40; x < 456; x++) {
      const src = (y * W + Math.max(0, x - 9)) * 4
      const dst = (y * W + x) * 4
      edited.data[dst] = base.data[src]
      edited.data[dst + 1] = base.data[src + 1]
      edited.data[dst + 2] = base.data[src + 2]
    }
  }
  rect(edited, 0, 0, 40, 40, [255, 0, 255]) // 区域外破坏

  const guarded = applyEditGuard(base, edited, { region: CAPS, featherPx: 4, baselineAssetId: 'asset-origin' })
  const r = guarded.report
  eq('guard 区域外逐像素等于基线', outsideDiffCount(guarded.image, base, CAPS), 0)
  eq('guard 报告:交付图区域外改动为 0', r.deliveredOutsideChangedRatio, 0)
  check('guard 报告:模型区域外改动被记录', r.modelOutsideChangedRatio > 0.005, `ratio=${r.modelOutsideChangedRatio}`)
  check(
    'guard 报告:位移被量化(锚定下降 + 出现新边界)',
    (r.edgeAnchor ?? 1) < 0.8 && r.newEdgeRatio > 0.1,
    `anchor=${r.edgeAnchor} new=${r.newEdgeRatio}`
  )
  check('guard 报告:区域内确实改了', r.insideChangedRatio > 0.2, `inside=${r.insideChangedRatio}`)
  check('guard 报告:基线 ID 传入', r.baselineAssetId === 'asset-origin')

  // 整块重绘(随机纹理)→ 判可疑
  const redraw = { width: W, height: H, data: new Uint8Array(base.data) }
  for (let y = 60; y < 260; y++) {
    for (let x = 40; x < 450; x++) {
      const o = (y * W + x) * 4
      const v = (x * 37 + y * 91) % 255
      redraw.data[o] = v
      redraw.data[o + 1] = 255 - v
      redraw.data[o + 2] = (v * 3) % 255
    }
  }
  const redrawGuard = applyEditGuard(base, redraw, { region: CAPS })
  check('guard 整块重绘 → 判可疑', redrawGuard.report.verdict === 'suspect', redrawGuard.report.verdict)
  check('guard 重绘也给得出锚定率', (redrawGuard.report.edgeAnchor ?? 0) > 0, `anchor=${redrawGuard.report.edgeAnchor}`)

  // mask 语义(user 蒙版):蒙版外逐像素不动
  const userMask = makeImage(W, H, [0, 0, 0, 255])
  rect(userMask, 40, 70, 400, 190, [0, 0, 0, 0]) // 透明 = 允许改
  const maskGuard = applyEditGuard(base, edited, { mask: userMask, maskKind: 'user' })
  check('guard 蒙版外逐像素等于基线', outsideDiffCount(maskGuard.image, base, { x: 0.08, y: 0.23, w: 0.83, h: 0.64 }) === 0)
  check('guard 蒙版覆盖率合理', maskGuard.report.allowedCoverage > 0.4, `cov=${maskGuard.report.allowedCoverage}`)

  // 尺寸不一致(模型返回半尺寸):自动缩放回基线尺寸
  const halfSize = scaleImage(edited, W / 2, H / 2)
  const sizeGuard = applyEditGuard(base, halfSize, { region: CAPS, featherPx: 2 })
  check(
    'guard 尺寸不一致自动对齐',
    sizeGuard.image.width === W && sizeGuard.image.height === H && sizeGuard.report.sizeMatched === false
  )
  check('guard summary 可读', guardSummary(sizeGuard.report).includes('区域外'))

  // 区域内也没变化 → 报告能看出来
  const untouched = applyEditGuard(base, base, { region: CAPS })
  eq('guard 同图:区域内改动 0', untouched.report.insideChangedRatio, 0)
  eq('guard 同图:交付=基线', diffCount(untouched.image, base), 0)
}

// ---------- B2. 自动护栏:不给选区,只留成片改动、还原零散噪点 ----------
{
  // 模型干了三件事:
  //   1. 把键帽区整片改成深色(成片改动,要留下)
  //   2. 背景散布孤立噪点(x%3==0 && y%3==0,每个 1px,要还原)
  //   3. 左下角一小块成片改动(小于 minIslandShare,应该被还原)
  const edited = { width: W, height: H, data: new Uint8Array(base.data) }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const nx = x / W
      const ny = y / H
      const inCaps = nx >= CAPS.x && nx < CAPS.x + CAPS.w && ny >= CAPS.y && ny < CAPS.y + CAPS.h
      if (inCaps) {
        edited.data[i] = Math.round(base.data[i] * 0.18)
        edited.data[i + 1] = Math.round(base.data[i + 1] * 0.18)
        edited.data[i + 2] = Math.round(base.data[i + 2] * 0.18)
      } else if (x % 3 === 0 && y % 3 === 0) {
        // 亮处变暗、暗处变亮:保证 ±14 在任何底色上都真的改变了像素
        const d = base.data[i] > 120 ? -14 : 14
        edited.data[i] = Math.max(0, Math.min(255, base.data[i] + d))
        edited.data[i + 1] = Math.max(0, Math.min(255, base.data[i + 1] + d))
        edited.data[i + 2] = Math.max(0, Math.min(255, base.data[i + 2] + d))
      }
    }
  }
  rect(edited, 20, 200, 3, 3, [255, 255, 255]) // 9px 孤立小块:远小于 minIslandShare,应该被还原

  const auto = applyEditGuard(base, edited, { auto: true, featherPx: 2 })
  const g = auto.report.autoGuard
  check('auto 护栏:给出了连通块统计', Boolean(g), JSON.stringify(g))
  check('auto 护栏:留下了键帽那片改动', Boolean(g) && g.kept >= 1 && g.keptCoverage > 0.5, JSON.stringify(g))
  check('auto 护栏:还原了零散噪点', Boolean(g) && g.revertedShare > 0.05, `reverted=${g && g.revertedShare}`)
  eq('auto 护栏:报告里区域外改动为 0', auto.report.deliveredOutsideChangedRatio, 0)
  check('auto 护栏:note 说清了留几片', auto.report.note.includes('自动护栏'), auto.report.note)
  check('auto 护栏:孤立小块被还原', samePixel(auto.image, 21, 201, base), `px=${pixelAt(auto.image, 21, 201)}`)

  const capsPx = (() => {
    const x = Math.round((CAPS.x + CAPS.w / 2) * W)
    const y = Math.round((CAPS.y + CAPS.h / 2) * H)
    const i = (y * W + x) * 4
    return [
      auto.image.data[i],
      auto.image.data[i + 1],
      auto.image.data[i + 2],
      edited.data[i],
      edited.data[i + 1],
      edited.data[i + 2]
    ]
  })()
  check(
    'auto 护栏:键帽中心用的是模型像素',
    capsPx[0] === capsPx[3] && capsPx[1] === capsPx[4] && capsPx[2] === capsPx[5],
    capsPx.join(',')
  )

  // 所有"跟基线不同"的像素都必须落在键帽区附近(外扩 4px + 羽化 2px + 取整)
  const margin = 12
  let stray = 0
  let changedTotal = 0
  let straySample = ''
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (
        auto.image.data[i] === base.data[i] &&
        auto.image.data[i + 1] === base.data[i + 1] &&
        auto.image.data[i + 2] === base.data[i + 2]
      )
        continue
      changedTotal++
      const nearCaps =
        x >= CAPS.x * W - margin &&
        x <= (CAPS.x + CAPS.w) * W + margin &&
        y >= CAPS.y * H - margin &&
        y <= (CAPS.y + CAPS.h) * H + margin
      if (!nearCaps) {
        // 掩码重采样会把 0 变成 0.002 这种权重,合成后可能差 ±1(肉眼不可见);差 ≥2 才算"改到了"
        const d = Math.max(
          Math.abs(auto.image.data[i] - base.data[i]),
          Math.abs(auto.image.data[i + 1] - base.data[i + 1]),
          Math.abs(auto.image.data[i + 2] - base.data[i + 2])
        )
        if (d <= 1) continue
        stray++
        if (stray <= 4) straySample += `${x},${y}:${d} ; `
      }
    }
  }
  eq('auto 护栏:没有像素改到键帽区外', stray, 0, straySample)
  check('auto 护栏:确实交付了模型改动', changedTotal > 0.4 * W * H, `changed=${changedTotal}`)

  let noiseReverted = true
  let noiseChecked = 0
  for (let y = 0; y < 40; y++) {
    for (let x = 300; x < 470; x++) {
      if (x % 3 !== 0 || y % 3 !== 0) continue
      const i = (y * W + x) * 4
      if (edited.data[i] === base.data[i]) continue
      noiseChecked++
      if (auto.image.data[i] !== base.data[i]) noiseReverted = false
    }
  }
  check('auto 护栏:背景噪点逐像素还原', noiseReverted && noiseChecked > 500, `checked=${noiseChecked}`)

  // 显式给矩形时不做自动裁块(report 里没有 autoGuard)
  const explicit = applyEditGuard(base, edited, { region: CAPS, featherPx: 2 })
  check('auto 关闭时仍是旧的 region 行为', explicit.report.autoGuard === undefined)
}

// ---------- C. compareWithBaseline ----------
{
  const same = compareWithBaseline(base, base, { region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } })
  eq('compare 同图:区域外改动 0', same.report.deliveredOutsideChangedRatio, 0)
  eq('compare 同图:区域内改动 0', same.report.insideChangedRatio, 0)
  check('compare 同图:锚定满分', (same.report.edgeAnchor ?? 0) > 0.99)

  const shifted = { width: W, height: H, data: new Uint8Array(W * H * 4) }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = (y * W + ((x + 12) % W)) * 4
      const dst = (y * W + x) * 4
      shifted.data[dst] = base.data[src]
      shifted.data[dst + 1] = base.data[src + 1]
      shifted.data[dst + 2] = base.data[src + 2]
      shifted.data[dst + 3] = 255
    }
  }
  const shiftedCmp = compareWithBaseline(base, shifted, { region: { x: 0, y: 0, w: 1, h: 1 }, heatmap: true })
  check('compare 整图位移:锚定明显下降', (shiftedCmp.report.edgeAnchor ?? 1) < 0.75, `anchor=${shiftedCmp.report.edgeAnchor}`)
  check('compare 整图位移:判可疑', shiftedCmp.report.verdict === 'suspect')
  check(
    'compare 热图尺寸与内容',
    shiftedCmp.heatmap.width > 0 && shiftedCmp.heatmap.data.length === shiftedCmp.heatmap.width * shiftedCmp.heatmap.height * 4
  )

  // 区域外只改一小块 → 能报出聚集位置
  const spot = { width: W, height: H, data: new Uint8Array(base.data) }
  rect(spot, 400, 10, 60, 30, [0, 255, 255])
  const spotCmp = compareWithBaseline(base, spot, { region: CAPS })
  check('compare 报出区域外聚集块', spotCmp.report.outsideRegions.length >= 1, `n=${spotCmp.report.outsideRegions.length}`)
  check(
    'compare 聚集块位置正确(右上)',
    spotCmp.report.outsideRegions[0].x > 0.6 && spotCmp.report.outsideRegions[0].y < 0.2,
    JSON.stringify(spotCmp.report.outsideRegions[0])
  )
}

// ---------- D. 性能 ----------
{
  const big = makeImage(1600, 1200, [30, 30, 34, 255])
  for (let y = 200; y < 1000; y += 60) rect(big, 200, y, 1200, 40, [240, 238, 232, 255])
  let t = Date.now()
  const painted = paintRegion(big, { target: '#2a2b30', color: '#f0eee8', tolerance: 50, mode: 'albedo' })
  const paintMs = Date.now() - t
  const edited = { width: big.width, height: big.height, data: new Uint8Array(painted.image.data) }
  t = Date.now()
  const guarded = applyEditGuard(big, edited, { auto: true })
  const guardMs = Date.now() - t
  console.log(`     1600×1200: paint ${paintMs}ms / guard ${guardMs}ms`)
  check('1600×1200 换色 < 2000ms', paintMs < 2000, `${paintMs}ms`)
  check('1600×1200 护栏 < 4000ms', guardMs < 4000, `${guardMs}ms`)
  check('大图结果尺寸正确', guarded.image.width === 1600 && guarded.image.height === 1200)
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(' - ' + f)
  process.exit(1)
}
