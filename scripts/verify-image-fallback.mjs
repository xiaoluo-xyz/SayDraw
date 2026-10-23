// 生图参数降级逻辑验证(纯 node,不需要 Electron、不消耗额度)
// 用法:npm run verify:image
//
// 背景:旧实现只要端点报"参数不支持",就会把 size/quality/output_format 一次性全丢掉,
// 结果是用户要的 4K / 16:9 / 高清被静默降级成 1024 方图。本脚本锁住修复后的行为:
// 一次只丢被拒的那个参数,且优先丢影响最小的(细节保真 → 格式 → 画质 → 分辨率)。

import { strict as assert } from 'node:assert'

const mod = await import('../src/main/providers/imageMeta.ts')
const { pickUnsupportedParam, nextParamToDrop, describeDropped, probeImageSize, sizeText, withParamFallback } = mod

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test('从英文报错识别被拒参数', () => {
  assert.equal(pickUnsupportedParam('Unsupported parameter: quality', ['size', 'quality']), 'quality')
  assert.equal(pickUnsupportedParam('unknown field input_fidelity', ['size', 'input_fidelity']), 'input_fidelity')
})

test('从中文报错识别分辨率', () => {
  assert.equal(pickUnsupportedParam('不支持参数:分辨率', ['size', 'quality']), 'size')
})

test('识别不出参数时返回 null', () => {
  assert.equal(pickUnsupportedParam('bad request', ['size', 'quality']), null)
})

test('识别不出时优先丢画质、保住分辨率', () => {
  assert.equal(nextParamToDrop(null, ['size', 'quality']), 'quality')
  assert.equal(nextParamToDrop(null, ['size']), 'size')
  assert.equal(nextParamToDrop('size', ['size', 'quality']), 'size')
  assert.equal(nextParamToDrop(null, []), null)
})

test('只拒 quality 时不连坐 size(核心回归)', async () => {
  const seen = []
  const { value, dropped } = await withParamFallback(
    ['size', 'quality', 'output_format'],
    async (active) => {
      seen.push([...active])
      if (active.includes('quality')) {
        const err = new Error('Unsupported parameter: quality')
        err.status = 400
        throw err
      }
      return active.join(',')
    },
    (err) => err.status === 400
  )
  assert.equal(value, 'size,output_format')
  assert.deepEqual(dropped, ['quality'])
  assert.ok(seen[0].includes('size'), '首次请求就必须带 size')
  assert.equal(seen.length, 2)
})

test('quality 与 size 都被拒时按顺序丢弃并最终成功', async () => {
  const { value, dropped } = await withParamFallback(
    ['size', 'quality'],
    async (active) => {
      if (active.includes('quality')) {
        const err = new Error('unsupported parameter: quality')
        err.status = 400
        throw err
      }
      if (active.includes('size')) {
        const err = new Error('size not supported')
        err.status = 400
        throw err
      }
      return 'ok'
    },
    (err) => err.status === 400
  )
  assert.equal(value, 'ok')
  assert.deepEqual(dropped, ['quality', 'size'])
})

test('非 400 错误不降级重试', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withParamFallback(
        ['size'],
        async () => {
          calls++
          const err = new Error('401 bad key')
          err.status = 401
          throw err
        },
        (err) => err.status === 400
      ),
    /bad key/
  )
  assert.equal(calls, 1)
})

test('全部参数被拒时抛错且尝试次数有界', async () => {
  let calls = 0
  await assert.rejects(() =>
    withParamFallback(
      ['size', 'quality'],
      async () => {
        calls++
        const err = new Error('Unsupported parameter: size')
        err.status = 400
        throw err
      },
      (err) => err.status === 400
    )
  )
  assert.ok(calls <= 3, `尝试次数应有限,实际 ${calls}`)
})

test('降级说明可读', () => {
  assert.equal(describeDropped([]), '')
  assert.match(describeDropped(['quality']), /画质/)
  assert.match(describeDropped(['size']), /分辨率/)
})

test('PNG 尺寸探测与尺寸文本', () => {
  assert.deepEqual(probeImageSize(Buffer.from(TINY_PNG, 'base64'), 'image/png'), { width: 1, height: 1 })
  assert.equal(sizeText({ width: 2048, height: 2048 }), '2048x2048')
  assert.equal(sizeText({}), undefined)
})

let failed = 0
for (const { name, fn } of cases) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed ? 1 : 0)
