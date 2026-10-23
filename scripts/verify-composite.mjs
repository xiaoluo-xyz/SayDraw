// 本地合成内核单测(纯函数,不需要 electron):
//   npm run verify:composite
import {
  alphaBBox,
  autoCutout,
  cloneImage,
  cropImage,
  cutoutWithMask,
  drawGrid,
  expandCanvas,
  fitInside,
  gridImages,
  makeImage,
  normRectToPixels,
  parseColor,
  pasteImage,
  pixelAt,
  recolor,
  roundCorners,
  scaleImage
} from '../src/shared/composite.ts'

let pass = 0
const failures = []

function eq(name, actual, expected, tolerance = 0) {
  const ok =
    typeof expected === 'number'
      ? Math.abs(actual - expected) <= tolerance
      : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    failures.push(`${name}: 期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`)
    console.log(`FAIL  ${name} — 期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`)
  }
}

const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]
const WHITE = [255, 255, 255, 255]

// ---------- 基础 ----------
{
  const img = makeImage(3, 2, RED)
  eq('makeImage 尺寸', [img.width, img.height, img.data.length], [3, 2, 3 * 2 * 4])
  eq('makeImage 填充', pixelAt(img, 2, 1), RED)
  eq('parseColor #fff', parseColor('#fff'), [255, 255, 255, 255])
  eq('parseColor #11223344', parseColor('#11223344'), [17, 34, 51, 68])
  eq('parseColor 非法', parseColor('不是颜色'), null)
}

// ---------- 裁剪(越界收敛) ----------
{
  const img = makeImage(4, 4, RED)
  const cropped = cropImage(img, { x: -2, y: -2, w: 10, h: 10 })
  eq('crop 越界收敛到原图', [cropped.width, cropped.height], [4, 4])
  const small = cropImage(img, { x: 1, y: 1, w: 2, h: 2 })
  eq('crop 正常区域', [small.width, small.height], [2, 2])
}

// ---------- 缩放 ----------
{
  const img = makeImage(2, 2, RED)
  const big = scaleImage(img, 4, 4)
  eq('scale 尺寸', [big.width, big.height], [4, 4])
  eq('scale 颜色保持', pixelAt(big, 3, 3), RED)
  const fit = fitInside(big, 2, 2)
  eq('fitInside 缩小', [fit.width, fit.height], [2, 2])
  const noUpscale = fitInside(img, 8, 8)
  eq('fitInside 默认不放大', [noUpscale.width, noUpscale.height], [2, 2])
}

// ---------- 扩画布 ----------
{
  const img = makeImage(2, 2, RED)
  const wide = expandCanvas(img, 6, 4, BLUE)
  eq('expandCanvas 尺寸', [wide.width, wide.height], [6, 4])
  eq('expandCanvas 拉伸填底', pixelAt(wide, 0, 0), BLUE)
  eq('expandCanvas 居中放置', pixelAt(wide, 2, 1), RED)
  const topLeft = expandCanvas(img, 4, 4, null ?? undefined, 'top-left')
  eq('expandCanvas 左上对齐', pixelAt(topLeft, 0, 0), RED)
}

// ---------- 贴图(alpha 混合是重点) ----------
{
  const dst = makeImage(4, 4, BLUE)
  const src = makeImage(2, 2, RED)
  pasteImage(dst, src, { x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })
  eq('paste 目标区域被覆盖', pixelAt(dst, 2, 2), RED)
  eq('paste 区域外不变', pixelAt(dst, 0, 0), BLUE)

  const half = makeImage(2, 2, BLUE)
  pasteImage(half, src, { x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 2, h: 2 }, { opacity: 0.5 })
  // 红(255,0,0) 压蓝(0,0,255),50% → (128,0,128)
  eq('paste 50% 透明度混合', pixelAt(half, 0, 0), [128, 0, 128, 255], 2)

  const transparent = makeImage(1, 1, [0, 0, 0, 0])
  pasteImage(transparent, src, { x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 1, h: 1 })
  eq('paste 到透明底图', pixelAt(transparent, 0, 0), [255, 0, 0, 255], 2)

  const mult = makeImage(2, 2, [128, 128, 128, 255])
  pasteImage(mult, makeImage(2, 2, WHITE), { x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 2, h: 2 }, { blend: 'multiply' })
  eq('paste multiply 混合', pixelAt(mult, 0, 0), [128, 128, 128, 255], 2)

  const screen = makeImage(2, 2, [128, 0, 0, 255])
  pasteImage(screen, makeImage(2, 2, [128, 0, 0, 255]), { x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 2, h: 2 }, { blend: 'screen' })
  eq('paste screen 混合', pixelAt(screen, 0, 0), [192, 0, 0, 255], 2)
}

// ---------- alphaBBox(自动取主体) ----------
{
  const img = makeImage(6, 6, [0, 0, 0, 0])
  const solid = makeImage(2, 2, RED)
  pasteImage(img, solid, { x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 1, w: 2, h: 2 })
  eq('alphaBBox 找到主体', alphaBBox(img), { x: 2, y: 1, w: 2, h: 2 })
  eq('alphaBBox 全透明返回 null', alphaBBox(makeImage(3, 3, [0, 0, 0, 0])), null)
}

// ---------- 调色 / 局部换色 ----------
{
  const gray = makeImage(2, 2, [100, 100, 100, 255])
  recolor(gray, { lightness: 0.2 })
  eq('recolor 提亮灰度', pixelAt(gray, 0, 0)[0] > 100, true)

  const redHue = makeImage(2, 2, [200, 20, 20, 255])
  recolor(redHue, { hue: 120, preserveLuma: true })
  const [r, g, b] = pixelAt(redHue, 0, 0)
  eq('recolor 红→绿(色相 +120)', g > r && g > b, true)

  const keepLuma = makeImage(1, 1, [200, 20, 20, 255])
  const before = pixelAt(keepLuma, 0, 0).slice(0, 3)
  recolor(keepLuma, { hue: 200, preserveLuma: true })
  const after = pixelAt(keepLuma, 0, 0).slice(0, 3)
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
  eq('recolor preserveLuma 亮度基本不变', Math.abs(lum(after) - lum(before)) < 12, true)

  // 局部:蒙版透明处=生效(与应用蒙版约定一致)
  const masked = makeImage(2, 1, [100, 100, 100, 255])
  const mask = makeImage(2, 1, [255, 255, 255, 255])
  // 右半边透明 = 要改的区域
  mask.data[7] = 0
  recolor(masked, { mask, maskRegion: 'transparent', lightness: 0.3 })
  eq('recolor 只作用于蒙版透明处(左)', pixelAt(masked, 0, 0)[0], 100, 1)
  eq('recolor 只作用于蒙版透明处(右)', pixelAt(masked, 1, 0)[0] > 100, true)
}

// ---------- 圆角 ----------
{
  const img = makeImage(20, 20, RED)
  const rounded = roundCorners(img, 6)
  eq('roundCorners 角落透明', rounded.data[3], 0, 60)
  eq('roundCorners 中心不透明', pixelAt(rounded, 10, 10)[3], 255)
  const withStroke = roundCorners(img, 6, { stroke: 2, strokeColor: [0, 0, 0, 255] })
  const edge = pixelAt(withStroke, 1, 10)
  eq('roundCorners 描边生效', edge[3] > 0 && edge[0] < 120, true)
}

// ---------- 网格 / 拼接 ----------
{
  const img = makeImage(40, 40, WHITE)
  drawGrid(img, { cells: 10 })
  const onLine = pixelAt(img, 0, 20)
  const offLine = pixelAt(img, 5, 5)
  eq('drawGrid 网格线着色', onLine[0] < 255 || onLine[1] < 255, true)
  eq('drawGrid 非网格线保持', offLine, WHITE)

  const a = makeImage(4, 4, RED)
  const b = makeImage(4, 4, BLUE)
  const grid = gridImages([a, b], { cols: 2, gap: 2, margin: 2, background: WHITE })
  // 2 列:2 + 4 + 2 + 4 + 2 = 14;1 行:2 + 4 + 2 = 8
  eq('gridImages 尺寸', [grid.width, grid.height], [14, 8])
  eq('gridImages 边距是底色', pixelAt(grid, 0, 0), WHITE)
  eq('gridImages 第一格', pixelAt(grid, 3, 3), RED)
  eq('gridImages 第二格', pixelAt(grid, 9, 3), BLUE)
}

// ---------- 归一化坐标 ----------
{
  const px = normRectToPixels({ x: 0.5, y: 0.25, w: 0.5, h: 0.5 }, 200, 100)
  eq('normRectToPixels', px, { x: 100, y: 25, w: 100, h: 50 })
}

// ---------- 大图性能(512² 贴图 + 调色,回归用) ----------
{
  const base = makeImage(512, 512, [30, 30, 40, 255])
  const layer = makeImage(128, 128, [255, 200, 0, 200])
  const t0 = performance.now()
  pasteImage(base, layer, { x: 0, y: 0, w: 128, h: 128 }, { x: 64, y: 64, w: 256, h: 256 })
  recolor(base, { temperature: 0.2, contrast: 1.05 })
  const ms = performance.now() - t0
  eq('512² 贴图+调色耗时 < 400ms', ms < 400, true)
  console.log(`      实测 ${ms.toFixed(1)}ms`)
}

// ---------- 抠图:自动去背景 ----------
{
  // 200×200 深灰底,中间 100×100 浅色主体(模拟"产品图/纯色背景")
  const img = makeImage(200, 200, [30, 30, 30, 255])
  for (let y = 50; y < 150; y++) for (let x = 50; x < 150; x++) {
    const i = (y * 200 + x) * 4
    img.data[i] = 220
    img.data[i + 1] = 220
    img.data[i + 2] = 210
  }
  const res = autoCutout(img)
  eq('自动抠图:主体中心保留', res.image.data[(100 * 200 + 100) * 4 + 3], 255, 0)
  eq('自动抠图:四角去掉', res.image.data[3], 0)
  eq('自动抠图:前景占比≈25%', res.coverage, 0.25, 0.02)
  eq('自动抠图:干净背景判定', res.borderSpread < 1, true)

  const white = autoCutout(img, { background: '#ffffff' })
  eq('自动抠图:白底不透明', [white.image.data[3], white.image.data[(100 * 200 + 100) * 4 + 3]], [255, 255])
  eq('自动抠图:白底铺满角落', pixelAt(white.image, 2, 2), WHITE)

  const trimmed = autoCutout(img, { trim: true })
  // 主体 100px + 两侧各 2% 边距(200*0.02=4px)→ 约 108px
  eq('自动抠图:裁紧到主体+边距', Math.abs(trimmed.image.width - 108) <= 4, true)
  eq('自动抠图:裁紧标记', trimmed.trimmed, true)

  // 铺了底色也要能裁紧(裁切框按 alpha 算,不看铺底后的不透明度)
  const trimmedWhite = autoCutout(img, { trim: true, background: '#ffffff' })
  eq('自动抠图:白底也能裁紧', Math.abs(trimmedWhite.image.width - 108) <= 4, true)
  eq('自动抠图:白底裁紧后仍铺满底色', pixelAt(trimmedWhite.image, 1, 1), WHITE)
}

// 渐变背景也能走通(靠"相邻像素差"而不是"和背景色比")
{
  const img = makeImage(200, 200)
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      const i = (y * 200 + x) * 4
      const v = 40 + Math.round((x / 200) * 60) // 40→100 的横向渐变
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  for (let y = 60; y < 140; y++) for (let x = 60; x < 140; x++) {
    const i = (y * 200 + x) * 4
    img.data[i] = 245
    img.data[i + 1] = 245
    img.data[i + 2] = 245
  }
  const res = autoCutout(img)
  eq('渐变背景:主体保留', res.image.data[(100 * 200 + 100) * 4 + 3], 255, 0)
  eq('渐变背景:两端都去掉', [res.image.data[3], res.image.data[(100 * 200 + 195) * 4 + 3]], [0, 0])
}

// 碎斑点(背景噪点)不应被当成主体
{
  const img = makeImage(120, 120, [20, 20, 20, 255])
  for (let y = 30; y < 90; y++) for (let x = 30; x < 90; x++) {
    const i = (y * 120 + x) * 4
    img.data[i] = 200
    img.data[i + 1] = 200
    img.data[i + 2] = 200
  }
  // 角落一颗孤立的亮斑
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) {
    const i = (y * 120 + x) * 4
    img.data[i] = 250
    img.data[i + 1] = 250
    img.data[i + 2] = 250
  }
  const res = autoCutout(img)
  eq('孤立亮斑被丢掉', res.image.data[(4 * 120 + 4) * 4 + 3], 0)
}

// ---------- 抠图:按蒙版切原图(像素保真路线) ----------
{
  // 原图:左半红、右半蓝
  const src = makeImage(100, 100)
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 100; x++) {
      const i = (y * 100 + x) * 4
      const left = x < 50
      src.data[i] = left ? 255 : 0
      src.data[i + 1] = 0
      src.data[i + 2] = left ? 0 : 255
      src.data[i + 3] = 255
    }
  // 蒙版:白 = 保留(左半);黑 = 去掉
  const mask = makeImage(100, 100, [0, 0, 0, 255])
  for (let y = 10; y < 90; y++)
    for (let x = 10; x < 50; x++) {
      const i = (y * 100 + x) * 4
      mask.data[i] = 255
      mask.data[i + 1] = 255
      mask.data[i + 2] = 255
    }
  const res = cutoutWithMask(src, mask, { featherPx: 0 })
  eq('按蒙版:保留区像素仍是原图红', pixelAt(res.image, 30, 50), [255, 0, 0, 255])
  eq('按蒙版:被去掉区透明', pixelAt(res.image, 70, 50)[3], 0)
  eq('按蒙版:前景占比≈32%', res.coverage, 0.32, 0.02)

  // 白框黑心(反色蒙版):默认按「白=保留」,取到的是白框 → 内部黑块被当成洞补回 → 几乎整张不透明
  const inv = makeImage(100, 100, [255, 255, 255, 255])
  for (let y = 10; y < 90; y++)
    for (let x = 10; x < 50; x++) {
      const i = (y * 100 + x) * 4
      inv.data[i] = 0
      inv.data[i + 1] = 0
      inv.data[i + 2] = 0
    }
  const res2 = cutoutWithMask(src, inv, { featherPx: 0 })
  eq('按蒙版:默认极性=白保留', res2.coverage, 1, 0.01)

  // 显式取反后才保留黑块区域
  const res3 = cutoutWithMask(src, inv, { featherPx: 0, invertMask: true })
  eq('按蒙版:invertMask 取反', [pixelAt(res3.image, 30, 50)[3], pixelAt(res3.image, 80, 50)[3]], [255, 0])
  eq('按蒙版:取反后占比≈32%', res3.coverage, 0.32, 0.02)

  // 白底输出 + 裁紧
  const filled = cutoutWithMask(src, mask, { featherPx: 0, background: '#ffffff' })
  eq('按蒙版:白底铺底', pixelAt(filled.image, 70, 50), WHITE)
  const cropped = cutoutWithMask(src, mask, { featherPx: 0, trim: true })
  eq('按蒙版:裁紧到主体', cropped.image.width < 100 && cropped.image.height < 100, true)

  // 羽化:边缘出现半透明过渡(不是硬边)
  const soft = cutoutWithMask(src, mask)
  const edge = pixelAt(soft.image, 9, 50)[3]
  eq('按蒙版:羽化产生过渡像素', edge > 0 && edge < 255, true)
}

// 蒙版尺寸与原图不同也要能对上(模型出的蒙版常常是别的分辨率)
{
  const src = makeImage(200, 200, [10, 200, 10, 255])
  const mask = makeImage(50, 50, [255, 255, 255, 255])
  for (let y = 0; y < 10; y++) for (let x = 0; x < 50; x++) {
    const i = (y * 50 + x) * 4
    mask.data[i] = 0
    mask.data[i + 1] = 0
    mask.data[i + 2] = 0
  }
  const res = cutoutWithMask(src, mask, { featherPx: 0 })
  eq('蒙版缩放:上部去掉', pixelAt(res.image, 100, 10)[3], 0)
  eq('蒙版缩放:下部保留', pixelAt(res.image, 100, 190)[3], 255)
}

// 软投影不该被当成主体(真实产品照最常见:主体旁边一片柔和阴影)
// 机制:阴影过渡是"软"的(梯度低)→ 泛洪能穿过并删掉;主体边界是"硬"的(梯度高)→ 挡住
{
  const img = makeImage(200, 200, [200, 200, 200, 255])
  // 主体:深色方块(硬边)
  for (let y = 60; y < 140; y++) for (let x = 50; x < 130; x++) {
    const i = (y * 200 + x) * 4
    img.data[i] = 40
    img.data[i + 1] = 40
    img.data[i + 2] = 40
  }
  // 主体右侧的柔光投影:从左到右 150 → 200 的线性渐变(每像素只差 ~1)
  for (let y = 60; y < 140; y++) for (let x = 130; x < 190; x++) {
    const v = Math.round(150 + ((x - 130) / 60) * 50)
    const i = (y * 200 + x) * 4
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
  }
  const res = autoCutout(img)
  eq('软投影:主体保留', pixelAt(res.image, 90, 100)[3], 255)
  eq('软投影:投影被去掉', pixelAt(res.image, 160, 100)[3], 0)
  eq('软投影:背景去掉', pixelAt(res.image, 10, 10)[3], 0)
  eq('软投影:前景占比≈16%', res.coverage, 0.16, 0.04)
}

// 抠图性能(2000×2000 真实尺寸量级)
{
  const img = makeImage(2000, 2000, [25, 25, 25, 255])
  for (let y = 400; y < 1600; y++) for (let x = 400; x < 1600; x++) {
    const i = (y * 2000 + x) * 4
    img.data[i] = 235
    img.data[i + 1] = 232
    img.data[i + 2] = 225
  }
  const t0 = performance.now()
  const res = autoCutout(img)
  const ms = performance.now() - t0
  eq('2000² 自动抠图 < 2500ms', ms < 2500, true)
  eq('2000² 抠图结果可用', res.coverage > 0.3 && res.coverage < 0.4, true)
  console.log(`      实测 ${ms.toFixed(0)}ms · 前景 ${(res.coverage * 100).toFixed(1)}%`)
}

console.log(`\n==== ${pass}/${pass + failures.length} 通过 ====`)
if (failures.length) {
  console.log(failures.map((f) => ' - ' + f).join('\n'))
  process.exit(1)
}
