// 后备模型挑选策略(纯函数,便于单测):
// 主模型端点故障时"先用哪个"决定恢复速度 —— 优先换到**别的连接**(不同服务/Key,故障域不同),
// 同连接内再按设置顺序;显式指定则只用指定的那个;'off' 表示只重试不换模型。

export interface FallbackCandidate {
  id: string
  groupId: string
}

/** chatFallback 的取值语义:'auto'(默认) / 'off' / 具体模型 id */
export type FallbackPolicy = string | undefined

export function orderFallbackModelIds(models: FallbackCandidate[], activeId: string | undefined, policy: FallbackPolicy): string[] {
  if (policy === 'off') return []
  if (policy && policy !== 'auto') {
    const hit = models.find((m) => m.id === policy)
    return hit && hit.id !== activeId ? [hit.id] : []
  }
  const active = models.find((m) => m.id === activeId)
  const others = models
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.id !== activeId)
    .sort((a, b) => {
      const rank = (groupId: string): number => (active && groupId === active.groupId ? 1 : 0)
      return rank(a.m.groupId) - rank(b.m.groupId) || a.i - b.i
    })
  return others.map(({ m }) => m.id)
}
