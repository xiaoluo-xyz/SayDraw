// 验证「大图内联压缩 + 请求体预算 + 失败落痕」这套修复。全程在系统临时目录里跑,不碰用户数据。
//
// 用法(两个终端):
//   ① node scripts/mock-server.mjs
//   ② node_modules\.bin\electron scripts\verify-fix.cjs
//
// 验证内容:
//   1. 真实大图(8192×6144 实拍 JPEG ≈20MB)压缩前后对比
//   2. 端到端:会话里带 7 张图跑一轮,量出真实请求体体积(修复前 ≈90MB)
//   3. 请求体预算:9 张"免重编码"的图合计超预算时,只带最新的,旧图在文本里留痕
//   4. 蒙版/透明图:保透明、平色图原样直传、超大图仍压进上限
//   5. 超时语义:持续输出不算超时,真静默才超时
//   6. 失败落痕:上游 500 时,一个字都没产出也要落一条带原因的消息

const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MOCK = 'http://127.0.0.1:3117'
const ROOT = path.resolve(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)}MB`
const posix = (p) => p.replace(/\\/g, '/')

// 隔离运行:userData / 缓存全部指向临时目录
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saydraw-verify-'))
app.setPath('userData', path.join(tmpRoot, 'userData'))
app.setPath('sessionData', path.join(tmpRoot, 'sessionData'))
app.setPath('cache', path.join(tmpRoot, 'cache'))

/** 用 esbuild 把主进程源码打成一个 CJS bundle,便于在 Electron 里直接调用内部函数 */
function buildBundle() {
  const dir = path.join(tmpRoot, 'bundle')
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(ROOT, 'src', 'main')
  const entry = path.join(dir, 'entry.ts')
  fs.writeFileSync(
    entry,
    [
      `export { runAgentTurn, planInline, INLINE_BUDGET_BYTES } from '${posix(path.join(src, 'agent/loop'))}'`,
      `export { getDb } from '${posix(path.join(src, 'store/db'))}'`,
      `export { getSettings } from '${posix(path.join(src, 'store/settings'))}'`,
      `export { saveBufferAsset, assetAbsolutePath } from '${posix(path.join(src, 'store/assets'))}'`,
      `export { prepareInlineImageFromFile } from '${posix(path.join(src, 'store/inlineImage'))}'`
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

// ---------- 造图 ----------

let noiseCache = null
function noiseBitmap(size) {
  if (noiseCache && noiseCache.size === size) return noiseCache.bitmap
  const bitmap = Buffer.alloc(size * size * 4)
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = (Math.random() * 256) | 0
    bitmap[i + 1] = (Math.random() * 256) | 0
    bitmap[i + 2] = (Math.random() * 256) | 0
    bitmap[i + 3] = 255
  }
  noiseCache = { size, bitmap }
  return bitmap
}

/** 生成一张"落在免压缩区间"的 JPEG:长边 ≤1280 且体积 ≤1.5MB(于是原样直传,可用来压满预算) */
function sizedJpeg(targetBytes) {
  const size = 1280
  const img = nativeImage.createFromBitmap(noiseBitmap(size), { width: size, height: size })
  let lo = 40
  let hi = 100
  let best = null
  for (let i = 0; i < 8; i++) {
    const q = Math.round((lo + hi) / 2)
    const buf = img.toJPEG(q)
    if (buf.length > targetBytes) hi = q - 1
    else {
      lo = q + 1
      best = buf
    }
  }
  return best ?? img.toJPEG(60)
}

/** 备选大图:找不到用户的实拍素材时,现场合成一张 4000×3000 的噪声 JPEG */
function synthBigJpeg(quality = 95) {
  const w = 4000
  const h = 3000
  const bitmap = Buffer.alloc(w * h * 4)
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = (Math.random() * 256) | 0
    bitmap[i + 1] = (Math.random() * 256) | 0
    bitmap[i + 2] = (Math.random() * 256) | 0
    bitmap[i + 3] = 255
  }
  return nativeImage.createFromBitmap(bitmap, { width: w, height: h }).toJPEG(quality)
}

/** 收集"真实大图 + 普通图"素材:优先用用户 设计图 项目里那批(只读) */
function collectRealSources() {
  const candidates = [
    'D:\\设计图\\生成图片\\0e63cae6-d51f-4ef4-acb6-defe622ac72c',
    'D:\\设计图\\素材'
  ]
  const jpegs = []
  const pngs = []
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      if (/\.jpe?g$/i.test(name)) jpegs.push({ file: full, size: st.size })
      else if (/\.png$/i.test(name) && st.size > 1_000_000) pngs.push({ file: full, size: st.size })
    }
    if (jpegs.length >= 3) break
  }
  jpegs.sort((a, b) => b.size - a.size)
  pngs.sort((a, b) => a.size - b.size)
  return { jpegs: jpegs.slice(0, 3), pngs: pngs.slice(0, 4) }
}

const api = { stats: null }

/**
 * 控制面请求(取统计/切模式):强制短连接 + 失败重试一次。
 * 否则 undici 会复用 mock 已按 keepAliveTimeout(5s) 关掉的连接,表现为 ECONNRESET。
 */
async function mockFetch(url, init = {}) {
  const opts = { ...init, headers: { Connection: 'close', ...(init.headers ?? {}) } }
  try {
    return await fetch(url, opts)
  } catch {
    return await fetch(url, opts)
  }
}

async function stats() {
  const res = await mockFetch(`${MOCK}/__stats`)
  api.stats = await res.json()
  return api.stats
}

async function resetStats() {
  await mockFetch(`${MOCK}/__reset`, { method: 'POST' })
}

async function setFail(fail) {
  await mockFetch(`${MOCK}/__mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fail })
  })
}

/** 设置 SSE 分片间隔:验证"持续输出不算超时 / 真静默才超时" */
async function setStreamDelay(ms) {
  await mockFetch(`${MOCK}/__mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamDelayMs: ms })
  })
}

async function waitForMock() {
  for (let i = 0; i < 20; i++) {
    try {
      await stats()
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  return false
}

/** 上一轮遗留的临时目录(Chromium 的 session/cache 句柄要等进程退出才释放,所以退出前删不干净):开跑前顺手扫掉 */
function sweepStaleTmp() {
  const parent = os.tmpdir()
  let swept = 0
  try {
    for (const name of fs.readdirSync(parent)) {
      if (!name.startsWith('saydraw-verify-')) continue
      const full = path.join(parent, name)
      try {
        fs.rmSync(full, { recursive: true, force: true })
        swept += 1
      } catch {
        // 仍有句柄就留着,下一轮再扫
      }
    }
  } catch {
    // 忽略
  }
  if (swept) console.log(`（已清理上一轮遗留的临时目录 ${swept} 个）`)
}

async function main() {
  if (!(await waitForMock())) throw new Error(`mock 服务没起来,请先运行:node scripts/mock-server.mjs(期望 ${MOCK})`)
  sweepStaleTmp()

  const mod = buildBundle()
  const db = mod.getDb()
  db.init()
  const settings = mod.getSettings()
  settings.load()
  const baseSettings = {
    chatConnections: [{ id: 'conn-mock', name: 'Mock', baseUrl: `${MOCK}/v1`, apiKey: 'sk-test', apiFormat: 'openai' }],
    chatModels: [
      {
        id: 'model-mock',
        groupId: 'conn-mock',
        name: 'mock-chat',
        model: 'mock-chat',
        contextWindow: 65536,
        maxOutputTokens: 2048,
        supportsVision: true
      }
    ],
    imageConnections: [
      { id: 'conn-mockimg', name: 'MockImg', baseUrl: `${MOCK}/v1`, apiKey: 'sk-test', genPath: '/v1/images/generations', editPath: '/v1/images/edits' }
    ],
    imageModels: [{ id: 'model-mockimg', groupId: 'conn-mockimg', name: 'mock-image', model: 'mock-image' }],
    activeChatModelId: 'model-mock',
    activeImageModelId: 'model-mockimg',
    chatTimeoutMs: 120_000,
    imageTimeoutMs: 600_000,
    maxHistoryImages: 6
  }
  const saveSettings = (patch = {}) => settings.save({ ...baseSettings, ...patch })
  saveSettings()

  const projectDir = path.join(tmpRoot, 'project')
  fs.mkdirSync(projectDir, { recursive: true })

  /** 新建会话 + 把图片作为资产落盘,并插一条引用它们的用户消息(等价于"用户带着这些图发过一条消息") */
  function prepareSession(buffers) {
    const session = db.createSession('verify')
    db.setProjectPath(session.id, projectDir)
    const assets = buffers.map((b) =>
      mod.saveBufferAsset({ sessionId: session.id, buffer: b.buffer, mime: b.mime, kind: 'user-upload', prompt: 'verify' })
    )
    if (assets.length) {
      db.addMessage({
        id: `seed-${session.id}`,
        sessionId: session.id,
        role: 'user',
        text: '（这批图是用户上传的素材）',
        assetIds: assets.map((a) => a.id),
        createdAt: Date.now()
      })
    }
    return { session, assets }
  }

  // ---------- 场景 1:真实大图 + 请求体体积 ----------
  const real = collectRealSources()
  const useReal = real.jpegs.length >= 1
  const bigOnes = useReal
    ? real.jpegs.map((j) => ({ buffer: fs.readFileSync(j.file), mime: 'image/jpeg', from: path.basename(j.file) }))
    : [0, 1, 2].map((i) => ({ buffer: synthBigJpeg(), mime: 'image/jpeg', from: `synth-${i}.jpg` }))
  const normalOnes = useReal && real.pngs.length >= 4
    ? real.pngs.map((p) => ({ buffer: fs.readFileSync(p.file), mime: 'image/png', from: path.basename(p.file) }))
    : [0, 1, 2, 3].map(() => ({ buffer: nativeImage.createFromBitmap(noiseBitmap(1254), { width: 1254, height: 1254 }).toPNG(), mime: 'image/png', from: 'synth.png' }))

  const scenario1 = prepareSession([...normalOnes, ...bigOnes])
  const oldBytes = [...normalOnes, ...bigOnes].reduce((s, b) => s + Math.ceil(b.buffer.length / 3) * 4, 0)

  await resetStats()
  const events1 = []
  await mod.runAgentTurn(scenario1.session.id, { text: '继续' }, (ev) => events1.push(ev))
  const s1 = await stats()

  record(
    '① 大图压缩:7 张图(含 3 张实拍原图)内联后不再撑爆请求体',
    s1.lastBodyBytes < 12_000_000,
    `修复前约 ${mb(oldBytes)} → 现在 ${mb(s1.lastBodyBytes)}`
  )
  record('① 图片全部随请求送达(未误丢)', s1.lastImageCount === 7, `请求体里的内联图 = ${s1.lastImageCount} 张`)

  // 逐张压缩比
  const perImage = scenario1.assets.map((a) => {
    const src = fs.statSync(mod.assetAbsolutePath(a)).size
    const inline = mod.prepareInlineImageFromFile(
      { id: a.id, kind: a.kind, mime: a.mime, width: a.width, height: a.height },
      mod.assetAbsolutePath(a)
    )
    return { id: a.id, dim: `${a.width}x${a.height}`, src, inline: inline.bytes, mime: inline.mime, compressed: inline.compressed }
  })
  const msgs1 = db.messages(scenario1.session.id)
  record('① 这一轮正常收尾(不是被动超时)', msgs1[msgs1.length - 1].stopReason === 'completed', `stopReason=${msgs1[msgs1.length - 1].stopReason}`)

  // ---------- 场景 1b:原事故链路(工具 import_image 逐张导入大图) ----------
  {
    const importDir = path.join(tmpRoot, 'imports')
    fs.mkdirSync(importDir, { recursive: true })
    const importPaths = [...normalOnes, ...bigOnes].map((b, i) => {
      const p = path.join(importDir, `src-${i}${b.mime === 'image/png' ? '.png' : '.jpg'}`)
      fs.writeFileSync(p, b.buffer)
      return p
    })
    const scenario1b = prepareSession([]) // 空会话:图片全靠工具导入,和当时那次一模一样
    await resetStats()
    await mod.runAgentTurn(scenario1b.session.id, { text: `继续\n__IMPORT__ ${importPaths.join('|')}` }, () => {})
    const s1b = await stats()
    record(
      '①b 工具导入链路(原事故复现):7 张大图导入后请求体仍很小',
      s1b.lastBodyBytes < 12_000_000 && s1b.lastImageCount === 7,
      `最终请求体 ${mb(s1b.lastBodyBytes)},内联图 ${s1b.lastImageCount} 张,峰值 ${mb(s1b.maxBodyBytes)}`
    )
  }

  // ---------- 场景 2:请求体预算 ----------
  // 目标:每张 base64 后 ≈1.4MB(≤1.5MB 单张上限 → 原样直传),9 张合计超过 8MB 预算
  const manySmall = Array.from({ length: 9 }, () => ({ buffer: sizedJpeg(1_050_000), mime: 'image/jpeg', from: 'sized.jpg' }))
  const scenario2 = prepareSession(manySmall)
  const sizedSizes = scenario2.assets.map((a) => fs.statSync(mod.assetAbsolutePath(a)).size)
  const totalInline = sizedSizes.reduce((s, n) => s + Math.ceil(n / 3) * 4, 0)

  await resetStats()
  await mod.runAgentTurn(scenario2.session.id, { text: '继续' }, () => {})
  const s2 = await stats()
  const budgetTriggered = totalInline > mod.INLINE_BUDGET_BYTES
  record(
    '② 预算生效:9 张图合计超预算时只带最新的,旧图留痕',
    !budgetTriggered || (s2.lastImageCount < 9 && s2.lastHadOmitNote && s2.lastBodyBytes <= mod.INLINE_BUDGET_BYTES + 2_000_000),
    `合计内联 ${mb(totalInline)}(预算 ${mb(mod.INLINE_BUDGET_BYTES)})→ 实带 ${s2.lastImageCount} 张,留痕=${s2.lastHadOmitNote},请求体 ${mb(s2.lastBodyBytes)}`
  )

  // 直接校验分配顺序:预算只够 2 张时,必须留最新的
  const probeBudget = { left: 3_600_000, used: 0, omitted: 0 }
  const ordered = [...scenario2.assets].sort((a, b) => a.createdAt - b.createdAt)
  const allowedSmall = mod.planInline(ordered, probeBudget)
  const newest = ordered[ordered.length - 1]
  record(
    '② 裁剪优先级:最新的一张一定保留',
    allowedSmall.has(newest.id) && allowedSmall.size < ordered.length,
    `保留 ${allowedSmall.size}/${ordered.length} 张,省略 ${probeBudget.omitted} 张`
  )

  // ---------- 场景 3:蒙版/透明图 ----------
  {
    // a) 平色透明蒙版(3000×3000 只有 ~100KB):应原样直传 —— resize 会把透明区 RGB 搅成噪声,反而涨到 MB 级
    const size = 3000
    const bitmap = Buffer.alloc(size * size * 4)
    for (let i = 0; i < bitmap.length; i += 4) {
      const on = (i / 4) % 7 === 0
      bitmap[i] = on ? 255 : 0
      bitmap[i + 1] = on ? 120 : 0
      bitmap[i + 2] = on ? 40 : 0
      bitmap[i + 3] = on ? 255 : 0 // 大片透明(接口蒙版语义:透明区=待修改)
    }
    const maskPng = nativeImage.createFromBitmap(bitmap, { width: size, height: size }).toPNG()
    const maskPath = path.join(tmpRoot, 'mask.png')
    fs.writeFileSync(maskPath, maskPng)
    const inlineMask = mod.prepareInlineImageFromFile(
      { id: 'mask-probe', kind: 'mask', mime: 'image/png', width: size, height: size },
      maskPath
    )
    record(
      '③ 蒙版走 PNG 保透明、原样直传(不被 resize 撑大)',
      inlineMask.mime === 'image/png' && inlineMask.bytes <= 1_500_000 && inlineMask.bytes <= maskPng.length * 2,
      `${size}×${size} → ${inlineMask.width}×${inlineMask.height} ${inlineMask.mime} ${mb(inlineMask.bytes)}(源 ${mb(maskPng.length)})`
    )

    // b) 又大又花的带透明图(超限):仍须压到单张上限之内
    const big = 4000
    const noisy = Buffer.alloc(big * big * 4)
    for (let i = 0; i < noisy.length; i += 4) {
      noisy[i] = (Math.random() * 256) | 0
      noisy[i + 1] = (Math.random() * 256) | 0
      noisy[i + 2] = (Math.random() * 256) | 0
      noisy[i + 3] = i % 16 === 0 ? 0 : 255
    }
    const noisyPng = nativeImage.createFromBitmap(noisy, { width: big, height: big }).toPNG()
    const noisyPath = path.join(tmpRoot, 'noisy-alpha.png')
    fs.writeFileSync(noisyPath, noisyPng)
    const inlineNoisy = mod.prepareInlineImageFromFile(
      { id: 'noisy-probe', kind: 'mask', mime: 'image/png', width: big, height: big },
      noisyPath
    )
    record(
      '③ 超大透明图仍被压进单张上限',
      inlineNoisy.bytes <= 1_500_000 && Math.max(inlineNoisy.width ?? 0, inlineNoisy.height ?? 0) <= 2048,
      `源 ${mb(noisyPng.length)} → ${inlineNoisy.width}×${inlineNoisy.height} ${inlineNoisy.mime} ${mb(inlineNoisy.bytes)}`
    )
  }

  // ---------- 场景 4:超时语义(空闲超时,而不是整请求硬 deadline) ----------
  {
    saveSettings({ chatTimeoutMs: 5_000 })

    // a) 每 1.2s 出一片 < 5s 空闲阈值:单请求总耗时远超 5s,仍应正常收尾
    await setStreamDelay(1_200)
    const s4a = prepareSession([])
    const t0 = Date.now()
    await mod.runAgentTurn(s4a.session.id, { text: '继续' }, () => {})
    const elapsed = Date.now() - t0
    const last4a = db.messages(s4a.session.id).at(-1)
    record(
      '④ 持续输出不算超时(旧行为:整请求 5s 硬 deadline 必挂)',
      elapsed > 6_000 && last4a.stopReason === 'completed',
      `整轮耗时 ${(elapsed / 1000).toFixed(1)}s(配置 5s),stopReason=${last4a.stopReason}`
    )

    // b) 8s 完全没有数据 > 5s 空闲阈值:必须中断,且原因可见
    await setStreamDelay(8_000)
    const s4b = prepareSession([])
    await mod.runAgentTurn(s4b.session.id, { text: '继续' }, () => {})
    const last4b = db.messages(s4b.session.id).at(-1)
    record(
      '④ 真静默仍会超时:8s 没有任何数据 → 中断并写明原因',
      last4b.stopReason === 'error' && String(last4b.error).includes('超时'),
      `stopReason=${last4b.stopReason} error=${JSON.stringify(last4b.error)}`
    )

    await setStreamDelay(15)
    saveSettings()
  }

  // ---------- 场景 5:失败落痕 ----------
  await setFail(true)
  const scenario3 = prepareSession([])
  await mod.runAgentTurn(scenario3.session.id, { text: '继续' }, () => {})
  const msgs3 = db.messages(scenario3.session.id)
  const last3 = msgs3[msgs3.length - 1]
  await setFail(false)
  record(
    '⑤ 失败留痕:一个字都没产出时也落一条消息并写明原因',
    last3.role === 'assistant' && last3.stopReason === 'error' && typeof last3.error === 'string' && last3.error.length > 0,
    `stopReason=${last3.stopReason} error=${JSON.stringify(last3.error)}`
  )

  const failed = results.filter((r) => !r.pass)
  console.log('\n===== 明细 =====')
  console.log(JSON.stringify({ tmpRoot, requests: api.stats?.requests, perImage, sizedSizes, summary: results }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
  if (process.env.SAYDRAW_VERIFY_KEEP) {
    console.log(`临时目录保留在:${tmpRoot}`)
  } else {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      console.log('临时目录已清理(要保留请设 SAYDRAW_VERIFY_KEEP=1)')
    } catch {
      // Chromium 的 session/cache 句柄要等进程退出才释放,这里删不掉很正常:下一轮开跑前会自动扫掉
      console.log(`临时目录留待下轮自动清理:${tmpRoot}`)
    }
  }
  return failed.length === 0
}

app.whenReady().then(async () => {
  let ok = false
  try {
    ok = await main()
  } catch (err) {
    console.error('验证脚本异常:', err)
  }
  app.exit(ok ? 0 : 1)
})
