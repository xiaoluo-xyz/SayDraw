// 会话 / 消息 / 资产元数据 / 需求规格 的 JSON 持久化存储
// 数据量小(元数据级),写穿 + 临时文件原子替换,无需 SQLite

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ImageAsset, ImageBrief, SessionSummary } from '@shared/types'
import { appendLog } from './log'

interface DBShape {
  sessions: SessionSummary[]
  messages: ChatMessage[]
  assets: ImageAsset[]
  briefs: Record<string, ImageBrief>
}

function emptyShape(): DBShape {
  return { sessions: [], messages: [], assets: [], briefs: {} }
}

class DB {
  private file = ''
  private data: DBShape = emptyShape()

  init(): void {
    this.file = path.join(app.getPath('userData'), 'app-data.json')
    const candidates = [this.file, `${this.file}.bak`]
    let sawExistingFile = false
    for (const candidate of candidates) {
      let raw: string
      try {
        raw = fs.readFileSync(candidate, 'utf8')
      } catch {
        continue // 不存在(首次启动)或不可读,试下一份
      }
      sawExistingFile = true
      try {
        const parsed = JSON.parse(raw) as Partial<DBShape>
        this.data = { ...emptyShape(), ...parsed }
        if (candidate !== this.file) {
          appendLog(`主数据文件损坏,已从备份恢复:${candidate}`)
        }
        return
      } catch (err) {
        appendLog(`数据文件解析失败(${candidate}):${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.data = emptyShape()
    if (sawExistingFile) {
      // 主文件与备份都读不出来:宁可空库启动,也要留痕(不再静默重置)
      appendLog('主数据与备份均不可用,已以空数据启动')
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    const bak = `${this.file}.bak`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    // 上一次的完好数据留作 .bak:主文件被写坏/截断时还能回退一代
    try {
      if (fs.existsSync(this.file)) fs.renameSync(this.file, bak)
    } catch (err) {
      appendLog(`数据备份失败(继续写主文件):${err instanceof Error ? err.message : String(err)}`)
    }
    fs.renameSync(tmp, this.file)
  }

  // ---------- 会话 ----------

  listSessions(): SessionSummary[] {
    return [...this.data.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getSession(id: string): SessionSummary | undefined {
    return this.data.sessions.find((s) => s.id === id)
  }

  createSession(title = '新会话', projectPath?: string): SessionSummary {
    const now = Date.now()
    const s: SessionSummary = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      projectPath
    }
    this.data.sessions.push(s)
    this.save()
    return s
  }

  renameSession(id: string, title: string): void {
    const s = this.getSession(id)
    if (!s) return
    s.title = title.trim() || s.title
    s.updatedAt = Date.now()
    this.save()
  }

  setProjectPath(id: string, projectPath: string | undefined): void {
    const s = this.getSession(id)
    if (!s) return
    s.projectPath = projectPath
    s.updatedAt = Date.now()
    this.save()
  }

  touchSession(id: string): void {
    const s = this.getSession(id)
    if (s) {
      s.updatedAt = Date.now()
      this.save()
    }
  }

  deleteSession(id: string): string[] {
    // 返回待删除的资产文件相对路径,由 assets 模块负责删文件
    const removed: string[] = []
    this.data.assets = this.data.assets.filter((a) => {
      if (a.sessionId === id) {
        removed.push(a.fileName)
        return false
      }
      return true
    })
    this.data.messages = this.data.messages.filter((m) => m.sessionId !== id)
    delete this.data.briefs[id]
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    this.save()
    return removed
  }

  // ---------- 消息 ----------

  messages(sessionId: string): ChatMessage[] {
    return this.data.messages
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  addMessage(message: ChatMessage): void {
    this.data.messages.push(message)
    const s = this.getSession(message.sessionId)
    if (s) {
      s.messageCount = this.data.messages.filter((m) => m.sessionId === message.sessionId).length
      s.updatedAt = Date.now()
      // 首条用户消息自动命名
      if (message.role === 'user' && s.title === '新会话' && message.text.trim()) {
        s.title = message.text.trim().slice(0, 18)
      }
    }
    this.save()
  }

  // ---------- 资产 ----------

  addAsset(asset: ImageAsset): ImageAsset {
    this.data.assets.push(asset)
    const s = this.getSession(asset.sessionId)
    if (s && !s.coverAssetId && asset.kind !== 'mask') {
      s.coverAssetId = asset.id
    }
    this.save()
    return asset
  }

  asset(id: string): ImageAsset | undefined {
    return this.data.assets.find((a) => a.id === id)
  }

  assets(sessionId: string): ImageAsset[] {
    return this.data.assets
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 选用候选图:从草稿转为正式版本链成员(返回更新后的资产) */
  promoteAsset(id: string): ImageAsset | undefined {
    const asset = this.asset(id)
    if (!asset) return undefined
    if (asset.draft) {
      asset.draft = false
      this.save()
    }
    return asset
  }

  // ---------- 需求规格 ----------

  brief(sessionId: string): ImageBrief {
    return this.data.briefs[sessionId] ?? {}
  }

  /** 合并槽位并落盘;confirmedAt 只能由确认动作设置;确认后槽位变化会自动失效(需重新确认) */
  patchBrief(sessionId: string, patch: ImageBrief, markConfirmed = false): ImageBrief {
    const prev = this.brief(sessionId)
    const next: ImageBrief = { ...prev }
    let changed = false
    for (const [k, v] of Object.entries(patch)) {
      const key = k as keyof ImageBrief
      if (key === 'confirmedAt') continue
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        if ((prev as Record<string, unknown>)[key] !== v) changed = true
        ;(next as Record<string, unknown>)[key] = v
      }
    }
    if (markConfirmed && !next.confirmedAt) {
      next.confirmedAt = Date.now()
    } else if (changed && next.confirmedAt) {
      next.confirmedAt = undefined // 需求变化 → 回到未确认,强制重新确认
    }
    this.data.briefs[sessionId] = next
    this.save()
    return next
  }
}

let instance: DB | null = null

export function getDb(): DB {
  if (!instance) {
    instance = new DB()
    instance.init()
  }
  return instance
}
