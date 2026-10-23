// 工作区(工作目录)分组:左侧会话列表按「总文件夹」归拢,纯函数便于单测
//
// 规则:
// - 有 projectPath 的会话归到对应文件夹下;同一个文件夹 = 一个工作区(路径做归一化,忽略尾部斜杠/大小写差异)
// - 没有 projectPath 的会话是「独立会话」(不强制选目录也能画)
// - 工作区按该组内最近活跃时间倒序;组内会话也按最近活跃倒序

import type { SessionSummary } from './types'

export interface WorkspaceGroup {
  /** 归一化后的绝对路径,作为 key */
  path: string
  /** 显示名:文件夹名 */
  name: string
  sessions: SessionSummary[]
  /** 组内最近活跃时间 */
  updatedAt: number
  messageCount: number
}

export interface SessionGroups {
  workspaces: WorkspaceGroup[]
  loose: SessionSummary[]
}

/** 归一化路径:统一分隔符、去掉尾部分隔符、Windows 下大小写不敏感 */
export function normalizePath(input: string): string {
  const trimmed = input.trim().replace(/[\\/]+$/, '')
  const unified = trimmed.replace(/\//g, '\\')
  // 盘符大小写统一(仅 Windows 形态)
  return /^[a-z]:\\/i.test(unified) ? unified[0].toUpperCase() + unified.slice(1) : unified
}

/** 路径 → 显示名(末级文件夹名;C:\ → C:) */
export function workspaceName(input: string): string {
  const normalized = normalizePath(input)
  if (/^[A-Z]:$/i.test(normalized)) return normalized.toUpperCase()
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? normalized
}

/** 比较用的 key:Windows 路径大小写不敏感 */
export function pathKey(input: string): string {
  return normalizePath(input).toLowerCase()
}

const byUpdatedDesc = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt

export function groupSessions(sessions: SessionSummary[]): SessionGroups {
  const map = new Map<string, WorkspaceGroup>()
  const loose: SessionSummary[] = []
  for (const session of sessions) {
    const raw = session.projectPath?.trim()
    if (!raw) {
      loose.push(session)
      continue
    }
    const key = pathKey(raw)
    let group = map.get(key)
    if (!group) {
      group = { path: normalizePath(raw), name: workspaceName(raw), sessions: [], updatedAt: 0, messageCount: 0 }
      map.set(key, group)
    }
    group.sessions.push(session)
    group.updatedAt = Math.max(group.updatedAt, session.updatedAt)
    group.messageCount += session.messageCount
  }
  const workspaces = [...map.values()]
  for (const group of workspaces) group.sessions.sort(byUpdatedDesc)
  workspaces.sort((a, b) => b.updatedAt - a.updatedAt)
  loose.sort(byUpdatedDesc)
  return { workspaces, loose }
}

/** 给定路径是否已在现有工作区里(用于"把会话挂到已有工作区"时复用大小写等写法) */
export function findWorkspace(groups: SessionGroups, path: string): WorkspaceGroup | undefined {
  const key = pathKey(path)
  return groups.workspaces.find((g) => pathKey(g.path) === key)
}
