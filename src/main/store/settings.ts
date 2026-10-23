// 设置持久化(v3:连接分组 + 模型列表);API Key 用 electron safeStorage 加密存储
// 对外提供拼装式 activeChatProfile()/activeImageProfile(),下游 Provider/Agent 无感

import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChatModel,
  type ChatProfile,
  type ImageModel,
  type ImageProfile,
  type ModelConnection
} from '@shared/types'
import { orderFallbackModelIds } from '@shared/fallback'

const ENC_PREFIX = 'enc:'

function encrypt(plain: string): string {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    // 加密不可用时退化为明文(仅本机 settings.json)
  }
  return plain
}

function decrypt(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return ''
    }
  }
  return stored
}

function encryptSettings(s: AppSettings): AppSettings {
  const enc = (list: ModelConnection[]): ModelConnection[] => list.map((c) => ({ ...c, apiKey: encrypt(c.apiKey) }))
  return { ...s, chatConnections: enc(s.chatConnections), imageConnections: enc(s.imageConnections) }
}

/** 兼容 v2(扁平 profile)与 v3(连接分组)两种已存形态的解密 */
function decryptSettingsAny(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw }
  for (const key of ['chatProfiles', 'imageProfiles', 'chatConnections', 'imageConnections'] as const) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as Record<string, unknown>[]).map((c) => ({ ...c, apiKey: decrypt(String(c.apiKey ?? '')) }))
    }
  }
  return out
}

// ---------- 归一化 ----------

function normalizeConn(c: ModelConnection, isImage: boolean): ModelConnection {
  return {
    ...c,
    id: c.id || randomUUID(),
    name: c.name || '新分组',
    baseUrl: c.baseUrl || '',
    apiKey: c.apiKey || '',
    apiFormat: isImage ? undefined : (c.apiFormat ?? 'openai'),
    ...(isImage
      ? { genPath: c.genPath || '/images/generations', editPath: c.editPath || '/images/edits' }
      : {})
  }
}

function normalizeChatModel(m: ChatModel): ChatModel {
  return {
    ...m,
    id: m.id || randomUUID(),
    name: m.name || m.model || '新模型',
    model: m.model || '',
    contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 65536,
    maxOutputTokens: m.maxOutputTokens && m.maxOutputTokens > 0 ? m.maxOutputTokens : 8192,
    supportsVision: m.supportsVision !== false
  }
}

function normalizeImageModel(m: ImageModel): ImageModel {
  return {
    ...m,
    id: m.id || randomUUID(),
    name: m.name || m.model || '新模型',
    model: m.model || '',
    maxN: m.maxN && m.maxN > 0 ? m.maxN : 4,
    maxReferenceImages: m.maxReferenceImages && m.maxReferenceImages > 0 ? m.maxReferenceImages : 16,
    maxImageMB: m.maxImageMB && m.maxImageMB > 0 ? m.maxImageMB : 25,
    maxPromptChars: m.maxPromptChars && m.maxPromptChars > 0 ? m.maxPromptChars : 32_000
  }
}

function normalizeAll(s: Partial<AppSettings>): AppSettings {
  const base: AppSettings = {
    ...s,
    chatConnections: s.chatConnections ?? [],
    chatModels: s.chatModels ?? [],
    imageConnections: s.imageConnections ?? [],
    imageModels: s.imageModels ?? []
  } as AppSettings
  return {
    ...base,
    chatConnections: base.chatConnections.map((c) => normalizeConn(c, false)),
    chatModels: base.chatModels.map(normalizeChatModel),
    imageConnections: base.imageConnections.map((c) => normalizeConn(c, true)),
    imageModels: base.imageModels.map(normalizeImageModel)
  }
}

/** 孤儿模型(分组已删)清理 */
function dropOrphans(s: AppSettings): void {
  s.chatModels = s.chatModels.filter((m) => s.chatConnections.some((c) => c.id === m.groupId))
  s.imageModels = s.imageModels.filter((m) => s.imageConnections.some((c) => c.id === m.groupId))
}

// ---------- v2(扁平)→ v3(分组) 迁移 ----------

interface LegacyProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: 'openai' | 'anthropic'
  contextWindow?: number
  maxOutputTokens?: number
  supportsVision?: boolean
  thinkingMode?: 'enabled' | 'disabled'
  reasoningEffort?: string
  genPath?: string
  editPath?: string
  maxN?: number
  maxReferenceImages?: number
  maxImageMB?: number
  maxPromptChars?: number
  quality?: string
  outputFormat?: string
  inputFidelity?: string
}

/** 按连接键(baseUrl+规范)分组,生成连接与模型;模型沿用原 profile id,激活指向保持有效 */
function migrateFlatToGroups(
  profiles: LegacyProfile[],
  isImage: boolean
): { connections: ModelConnection[]; models: (ChatModel | ImageModel)[] } {
  const connections: ModelConnection[] = []
  const models: (ChatModel | ImageModel)[] = []
  for (const p of profiles) {
    const key = `${p.baseUrl}|${p.apiFormat ?? 'openai'}`
    let conn = connections.find((c) => `${c.baseUrl}|${c.apiFormat ?? 'openai'}` === key)
    if (!conn) {
      conn = normalizeConn(
        {
          id: `conn-${randomUUID().slice(0, 8)}`,
          name: p.name || hostOf(p.baseUrl) || '分组',
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          apiFormat: p.apiFormat,
          ...(isImage ? { genPath: p.genPath, editPath: p.editPath } : {})
        },
        isImage
      )
      connections.push(conn)
    } else if (!conn.apiKey && p.apiKey) {
      conn.apiKey = p.apiKey
    }
    models.push(
      isImage
        ? normalizeImageModel({
            id: p.id,
            groupId: conn.id,
            name: p.model || p.name,
            model: p.model,
            maxN: p.maxN,
            maxReferenceImages: p.maxReferenceImages,
            maxImageMB: p.maxImageMB,
            maxPromptChars: p.maxPromptChars,
            quality: p.quality,
            outputFormat: p.outputFormat,
            inputFidelity: p.inputFidelity
          })
        : normalizeChatModel({
            id: p.id,
            groupId: conn.id,
            name: p.model || p.name,
            model: p.model,
            contextWindow: p.contextWindow,
            maxOutputTokens: p.maxOutputTokens,
            supportsVision: p.supportsVision,
            thinkingMode: p.thinkingMode,
            reasoningEffort: p.reasoningEffort
          })
    )
  }
  return { connections, models }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 迁移与修复:旧版参数纠错 → v3 分组化 → 预置确保 → mock 清理 → 激活回落 */
function migrateLegacy(raw: unknown, prevVersion: number): { settings: AppSettings; changed: boolean } {
  const legacy = raw as Partial<AppSettings> & {
    chatProfiles?: LegacyProfile[]
    imageProfiles?: LegacyProfile[]
    activeChatProfileId?: string
    activeImageProfileId?: string
  }
  let changed = false
  let s: AppSettings

  if (prevVersion < 3 && (legacy.chatProfiles?.length || legacy.imageProfiles?.length)) {
    // v2 及更早:先对扁平 profile 做历史纠错,再分组化;剥离旧字段
    const chatFlat = (legacy.chatProfiles ?? []).map((p) => {
      if (p.baseUrl === 'https://api.deepseek.com/v1') {
        changed = true
        return { ...p, baseUrl: 'https://api.deepseek.com' }
      }
      if (p.model === 'deepseek-v4.1') {
        changed = true
        return { ...p, model: 'deepseek-flash', contextWindow: 1_048_576, maxOutputTokens: 65_536 }
      }
      return p
    })
    const imageFlat = (legacy.imageProfiles ?? []).map((p) => {
      if (p.model === 'deepseek-image' && p.baseUrl.includes('deepseek.com')) {
        changed = true
        const preset = DEFAULT_SETTINGS.imageModels[0]
        return { ...p, model: preset.model, genPath: '/v1/images/generations', editPath: '/v1/images/edits', maxN: 1, maxReferenceImages: 16, maxImageMB: 25, maxPromptChars: 32_000, quality: undefined, inputFidelity: undefined }
      }
      return p
    })
    const chat = migrateFlatToGroups(chatFlat, false)
    const image = migrateFlatToGroups(imageFlat, true)
    const { chatProfiles: _cp, imageProfiles: _ip, activeChatProfileId: _ac, activeImageProfileId: _ai, ...rest } = legacy
    void _cp
    void _ip
    void _ac
    void _ai
    s = {
      ...rest,
      chatConnections: chat.connections,
      chatModels: chat.models as ChatModel[],
      imageConnections: image.connections,
      imageModels: image.models as ImageModel[],
      activeChatModelId: legacy.activeChatProfileId,
      activeImageModelId: legacy.activeImageProfileId
    } as AppSettings
    changed = true
  } else {
    s = { ...(raw as AppSettings) }
  }

  // v2 一次性迁移:生图超时强制提升到 10 分钟
  if (prevVersion < 2 && s.imageTimeoutMs < 600_000) {
    changed = true
    s.imageTimeoutMs = 600_000
  }

  // mock 测试残留清理(本地 127.0.0.1:3117)
  const isMock = (baseUrl: string): boolean => baseUrl.includes('127.0.0.1:3117')
  const mockConnIds = new Set(
    [...s.chatConnections, ...s.imageConnections].filter((c) => isMock(c.baseUrl)).map((c) => c.id)
  )
  if (mockConnIds.size > 0) {
    changed = true
    s.chatConnections = s.chatConnections.filter((c) => !isMock(c.baseUrl))
    s.imageConnections = s.imageConnections.filter((c) => !isMock(c.baseUrl))
  }

  // 官方预置确保(连接+模型成对补齐,Key 保留用户已填)
  const ensureConn = (list: ModelConnection[], preset: ModelConnection, isImage: boolean): ModelConnection => {
    let conn = list.find((c) => c.id === preset.id) ?? list.find((c) => sameOrigin(c.baseUrl, preset.baseUrl))
    if (!conn) {
      changed = true
      conn = normalizeConn(structuredClone(preset), isImage)
      list.push(conn)
    }
    return conn
  }
  const dsConn = ensureConn(s.chatConnections, DEFAULT_SETTINGS.chatConnections[0], false)
  if (
    !s.chatModels.some((m) => m.id === DEFAULT_SETTINGS.chatModels[0].id) &&
    !s.chatModels.some((m) => m.groupId === dsConn.id && m.model === DEFAULT_SETTINGS.chatModels[0].model)
  ) {
    changed = true
    s.chatModels.push(normalizeChatModel({ ...structuredClone(DEFAULT_SETTINGS.chatModels[0]), groupId: dsConn.id }))
  }
  const cfConn = ensureConn(s.imageConnections, DEFAULT_SETTINGS.imageConnections[0], true)
  if (
    !s.imageModels.some((m) => m.id === DEFAULT_SETTINGS.imageModels[0].id) &&
    !s.imageModels.some((m) => m.groupId === cfConn.id && m.model === DEFAULT_SETTINGS.imageModels[0].model)
  ) {
    changed = true
    s.imageModels.push(normalizeImageModel({ ...structuredClone(DEFAULT_SETTINGS.imageModels[0]), groupId: cfConn.id }))
  }
  const zpConn = ensureConn(s.imageConnections, DEFAULT_SETTINGS.imageConnections[1], true)
  if (
    !s.imageModels.some((m) => m.id === DEFAULT_SETTINGS.imageModels[1].id) &&
    !s.imageModels.some((m) => m.groupId === zpConn.id && m.model === DEFAULT_SETTINGS.imageModels[1].model)
  ) {
    changed = true
    s.imageModels.push(normalizeImageModel({ ...structuredClone(DEFAULT_SETTINGS.imageModels[1]), groupId: zpConn.id }))
  }

  dropOrphans(s)

  // 同分组内按模型名去重(保留激活指向的那个,否则保留第一个)——幂等,可清理历史重复
  const dedupe = <T extends { id: string; groupId: string; model: string }>(list: T[], activeId: string | undefined): T[] => {
    const groups = new Map<string, T[]>()
    for (const m of list) {
      const key = `${m.groupId}|${m.model}`
      groups.set(key, [...(groups.get(key) ?? []), m])
    }
    const out: T[] = []
    for (const items of groups.values()) {
      const pick = items.find((m) => m.id === activeId) ?? items[0]
      out.push(pick)
      if (items.length > 1) changed = true
    }
    return out
  }
  s.chatModels = dedupe(s.chatModels, s.activeChatModelId)
  s.imageModels = dedupe(s.imageModels, s.activeImageModelId)

  // 激活指向回落
  if (!s.chatModels.some((m) => m.id === s.activeChatModelId)) {
    s.activeChatModelId = s.chatModels[0]?.id ?? DEFAULT_SETTINGS.chatModels[0].id
    changed = true
  }
  if (!s.imageModels.some((m) => m.id === s.activeImageModelId)) {
    s.activeImageModelId = s.imageModels[0]?.id ?? DEFAULT_SETTINGS.imageModels[0].id
    changed = true
  }

  s.schemaVersion = DEFAULT_SETTINGS.schemaVersion
  return { settings: normalizeAll(s), changed }
}

function sameOrigin(a: string, b: string): boolean {
  return hostOf(a) !== '' && hostOf(a) === hostOf(b)
}

class SettingsStore {
  private file = ''
  private cache: AppSettings | null = null

  load(): AppSettings {
    if (this.cache) return this.cache
    this.file = path.join(app.getPath('userData'), 'settings.json')
    let stored: Record<string, unknown> | null = null
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>
    } catch {
      stored = null // 首次启动无配置
    }
    if (!stored) {
      this.cache = this.save(structuredClone(DEFAULT_SETTINGS))
      return this.cache
    }
    const prevVersion = (stored.schemaVersion as number | undefined) ?? 0
    // 先解密(兼容 v2/v3 形态)→ 再迁移(v2 扁平 → v3 分组,内部含归一化)
    const migrated = migrateLegacy(decryptSettingsAny(stored), prevVersion)
    this.cache = migrated.settings
    if (migrated.changed) {
      this.cache = this.save(migrated.settings)
    }
    return this.cache
  }

  save(next: AppSettings): AppSettings {
    // 兜底:未经 load() 直接 save() 时(如脚本/测试调用)也要能定位到文件
    if (!this.file) this.file = path.join(app.getPath('userData'), 'settings.json')
    this.cache = normalizeAll({ ...next })
    dropOrphans(this.cache)
    // 激活指向失效回落
    if (!this.cache.chatModels.some((m) => m.id === this.cache!.activeChatModelId)) {
      this.cache.activeChatModelId = this.cache.chatModels[0]?.id
    }
    if (!this.cache.imageModels.some((m) => m.id === this.cache!.activeImageModelId)) {
      this.cache.activeImageModelId = this.cache.imageModels[0]?.id
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(encryptSettings(this.cache), null, 2), 'utf8')
    return this.cache
  }

  /** 顶栏快速切换当前使用的模型,持久化 */
  setActive(kind: 'chat' | 'image', modelId: string | undefined): AppSettings {
    const cur = this.load()
    return this.save({
      ...cur,
      activeChatModelId: kind === 'chat' ? modelId : cur.activeChatModelId,
      activeImageModelId: kind === 'image' ? modelId : cur.activeImageModelId
    })
  }

  /** 拼装:分组 + 模型 → 扁平语言模型 profile(Provider/Agent 使用) */
  activeChatProfile(): ChatProfile | undefined {
    return this.chatProfileOf(this.load().activeChatModelId)
  }

  /** 指定模型 id 的扁平 profile(后备模型、连通性测试共用) */
  chatProfileOf(modelId: string | undefined): ChatProfile | undefined {
    const s = this.load()
    const m = s.chatModels.find((x) => x.id === modelId)
    const c = m && s.chatConnections.find((x) => x.id === m.groupId)
    if (!m || !c) return undefined
    return {
      id: m.id,
      name: `${c.name}/${m.name}`,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: m.model,
      apiFormat: m.apiFormat ?? c.apiFormat,
      chatPath: m.chatPath,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      supportsVision: m.supportsVision,
      thinkingMode: m.thinkingMode,
      reasoningEffort: m.reasoningEffort
    }
  }

  /**
   * 主模型不可用时的后备候选(已按优先级排好、已排除主模型)。
   * 排序意图:优先换到**别的连接**(不同服务/Key,故障域不同),同连接内再按设置顺序。
   */
  fallbackChatProfiles(primaryId?: string): ChatProfile[] {
    const s = this.load()
    const ids = orderFallbackModelIds(s.chatModels, primaryId ?? s.activeChatModelId, s.chatFallback)
    return ids.map((id) => this.chatProfileOf(id)).filter((p): p is ChatProfile => Boolean(p))
  }


  /** 拼装:分组 + 模型 → 扁平生图 profile(Provider/Agent 使用) */
  activeImageProfile(): ImageProfile | undefined {
    const s = this.load()
    const m = s.imageModels.find((x) => x.id === s.activeImageModelId)
    const c = m && s.imageConnections.find((x) => x.id === m.groupId)
    if (!m || !c) return undefined
    return {
      id: m.id,
      name: `${c.name}/${m.name}`,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: m.model,
      genPath: c.genPath,
      editPath: c.editPath,
      maxN: m.maxN,
      maxReferenceImages: m.maxReferenceImages,
      maxImageMB: m.maxImageMB,
      maxPromptChars: m.maxPromptChars,
      quality: m.quality,
      outputFormat: m.outputFormat,
      inputFidelity: m.inputFidelity,
      pricePerImage: m.pricePerImage
    }
  }
}

let instance: SettingsStore | null = null

export function getSettings(): SettingsStore {
  if (!instance) instance = new SettingsStore()
  return instance
}
