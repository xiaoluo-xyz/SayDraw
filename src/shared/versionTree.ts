// 版本树:把「编辑来源」串成树,支持分支(同一父图多次编辑)与 A/B 关系判断
// 纯函数,便于单独验证;渲染层只负责展示 flatten 后的行

import type { ImageAsset } from './types'

export interface VersionNode {
  asset: ImageAsset
  depth: number
  children: VersionNode[]
}

const byTime = (a: ImageAsset, b: ImageAsset): number => a.createdAt - b.createdAt

/** 构建版本树:mask 资产不入树;找不到父图的孤儿当作根 */
export function buildVersionTree(assets: ImageAsset[]): VersionNode[] {
  const list = assets.filter((a) => a.kind !== 'mask' && a.kind !== 'annotation')
  const byId = new Map(list.map((a) => [a.id, a]))
  const childrenOf = new Map<string, ImageAsset[]>()
  const roots: ImageAsset[] = []

  for (const asset of list) {
    const parent = asset.parentId ? byId.get(asset.parentId) : undefined
    if (!parent) {
      roots.push(asset)
      continue
    }
    const arr = childrenOf.get(parent.id) ?? []
    arr.push(asset)
    childrenOf.set(parent.id, arr)
  }

  const build = (asset: ImageAsset, depth: number): VersionNode => ({
    asset,
    depth,
    children: (childrenOf.get(asset.id) ?? []).sort(byTime).map((child) => build(child, depth + 1))
  })

  return roots.sort(byTime).map((root) => build(root, 0))
}

/** 深度优先展开成一行行(渲染用) */
export function flattenTree(nodes: VersionNode[]): VersionNode[] {
  const out: VersionNode[] = []
  const walk = (node: VersionNode): void => {
    out.push(node)
    node.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

/** 从根到该图的路径(含自身);找不到返回空数组 */
export function pathToRoot(assets: ImageAsset[], id: string): ImageAsset[] {
  const byId = new Map(assets.map((a) => [a.id, a]))
  const path: ImageAsset[] = []
  let cur = byId.get(id)
  const guard = new Set<string>()
  while (cur) {
    path.unshift(cur)
    if (!cur.parentId || guard.has(cur.id)) break
    guard.add(cur.id)
    cur = byId.get(cur.parentId)
  }
  return path
}

export type VersionRelation = 'same' | 'a-parent' | 'b-parent' | 'siblings' | 'unrelated'

/** A/B 两张图的关系(用于对比界面标注"这是它的上一版/兄弟版本") */
export function relationOf(assets: ImageAsset[], a: string, b: string): VersionRelation {
  if (a === b) return 'same'
  const pathA = pathToRoot(assets, a).map((x) => x.id)
  const pathB = pathToRoot(assets, b).map((x) => x.id)
  if (pathB.includes(a)) return 'a-parent'
  if (pathA.includes(b)) return 'b-parent'
  const parentA = pathA[pathA.length - 2]
  const parentB = pathB[pathB.length - 2]
  if (parentA && parentA === parentB) return 'siblings'
  return 'unrelated'
}

/** 第几版:同父兄弟按创建时间排序的序号(从 1 开始) */
export function versionNumber(assets: ImageAsset[], asset: ImageAsset): number {
  const key = asset.parentId ?? ''
  const siblings = assets
    .filter((a) => a.kind !== 'mask' && a.kind !== 'annotation' && (a.parentId ?? '') === key)
    .sort(byTime)
  const index = siblings.findIndex((a) => a.id === asset.id)
  return index >= 0 ? index + 1 : 1
}

/** 树里某张图有多少子版本(用于标注"另有 n 个改版") */
export function childCount(assets: ImageAsset[], id: string): number {
  return assets.filter((a) => a.kind !== 'mask' && a.kind !== 'annotation' && a.parentId === id).length
}
