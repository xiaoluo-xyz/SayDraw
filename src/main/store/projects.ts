// 项目文件夹:选择后初始化 要求.md / 需求规格.md;需求规格随对话自动同步

import fs from 'node:fs'
import path from 'node:path'
import type { ImageBrief } from '@shared/types'
import { BRIEF_SLOTS } from '@shared/types'
import { getDb } from './db'

const REQ_FILE = '要求.md'
const SPEC_FILE = '需求规格.md'

function ensureFile(file: string, content: string): boolean {
  if (fs.existsSync(file)) return false
  fs.writeFileSync(file, content, 'utf8')
  return true
}

function requirementsTemplate(projectName: string): string {
  return `# ${projectName} · 项目要求

> 由 AIImage 初始化。本文件记录项目的创作要求,可手动编辑,也可让 Agent 读取参考。

## 背景与目标

(待补充)

## 风格要求

(待补充)

## 硬性约束

(待补充)
`
}

function specTemplate(): string {
  return specContent({})
}

function specContent(brief: ImageBrief): string {
  const lines = BRIEF_SLOTS.map((slot) => {
    const v = brief[slot.key]
    return `- ${slot.label}:${typeof v === 'string' && v.trim() ? v.trim() : '(待补充)'}`
  })
  const confirmed = brief.confirmedAt ? '✅ 已确认' : '⏳ 待确认'
  return `# 需求规格(自动同步)

> 本文件由 AIImage 根据对话中的需求收集自动更新,请勿手动编辑。

${lines.join('\n')}

- 确认状态:${confirmed}
- 更新时间:${new Date().toLocaleString('zh-CN')}
`
}

export interface ProjectSetupResult {
  path: string
  createdFiles: string[]
}

/** 幂等准备一个工作目录(不涉及会话):要求.md / 需求规格.md / 素材/ / 生成图片/ */
export function ensureProjectFiles(dir: string): ProjectSetupResult {
  const resolved = path.resolve(dir)
  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) throw new Error('所选路径不是文件夹')

  const createdFiles: string[] = []
  if (ensureFile(path.join(resolved, REQ_FILE), requirementsTemplate(path.basename(resolved)))) {
    createdFiles.push(REQ_FILE)
  }
  if (ensureFile(path.join(resolved, SPEC_FILE), specTemplate())) {
    createdFiles.push(SPEC_FILE)
  }
  // 素材文件夹:用户存放参考资产,Agent 可浏览
  const materialDir = path.join(resolved, '素材')
  if (!fs.existsSync(materialDir)) {
    fs.mkdirSync(materialDir, { recursive: true })
    createdFiles.push('素材/')
  }
  // 生成图片文件夹:所有产出图片按会话存放
  const imagesDir = path.join(resolved, '生成图片')
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true })
    createdFiles.push('生成图片/')
  }

  return { path: resolved, createdFiles }
}

/** 设置会话的工作目录(目录文件已就绪时直接调用;会立刻同步一次需求规格) */
export function setSessionProject(sessionId: string, dir: string): ProjectSetupResult {
  const result = ensureProjectFiles(dir)
  getDb().setProjectPath(sessionId, result.path)
  syncSpecFile(sessionId)
  return result
}

export function clearSessionProject(sessionId: string): void {
  getDb().setProjectPath(sessionId, undefined)
}

/** 需求规格变化 → 写入 需求规格.md(会话已设置项目文件夹时) */
export function syncSpecFile(sessionId: string): void {
  const db = getDb()
  const session = db.getSession(sessionId)
  if (!session?.projectPath) return
  try {
    fs.writeFileSync(path.join(session.projectPath, SPEC_FILE), specContent(db.brief(sessionId)), 'utf8')
  } catch {
    // 项目文件夹可能被移动/删除,忽略写入失败
  }
}
