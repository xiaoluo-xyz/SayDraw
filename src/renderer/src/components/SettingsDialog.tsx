// 设置 · 模型服务(v3):左右布局
// 左:连接分组树(分组 → 模型),支持新增分组/模型、删除
// 右:当前选中对象(分组 或 模型)的设置与调试参数;分组支持拉取模型列表一键添加

import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, ApiFormat, ChatModel, ImageModel, ModelConnection, ModelInfo, TestResult } from '@shared/types'
import { useSessionsStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'

type Tab = 'chat' | 'image' | 'advanced'
type Selection = { kind: 'group' | 'model'; id: string } | null

function newId(): string {
  return crypto.randomUUID()
}

const FORMAT_LABELS: Record<ApiFormat, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  'openai-responses': 'OpenAI Responses'
}

/** 实际请求 URL 预览(与主进程 endpointUrl 同规则:显式路径优先;地址含版本段直拼,否则补 /v1) */
function chatEndpointPreview(baseUrl: string, chatPath: string | undefined, format: ApiFormat | undefined): string {
  const rel = format === 'anthropic' ? 'messages' : format === 'openai-responses' ? 'responses' : 'chat/completions'
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (chatPath?.trim()) return `${base}/${chatPath.trim().replace(/^\/+/, '')}`
  return /\/v\d+$/.test(base) ? `${base}/${rel}` : `${base}/v1/${rel}`
}

const inputCls = 'w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600'

// 新建分组模板:预填官方连接配置,省去手查文档
interface ConnTemplate {
  key: string
  label: string
  desc: string
  conn: Omit<ModelConnection, 'id'>
  chatModel?: Omit<ChatModel, 'id' | 'groupId'>
  imageModel?: Omit<ImageModel, 'id' | 'groupId'>
}

const CHAT_TEMPLATES: ConnTemplate[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek 官方',
    desc: 'api.deepseek.com · 只填 API Key,附 deepseek-flash',
    conn: { name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', apiKey: '', apiFormat: 'openai' },
    chatModel: { name: 'deepseek-flash', model: 'deepseek-flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsVision: true }
  },
  {
    key: 'opencode',
    label: 'OpenCode Go',
    desc: '订阅网关 · GLM/Kimi/DeepSeek/Qwen 等;自动带会话头;识图仅 deepseek-v4-flash-vision-exp',
    conn: { name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '', apiFormat: 'openai' }
  },
  {
    key: 'packyapi',
    label: 'PackyAPI 中转 (cf.api.fan)',
    desc: '一个 Key 三规范:/v1/responses · /v1/messages · /v1/chat/completions;拉取模型后按模型选规范',
    conn: { name: 'PackyAPI (cf.api.fan)', baseUrl: 'https://cf.api.fan', apiKey: '', apiFormat: 'openai' }
  },
  {
    key: 'opencode-anthropic',
    label: 'OpenCode Go(Anthropic 模型)',
    desc: 'claude-haiku / MiniMax / Qwen 走 /messages 规范',
    conn: { name: 'OpenCode Go (Anthropic)', baseUrl: 'https://opencode.ai/zen/go', apiKey: '', apiFormat: 'anthropic' }
  },
  {
    key: 'zhipu',
    label: '智谱',
    desc: 'open.bigmodel.cn · GLM 系列',
    conn: { name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', apiFormat: 'openai' }
  },
  {
    key: 'custom',
    label: '自定义',
    desc: '空白分组,手动填写全部配置',
    conn: { name: '新分组', baseUrl: '', apiKey: '', apiFormat: 'openai' }
  }
]

const IMAGE_TEMPLATES: ConnTemplate[] = [
  {
    key: 'cffan',
    label: 'GPT-Image-2 (cf.api.fan)',
    desc: '生图+编辑 · n=1,参考图 16 张',
    conn: { name: 'GPT-Image-2 (cf.api.fan)', baseUrl: 'https://cf.api.fan', apiKey: '', genPath: '/v1/images/generations', editPath: '/v1/images/edits' },
    imageModel: { name: 'gpt-image-2', model: 'gpt-image-2', maxN: 1, maxReferenceImages: 16, maxImageMB: 25, maxPromptChars: 32_000, outputFormat: 'png' }
  },
  {
    key: 'zhipu',
    label: '智谱 CogView',
    desc: 'open.bigmodel.cn · 国产生图',
    conn: { name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', genPath: '/images/generations', editPath: '/images/edits' },
    imageModel: { name: 'cogview-4', model: 'cogview-4' }
  },
  {
    key: 'custom',
    label: '自定义',
    desc: '空白分组,手动填写全部配置',
    conn: { name: '新分组', baseUrl: '', apiKey: '', genPath: '/images/generations', editPath: '/images/edits' }
  }
]

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1" title={hint}>
      <span className="text-[10px] text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

export default function SettingsDialog() {
  const setSettingsOpen = useSessionsStore((s) => s.setSettingsOpen)
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<Tab>('chat')
  const [selected, setSelected] = useState<Selection>(null)
  const [templateOpen, setTemplateOpen] = useState(false)

  useEffect(() => {
    setDraft(structuredClone(settings))
  }, [settings])

  // 各分组拉取到的远端模型列表(不落盘,仅本次编辑会话)
  const [fetchedModels, setFetchedModels] = useState<Record<string, ModelInfo[]>>({})

  if (!draft) return null

  const patch = (p: Partial<AppSettings>): void => setDraft({ ...draft, ...p })
  const isChat = tab === 'chat'
  const connections = isChat ? draft.chatConnections : draft.imageConnections
  const models = isChat ? draft.chatModels : draft.imageModels

  const connName = (groupId: string): string => connections.find((c) => c.id === groupId)?.name ?? '?'

  // ---------- 增删 ----------

  const addGroup = (tpl: ConnTemplate): void => {
    const conn: ModelConnection = { ...tpl.conn, id: newId() }
    const next = { ...draft }
    if (isChat) {
      next.chatConnections = [...draft.chatConnections, conn]
      if (tpl.chatModel) next.chatModels = [...draft.chatModels, { ...tpl.chatModel, id: newId(), groupId: conn.id }]
    } else {
      next.imageConnections = [...draft.imageConnections, conn]
      if (tpl.imageModel) next.imageModels = [...draft.imageModels, { ...tpl.imageModel, id: newId(), groupId: conn.id }]
    }
    setDraft(next)
    setSelected({ kind: 'group', id: conn.id })
    setTemplateOpen(false)
  }

  const addModel = (groupId: string): void => {
    const base = { id: newId(), groupId, name: '新模型', model: '' }
    const model = isChat
      ? ({ ...base, contextWindow: 65536, maxOutputTokens: 8192, supportsVision: true } as ChatModel)
      : ({ ...base, maxN: 4, maxReferenceImages: 16, maxImageMB: 25, maxPromptChars: 32000 } as ImageModel)
    if (isChat) patch({ chatModels: [...draft.chatModels, model] })
    else patch({ imageModels: [...draft.imageModels, model] })
    setSelected({ kind: 'model', id: model.id })
  }

  /** 从 /models 拉取的元数据一键添加为模型 */
  const addFromFetched = (groupId: string, info: ModelInfo): void => {
    const base = { id: newId(), groupId, name: info.name || info.id, model: info.id }
    const model = isChat
      ? ({
          ...base,
          contextWindow: info.contextWindow ?? 65536,
          maxOutputTokens: info.maxOutputTokens ?? 8192,
          supportsVision: info.inputModalities ? info.inputModalities.includes('image') : true,
          ...(info.effortLevels?.length ? { effortLevels: info.effortLevels } : {})
        } as ChatModel)
      : ({ ...base, maxN: 4, maxReferenceImages: 16, maxImageMB: 25, maxPromptChars: 32000 } as ImageModel)
    if (isChat) patch({ chatModels: [...draft.chatModels, model] })
    else patch({ imageModels: [...draft.imageModels, model] })
    setSelected({ kind: 'model', id: model.id })
  }

  const removeGroup = (groupId: string): void => {
    if (!window.confirm(`删除分组「${connName(groupId)}」及其下全部模型?`)) return
    if (isChat) {
      patch({ chatConnections: draft.chatConnections.filter((c) => c.id !== groupId), chatModels: draft.chatModels.filter((m) => m.groupId !== groupId) })
    } else {
      patch({ imageConnections: draft.imageConnections.filter((c) => c.id !== groupId), imageModels: draft.imageModels.filter((m) => m.groupId !== groupId) })
    }
    setSelected(null)
  }

  const removeModel = (modelId: string): void => {
    if (isChat) patch({ chatModels: draft.chatModels.filter((m) => m.id !== modelId) })
    else patch({ imageModels: draft.imageModels.filter((m) => m.id !== modelId) })
    setSelected(null)
  }

  const doSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await save(draft)
      setSettingsOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const activeModelId = isChat ? draft.activeChatModelId : draft.activeImageModelId

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setSettingsOpen(false)}>
      <div
        className="flex h-[640px] max-h-full w-[960px] max-w-full flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-[#15171c] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-4 border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold">⚙ 设置 · 模型服务</h2>
          <div className="flex overflow-hidden rounded-lg border border-zinc-700 text-xs">
            {(
              [
                ['chat', '语言模型'],
                ['image', '生图模型'],
                ['advanced', '高级']
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className={`px-3 py-1 ${tab === key ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}
                onClick={() => {
                  setTab(key)
                  setSelected(null)
                  setTemplateOpen(false)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <button className="rounded px-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" onClick={() => setSettingsOpen(false)}>
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* ---------- 左:分组/模型树 ---------- */}
          {tab !== 'advanced' && (
            <aside className="flex w-[270px] shrink-0 flex-col border-r border-zinc-800">
              <div className="relative p-2.5">
                <button
                  className="w-full rounded-lg border border-dashed border-zinc-600 py-1.5 text-xs text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                  onClick={() => setTemplateOpen((o) => !o)}
                >
                  + 新建分组(连接)
                </button>
                {templateOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setTemplateOpen(false)} />
                    <div className="absolute left-2.5 right-2.5 top-full z-50 mt-1 rounded-xl border border-zinc-700 bg-[#1b1d23] p-1.5 shadow-2xl">
                      <p className="px-2 pb-1 pt-0.5 text-[10px] text-zinc-500">选择模板,自动填入官方配置(API Key 自填)</p>
                      {(isChat ? CHAT_TEMPLATES : IMAGE_TEMPLATES).map((tpl) => (
                        <button
                          key={tpl.key}
                          className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-800"
                          onClick={() => addGroup(tpl)}
                        >
                          <p className="text-xs text-zinc-200">{tpl.label}</p>
                          <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">{tpl.desc}</p>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-3">
                {connections.map((conn) => {
                  const groupModels = models.filter((m) => m.groupId === conn.id)
                  const groupSelected = selected?.kind === 'group' && selected.id === conn.id
                  return (
                    <div key={conn.id} className="mb-1">
                      <div
                        className={`group flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${
                          groupSelected ? 'bg-zinc-700/70 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'
                        }`}
                        onClick={() => setSelected({ kind: 'group', id: conn.id })}
                      >
                        <span className="shrink-0">📂</span>
                        <span className="min-w-0 flex-1 truncate font-medium">{conn.name || '(未命名分组)'}</span>
                        <span className="shrink-0 text-[10px] text-zinc-500">{groupModels.length}</span>
                        <button
                          className="hidden shrink-0 rounded px-1 text-[11px] text-emerald-400 hover:text-emerald-300 group-hover:block"
                          title="在本分组下添加模型"
                          onClick={(e) => {
                            e.stopPropagation()
                            addModel(conn.id)
                          }}
                        >
                          +
                        </button>
                        <button
                          className="hidden shrink-0 rounded px-1 text-[11px] text-zinc-500 hover:text-red-400 group-hover:block"
                          title="删除分组"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeGroup(conn.id)
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="mt-0.5 ml-4 space-y-0.5 border-l border-zinc-800 pl-2">
                        {groupModels.map((m) => {
                          const modelSelected = selected?.kind === 'model' && selected.id === m.id
                          const active = m.id === activeModelId
                          return (
                            <div
                              key={m.id}
                              className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
                                modelSelected ? 'bg-emerald-500/15 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50'
                              }`}
                              onClick={() => setSelected({ kind: 'model', id: m.id })}
                            >
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-emerald-400' : 'bg-transparent'}`} />
                              <span className="min-w-0 flex-1 truncate">{m.name || m.model || '(未命名)'}</span>
                              {active && <span className="shrink-0 text-[10px] text-emerald-400">当前</span>}
                              <button
                                className="hidden shrink-0 rounded px-1 text-[11px] text-zinc-500 hover:text-red-400 group-hover:block"
                                title="删除模型"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeModel(m.id)
                                }}
                              >
                                ✕
                              </button>
                            </div>
                          )
                        })}
                        {groupModels.length === 0 && <p className="px-2 py-1 text-[10px] text-zinc-600">暂无模型,点分组行 + 添加</p>}
                      </div>
                    </div>
                  )
                })}
                {connections.length === 0 && <p className="px-3 py-6 text-center text-xs text-zinc-600">尚无分组,先新建一个连接分组</p>}
              </div>
              {/* 主模型端点故障(上游 503 等)时的兜底策略 */}
              {isChat && (
                <div className="border-t border-zinc-800 p-2.5">
                  <label className="mb-1 block text-[10px] font-medium text-zinc-400">主模型不可用时</label>
                  <select
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200"
                    value={draft.chatFallback ?? 'auto'}
                    onChange={(e) => patch({ chatFallback: e.target.value })}
                    title="上游抖动会自动重试;换模型只影响当轮,不会改动你的「当前使用」"
                  >
                    <option value="auto">自动换一个其它模型(推荐)</option>
                    <option value="off">不换,只自动重试</option>
                    {draft.chatModels
                      .filter((m) => m.id !== draft.activeChatModelId)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          改用 {m.name || m.model}
                        </option>
                      ))}
                  </select>
                  <p className="mt-1 text-[10px] leading-snug text-zinc-600">
                    网关返回 5xx/限流时,当轮临时改用后备模型并在对话里注明;下一轮仍先试「当前使用」的模型。
                  </p>
                </div>
              )}
            </aside>
          )}

          {/* ---------- 右:选中对象编辑 ---------- */}
          <section className="min-w-0 flex-1 overflow-y-auto p-5">
            {tab === 'advanced' && <AdvancedPanel draft={draft} patch={patch} />}
            {tab !== 'advanced' && selected === null && (
              <div className="flex h-full items-center justify-center text-xs text-zinc-600">← 在左侧选择一个分组或模型进行配置</div>
            )}
            {tab !== 'advanced' && selected?.kind === 'group' && (
              <GroupPanel
                key={selected.id}
                draft={draft}
                patch={patch}
                tab={tab}
                groupId={selected.id}
                fetched={fetchedModels[selected.id] ?? []}
                onFetched={(list) => setFetchedModels((prev) => ({ ...prev, [selected.id]: list }))}
                onAddModel={(info) => addFromFetched(selected.id, info)}
              />
            )}
            {tab !== 'advanced' && selected?.kind === 'model' && (
              <ModelPanel key={selected.id} draft={draft} patch={patch} tab={tab} modelId={selected.id} />
            )}
          </section>
        </div>

        <footer className="flex items-center justify-between border-t border-zinc-800 px-5 py-3">
          <span className="text-[10px] text-zinc-600">分组=一个服务连接(地址+Key 共享);同分组下的模型复用连接与密钥</span>
          <span className="flex gap-2">
            <button className="rounded-lg px-4 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800" onClick={() => setSettingsOpen(false)}>
              取消
            </button>
            <button
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              disabled={saving}
              onClick={() => void doSave()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </span>
        </footer>
      </div>
    </div>
  )
}

// ---------- 分组面板 ----------

function GroupPanel(props: {
  draft: AppSettings
  patch: (p: Partial<AppSettings>) => void
  tab: Tab & ('chat' | 'image')
  groupId: string
  fetched: ModelInfo[]
  onFetched: (list: ModelInfo[]) => void
  onAddModel: (info: ModelInfo) => void
}) {
  const { draft, patch, tab, groupId } = props
  const isChat = tab === 'chat'
  const conns = isChat ? draft.chatConnections : draft.imageConnections
  const models = isChat ? draft.chatModels : draft.imageModels
  const conn = conns.find((c) => c.id === groupId)
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [fetchError, setFetchError] = useState('')

  if (!conn) return null
  const update = (p: Partial<ModelConnection>): void => {
    if (isChat) patch({ chatConnections: conns.map((c) => (c.id === groupId ? { ...c, ...p } : c)) })
    else patch({ imageConnections: conns.map((c) => (c.id === groupId ? { ...c, ...p } : c)) })
  }

  const fetchList = (): void => {
    setFetchState('loading')
    setFetchError('')
    window.api.settings
      .listModels(conn.baseUrl, conn.apiKey, isChat ? (conn.apiFormat as ApiFormat) : undefined)
      .then((list) => {
        props.onFetched(list)
        setFetchState('idle')
      })
      .catch((err: unknown) => {
        setFetchError(err instanceof Error ? err.message : String(err))
        setFetchState('error')
      })
  }

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-zinc-300">📂 分组(连接)设置</h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="分组名称">
          <input value={conn.name} onChange={(e) => update({ name: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Base URL" hint="填到版本路径,如 https://api.deepseek.com">
          <input value={conn.baseUrl} placeholder="https://…" onChange={(e) => update({ baseUrl: e.target.value })} className={inputCls} />
        </Field>
        <Field label="API Key(本分组模型共用)" hint="使用系统安全存储加密保存在本机">
          <input type="password" value={conn.apiKey} placeholder="sk-…(令牌分组须选 sora 的服务请留意)" onChange={(e) => update({ apiKey: e.target.value })} className={inputCls} />
        </Field>
        {isChat ? (
          <Field label="默认请求规范" hint="分组下模型的默认规范;模型可单独覆盖(中转站一 Key 多规范场景)">
            <select value={conn.apiFormat ?? 'openai'} onChange={(e) => update({ apiFormat: e.target.value as ApiFormat })} className={inputCls}>
              <option value="openai">OpenAI 兼容(/chat/completions)</option>
              <option value="openai-responses">OpenAI Responses(/responses)</option>
              <option value="anthropic">Anthropic(/v1/messages)</option>
            </select>
          </Field>
        ) : (
          <>
            <Field label="生成端点">
              <input value={conn.genPath ?? ''} placeholder="/images/generations" onChange={(e) => update({ genPath: e.target.value })} className={inputCls} />
            </Field>
            <Field label="编辑端点">
              <input value={conn.editPath ?? ''} placeholder="/images/edits" onChange={(e) => update({ editPath: e.target.value })} className={inputCls} />
            </Field>
          </>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium text-zinc-300">从服务端拉取模型列表</span>
          <button
            className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-50"
            disabled={fetchState === 'loading' || !conn.baseUrl || !conn.apiKey}
            onClick={fetchList}
          >
            {fetchState === 'loading' ? '拉取中…' : '拉取模型列表'}
          </button>
        </div>
        {fetchState === 'error' && <p className="text-[10px] text-red-400">{fetchError}</p>}
        {props.fetched.length === 0 && fetchState === 'idle' && (
          <p className="text-[10px] text-zinc-600">拉取后可查看各模型官方参数(上下文/输出/模态),一键添加为本分组模型</p>
        )}
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {props.fetched.map((info) => {
            const added = models.some((m) => m.model === info.id && m.groupId === groupId)
            const fmtK = (n?: number): string => (n ? (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)) : '—')
            return (
              <div key={info.id} className="flex items-center gap-2 rounded-lg bg-zinc-800/40 px-2.5 py-1.5 text-[11px]">
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-200">{info.id}</span>
                <span className="hidden shrink-0 text-zinc-500 sm:block">
                  {fmtK(info.contextWindow)} · {fmtK(info.maxOutputTokens)} · {info.inputModalities?.includes('image') ? '视觉' : '文本'}
                  {info.effortLevels?.length ? ` · 档位 ${info.effortLevels.join('/')}` : ''}
                </span>
                <button
                  className="shrink-0 rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-40"
                  disabled={added}
                  onClick={() => props.onAddModel(info)}
                >
                  {added ? '已添加' : '+ 添加'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------- 模型面板 ----------

function ModelPanel(props: { draft: AppSettings; patch: (p: Partial<AppSettings>) => void; tab: Tab & ('chat' | 'image'); modelId: string }) {
  const { draft, patch, tab, modelId } = props
  const isChat = tab === 'chat'
  const conns = isChat ? draft.chatConnections : draft.imageConnections
  const models = isChat ? draft.chatModels : draft.imageModels
  const model = models.find((m) => m.id === modelId)
  const conn = model && conns.find((c) => c.id === model.groupId)
  const [remoteModels, setRemoteModels] = useState<ModelInfo[]>([])
  const [test, setTest] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const listId = useMemo(() => `dl-${Math.random().toString(36).slice(2, 8)}`, [])

  if (!model || !conn) return null
  const activeModelId = isChat ? draft.activeChatModelId : draft.activeImageModelId
  const isActive = model.id === activeModelId

  const update = (p: Partial<ChatModel> & Partial<ImageModel>): void => {
    if (isChat) patch({ chatModels: models.map((m) => (m.id === modelId ? { ...m, ...p } : m)) as ChatModel[] })
    else patch({ imageModels: models.map((m) => (m.id === modelId ? { ...m, ...p } : m)) as ImageModel[] })
  }

  const runTest = (): void => {
    setTesting(true)
    setTest(null)
    const shared = { baseUrl: conn.baseUrl, apiKey: conn.apiKey, model: model.model }
    const p = isChat
      ? window.api.settings.testChat({
          ...shared,
          apiFormat: ((model as ChatModel).apiFormat ?? conn.apiFormat) as ApiFormat,
          chatPath: (model as ChatModel).chatPath
        })
      : window.api.settings.testImage({ ...shared, genPath: conn.genPath })
    p.then((r) => {
      setTest(r)
      setTesting(false)
    }).catch((e: unknown) => {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e) })
      setTesting(false)
    })
  }

  const meta = remoteModels.find((m) => m.id === model.model)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-300">
          🤖 模型设置 · <span className="text-zinc-500">{conn.name}/{model.name || model.model}</span>
        </h3>
        {isActive ? (
          <span className="rounded-full bg-emerald-500/20 px-2.5 py-1 text-[10px] text-emerald-300">当前使用</span>
        ) : (
          <button
            className="rounded-full border border-emerald-500/60 px-2.5 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/15"
            onClick={() => (isChat ? patch({ activeChatModelId: model.id }) : patch({ activeImageModelId: model.id }))}
          >
            设为当前使用
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="模型 ID(发给服务的 model 字段)">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <input
                value={model.model}
                placeholder={isChat ? 'deepseek-flash / gpt-4o …' : 'gpt-image-2 / cogview-4 …'}
                list={listId}
                onChange={(e) => {
                  const info = remoteModels.find((m) => m.id === e.target.value)
                  const nextP: Partial<ChatModel> & Partial<ImageModel> = { model: e.target.value }
                  if (info?.contextWindow) nextP.contextWindow = info.contextWindow
                  if (info?.maxOutputTokens) nextP.maxOutputTokens = info.maxOutputTokens
                  if (info?.inputModalities) nextP.supportsVision = info.inputModalities.includes('image')
                  if (info?.effortLevels?.length) nextP.effortLevels = info.effortLevels
                  update(nextP)
                }}
                className={inputCls}
              />
              <span className="w-1" />
              <button
                className="shrink-0 text-[10px] text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                disabled={!conn.baseUrl || !conn.apiKey}
                onClick={() =>
                  window.api.settings
                    .listModels(conn.baseUrl, conn.apiKey, isChat ? (conn.apiFormat as ApiFormat) : undefined)
                    .then(setRemoteModels)
                    .catch(() => setRemoteModels([]))
                }
              >
                拉取
              </button>
            </div>
            <datalist id={listId}>
              {remoteModels.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
            {meta && (
              <span className="text-[10px] text-zinc-500">
                官方:上下文 {meta.contextWindow ? `${Math.round(meta.contextWindow / 1024)}K` : '—'} · 输出{' '}
                {meta.maxOutputTokens ? `${Math.round(meta.maxOutputTokens / 1024)}K` : '—'} ·{' '}
                {meta.inputModalities?.includes('image') ? '✓ 视觉' : '仅文本'}(选中自动填参)
              </span>
            )}
          </div>
        </Field>
        <Field label="展示名">
          <input value={model.name} onChange={(e) => update({ name: e.target.value })} className={inputCls} />
        </Field>

        {isChat && (
          <div className="col-span-2 grid grid-cols-2 gap-3">
            <Field label="请求规范" hint="中转站同一分组可挂不同规范的模型;不选则跟随分组">
              <select
                value={(model as ChatModel).apiFormat ?? ''}
                onChange={(e) => update({ apiFormat: (e.target.value || undefined) as ApiFormat | undefined })}
                className={inputCls}
              >
                <option value="">跟随分组({FORMAT_LABELS[(conn.apiFormat as ApiFormat) ?? 'openai']})</option>
                <option value="openai">openai · /chat/completions</option>
                <option value="openai-responses">openai-responses · /responses</option>
                <option value="anthropic">anthropic · /v1/messages</option>
              </select>
            </Field>
            <Field label="请求地址(可选)" hint="默认按规范与 Base URL 自动拼接;服务端点特殊时填实际路径,如 /v1/responses">
              <input
                value={(model as ChatModel).chatPath ?? ''}
                placeholder="自动拼接"
                onChange={(e) => update({ chatPath: e.target.value.trim() || undefined })}
                className={inputCls}
              />
            </Field>
            <p className="col-span-2 -mt-1 break-all text-[10px] text-zinc-600">
              实际请求:{chatEndpointPreview(conn.baseUrl, (model as ChatModel).chatPath, ((model as ChatModel).apiFormat as ApiFormat) ?? (conn.apiFormat as ApiFormat))}
            </p>
          </div>
        )}

        {isChat ? <ChatModelFields model={model as ChatModel} update={update} /> : <ImageModelFields model={model as ImageModel} update={update} />}
      </div>

      <div className="flex items-center gap-3 border-t border-zinc-800 pt-3">
        <button
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-50"
          disabled={testing || !conn.baseUrl || !conn.apiKey || !model.model}
          onClick={runTest}
        >
          {testing ? '测试中…' : isChat ? '连通性测试' : '测试(实际生成一张小图)'}
        </button>
        {test && <span className={`text-[11px] ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}>{test.message}</span>}
        {!isChat && test && <span className="text-[10px] text-zinc-600">图片测试消耗少量额度</span>}
      </div>
    </div>
  )
}

function ChatModelFields(props: { model: ChatModel; update: (p: Partial<ChatModel> & Partial<ImageModel>) => void }) {
  const { model: m, update } = props
  return (
    <>
      <Field label="上下文窗口(token)">
        <input
          type="number"
          min={4096}
          step={1024}
          value={m.contextWindow ?? 65536}
          onChange={(e) => update({ contextWindow: Math.max(4096, Number(e.target.value) || 65536) })}
          className={inputCls}
        />
      </Field>
      <Field label="最大输出(token)">
        <input
          type="number"
          min={256}
          step={256}
          value={m.maxOutputTokens ?? 8192}
          onChange={(e) => update({ maxOutputTokens: Math.max(256, Number(e.target.value) || 8192) })}
          className={inputCls}
        />
      </Field>
      <Field label="多模态" hint="本应用核心依赖图像识别,关闭后模型看不到图片">
        <select
          value={m.supportsVision === false ? 'no' : 'yes'}
          onChange={(e) => update({ supportsVision: e.target.value === 'yes' })}
          className={inputCls}
        >
          <option value="yes">支持图像输入</option>
          <option value="no">仅文本(⚠ 影响修图)</option>
        </select>
      </Field>
      <Field label="思考模式">
        <select
          value={m.thinkingMode ?? ''}
          onChange={(e) => update({ thinkingMode: (e.target.value || undefined) as ChatModel['thinkingMode'] })}
          className={inputCls}
        >
          <option value="">跟随服务端默认</option>
          <option value="enabled">开启</option>
          <option value="disabled">关闭</option>
        </select>
      </Field>
      <EffortField model={m} update={update} />
    </>
  )
}

/** 推理强度:可增删的档位列表 + 当前选择 */
function EffortField(props: { model: ChatModel; update: (p: Partial<ChatModel> & Partial<ImageModel>) => void }) {
  const { model: m, update } = props
  const [input, setInput] = useState('')
  const levels = m.effortLevels?.length ? m.effortLevels : ['none', 'low', 'medium', 'high', 'max']

  const setLevels = (next: string[]): void => {
    const clean = [...new Set(next.map((s) => s.trim()).filter(Boolean))]
    update({ effortLevels: clean })
    // 当前选中的档位被删掉时清空选择
    if (m.reasoningEffort && !clean.includes(m.reasoningEffort)) update({ reasoningEffort: undefined })
  }

  return (
    <div className="col-span-2 rounded-xl border border-zinc-800 p-2.5">
      <p className="mb-1.5 text-[10px] text-zinc-500">推理强度档位(可增删,底部栏下拉使用此列表;拉取模型列表会自动带出官方档位)</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {levels.map((lv) => (
          <span
            key={lv}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ${
              m.reasoningEffort === lv ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-300'
            }`}
          >
            {lv}
            <button className="text-zinc-500 hover:text-red-400" title="删除档位" onClick={() => setLevels(levels.filter((x) => x !== lv))}>
              ✕
            </button>
          </span>
        ))}
        {levels.length === 0 && <span className="text-[11px] text-zinc-600">空列表(底部栏只显示 default)</span>}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) {
              setLevels([...levels, input])
              setInput('')
            }
          }}
          placeholder="新增档位,如 xhigh / minimal,回车添加"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-200 placeholder:font-sans placeholder:text-zinc-600"
        />
        <button
          className="rounded-md border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-40"
          disabled={!input.trim()}
          onClick={() => {
            setLevels([...levels, input])
            setInput('')
          }}
        >
          添加
        </button>
        <select
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-300"
          value={m.reasoningEffort ?? ''}
          title="当前使用的推理强度"
          onChange={(e) => update({ reasoningEffort: e.target.value || undefined })}
        >
          <option value="">default</option>
          {levels.map((lv) => (
            <option key={lv} value={lv}>
              {lv}
            </option>
          ))}
          {m.reasoningEffort && !levels.includes(m.reasoningEffort) && (
            <option value={m.reasoningEffort}>{m.reasoningEffort}(当前)</option>
          )}
        </select>
      </div>
    </div>
  )
}

function ImageModelFields(props: { model: ImageModel; update: (p: Partial<ChatModel> & Partial<ImageModel>) => void }) {
  const { model: m, update } = props
  return (
    <>
      <Field label="单次张数上限" hint="部分服务仅支持 1 张(如 gpt-image-2)">
        <input
          type="number"
          min={1}
          max={10}
          value={m.maxN ?? 4}
          onChange={(e) => update({ maxN: Math.max(1, Number(e.target.value) || 4) })}
          className={inputCls}
        />
      </Field>
      <Field label="参考图上限(张)" hint="edits 接口 image[] 数量(OpenAI 上限 16)">
        <input
          type="number"
          min={1}
          max={64}
          value={m.maxReferenceImages ?? 16}
          onChange={(e) => update({ maxReferenceImages: Math.max(1, Number(e.target.value) || 16) })}
          className={inputCls}
        />
      </Field>
      <Field label="单图上限(MB)">
        <input
          type="number"
          min={1}
          max={100}
          value={m.maxImageMB ?? 25}
          onChange={(e) => update({ maxImageMB: Math.max(1, Number(e.target.value) || 25) })}
          className={inputCls}
        />
      </Field>
      <Field label="提示词上限(字符)">
        <input
          type="number"
          min={500}
          step={500}
          value={m.maxPromptChars ?? 32000}
          onChange={(e) => update({ maxPromptChars: Math.max(500, Number(e.target.value) || 32000) })}
          className={inputCls}
        />
      </Field>
      <Field label="质量 quality">
        <select value={m.quality ?? ''} onChange={(e) => update({ quality: e.target.value || undefined })} className={inputCls}>
          <option value="">服务默认</option>
          <option value="auto">auto</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </Field>
      <Field label="输出格式">
        <select value={m.outputFormat ?? ''} onChange={(e) => update({ outputFormat: e.target.value || undefined })} className={inputCls}>
          <option value="">服务默认</option>
          <option value="png">png</option>
          <option value="jpeg">jpeg</option>
        </select>
      </Field>
      <Field label="编辑保真 input_fidelity" hint="实测 cf.api.fan 会拒绝此参数,Provider 已做自动降级">
        <select value={m.inputFidelity ?? ''} onChange={(e) => update({ inputFidelity: e.target.value || undefined })} className={inputCls}>
          <option value="">不发送</option>
          <option value="high">high</option>
          <option value="low">low</option>
        </select>
      </Field>
      <Field label="单张成本(元)" hint="用于会话成本估算;按该模型的单张价格填写,留空按 0 计">
        <input
          type="number"
          min={0}
          step="0.01"
          value={m.pricePerImage ?? ''}
          placeholder="如 0.35"
          onChange={(e) => update({ pricePerImage: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
          className={inputCls}
        />
      </Field>
    </>
  )
}

// ---------- 高级面板 ----------

function AdvancedPanel(props: { draft: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  const { draft, patch } = props
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-zinc-300">高级</h3>
      <div className="grid max-w-md grid-cols-1 gap-3 text-xs text-zinc-400">
        <Field label="对话空闲超时(秒)" hint="连续这么久没有数据返回才中断;模型持续输出(含思考)不算超时">
          <input
            type="number"
            min={10}
            max={600}
            value={Math.round(draft.chatTimeoutMs / 1000)}
            onChange={(e) => patch({ chatTimeoutMs: Math.max(10, Number(e.target.value) || 120) * 1000 })}
            className={inputCls}
          />
        </Field>
        <Field label="生图超时(秒)">
          <input
            type="number"
            min={30}
            max={1200}
            value={Math.round(draft.imageTimeoutMs / 1000)}
            onChange={(e) => patch({ imageTimeoutMs: Math.max(30, Number(e.target.value) || 600) * 1000 })}
            className={inputCls}
          />
        </Field>
        <Field label="携带历史图片数" hint="控制发给语言模型的图片 token 消耗">
          <input
            type="number"
            min={1}
            max={12}
            value={draft.maxHistoryImages}
            onChange={(e) => patch({ maxHistoryImages: Math.min(12, Math.max(1, Number(e.target.value) || 6)) })}
            className={inputCls}
          />
        </Field>
      </div>
      <p className="max-w-lg text-[11px] leading-relaxed text-zinc-500">
        预置说明:语言模型默认 DeepSeek 官方(deepseek-flash,只填 Key);生图默认 GPT-Image-2(cf.api.fan,令牌分组须选 sora)与智谱
        CogView-4。任何 OpenAI/Anthropic 兼容服务都可自建分组接入。
      </p>
    </div>
  )
}
