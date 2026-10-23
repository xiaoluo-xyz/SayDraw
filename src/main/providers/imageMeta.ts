// 生图可选参数的降级决策与图片尺寸探测(纯函数,不依赖 electron,便于单独验证)

export type OptionalImageParam = 'input_fidelity' | 'output_format' | 'quality' | 'size'

/**
 * 端点拒绝某个可选参数时的丢弃优先级:越靠前越先丢。
 * input_fidelity 只影响保真度;size 直接决定画质与画面比例,必须最后才丢 ——
 * 旧实现只要碰到"不支持参数"就一次性把 size/quality/format 全丢掉,
 * 结果是用户要的 4K / 16:9 / 高质量被静默降级成 1024 方图。
 */
export const DROP_ORDER: OptionalImageParam[] = ['input_fidelity', 'output_format', 'quality', 'size']

const ALIASES: Record<OptionalImageParam, RegExp> = {
  input_fidelity: /input[_\s-]?fidelity|fidelity|保真/i,
  output_format: /output[_\s-]?format|output_format|response_format|输出格式/i,
  quality: /quality|质量/i,
  size: /\bsize\b|dimension|尺寸|分辨率|resolution/i
}

/** 从端点报错文本里识别被拒的具体参数;识别不到返回 null(由调用方按 DROP_ORDER 兜底) */
export function pickUnsupportedParam(message: string, remaining: OptionalImageParam[]): OptionalImageParam | null {
  for (const param of remaining) {
    if (ALIASES[param].test(message)) return param
  }
  return null
}

/** 下一个该丢弃的参数:能识别到具体参数就丢它,否则按 DROP_ORDER 兜底;已无可丢返回 null */
export function nextParamToDrop(named: OptionalImageParam | null, remaining: OptionalImageParam[]): OptionalImageParam | null {
  if (named && remaining.includes(named)) return named
  return DROP_ORDER.find((param) => remaining.includes(param)) ?? null
}

/** 降级说明(供工具结果与界面展示,让模型如实告知用户画质/尺寸被降级) */
export function describeDropped(dropped: OptionalImageParam[]): string {
  if (!dropped.length) return ''
  const label: Record<OptionalImageParam, string> = {
    input_fidelity: '细节保真参数',
    output_format: '输出格式参数',
    quality: '画质档位参数',
    size: '分辨率参数'
  }
  return `该服务不支持${dropped.map((d) => label[d]).join('、')},已按服务默认值生成`
}

/** PNG / JPEG 尺寸探测(不引入 sharp 等原生依赖) —— 用于如实回报"实际出图尺寸" */
export function probeImageSize(buffer: Buffer, mime: string): { width?: number; height?: number } {
  try {
    if (mime === 'image/png' && buffer.length > 24 && buffer.readUInt32BE(12) === 0x49484452) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (mime === 'image/jpeg') {
      let off = 2
      while (off + 9 < buffer.length) {
        if (buffer[off] !== 0xff) break
        const marker = buffer[off + 1]
        const size = buffer.readUInt16BE(off + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(off + 5), width: buffer.readUInt16BE(off + 7) }
        }
        off += 2 + size
      }
    }
  } catch {
    // 解析失败不影响主流程
  }
  return {}
}

/** 尺寸字符串(2048x2048) */
export function sizeText(size?: { width?: number; height?: number }): string | undefined {
  if (!size?.width || !size?.height) return undefined
  return `${size.width}x${size.height}`
}

/**
 * 逐个丢弃被端点拒绝的可选参数后重试:
 * 一次只丢一个,且优先丢影响最小的(见 DROP_ORDER),因此端点只拒绝 quality 时,
 * size 与 output_format 仍能保留下来 —— 这是"4K/16:9 被静默降成 1024 方图"的修复点。
 * 与 electron 解耦(只依赖 isRejected 回调),便于单独验证。
 */
export async function withParamFallback<T>(
  params: OptionalImageParam[],
  attempt: (active: OptionalImageParam[]) => Promise<T>,
  isRejected: (err: unknown) => boolean
): Promise<{ value: T; dropped: OptionalImageParam[] }> {
  let active = [...params]
  const dropped: OptionalImageParam[] = []
  let lastError: unknown

  for (let guard = 0; guard <= params.length; guard++) {
    try {
      return { value: await attempt(active), dropped }
    } catch (err) {
      lastError = err
      if (!isRejected(err) || active.length === 0) throw err
      const victim = nextParamToDrop(pickUnsupportedParam(errMessage(err), active), active)
      if (!victim) throw err
      dropped.push(victim)
      active = active.filter((param) => param !== victim)
    }
  }
  throw lastError
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
