// 主进程 / preload / 渲染进程共享的类型契约

// ---------- 会话与消息 ----------

export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  coverAssetId?: string
  /** 当前项目文件夹(选择后自动生成 要求.md / 需求规格.md) */
  projectPath?: string
}

export type AssetKind = 'user-upload' | 'generated' | 'edited' | 'mask'

export interface ImageAsset {
  id: string
  sessionId: string
  kind: AssetKind
  /** 版本链:编辑图的来源图 */
  parentId?: string
  /** 蒙版对应的底图 */
  baseAssetId?: string
  /** 蒙版类型:binary=接口用二值蒙版(透明区待改),overlay=给模型看的彩色编号标注图 */
  label?: string
  /** 相对路径:assets/{sessionId}/{fileName} */
  fileName: string
  mime: string
  width?: number
  height?: number
  /** 生成/编辑此图时使用的提示词 */
  prompt?: string
  createdAt: number
}

export type ToolStatus = 'running' | 'ok' | 'error' | 'rejected'

export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  resultSummary?: string
  /** 展开查看的完整结果(截断保存) */
  resultFull?: string
  assetIds?: string[]
  error?: string
  startedAt?: number
  durationMs?: number
}

/** 消息内的展示块(按发生顺序):文本 / 思考 / 工具调用 */
export interface MessageBlock {
  type: 'text' | 'reasoning' | 'tool'
  text?: string
  tool?: ToolCallRecord
  startedAt?: number
  endedAt?: number
}

export interface FileTextAttachment {
  name: string
  content: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  text: string
  assetIds: string[]
  /** 按序展示块(新版);旧消息无此字段时回退为平铺渲染 */
  blocks?: MessageBlock[]
  /** 用户附带的结构化输出块(同一消息内按序渲染) */
  userBlocks?: MessageBlock[]
  fileTexts?: FileTextAttachment[]
  toolCalls?: ToolCallRecord[]
  /** 兼容旧消息的思考内容 */
  reasoning?: string
  createdAt: number
  /** 本轮起止与耗时 */
  startedAt?: number
  durationMs?: number
  stopReason?: 'completed' | 'aborted' | 'error'
  /** 失败原因(仅 stopReason==='error' 时有值;落盘以便刷新后仍能看到为什么出错) */
  error?: string
}

// ---------- 需求规格(ImageBrief) ----------

export interface ImageBrief {
  /** 主体:画什么(人/物/场景) */
  subject?: string
  /** 风格:摄影 / 插画 / 3D / 水彩 / 国潮 … */
  style?: string
  /** 构图:视角、景别、布局 */
  composition?: string
  /** 色调氛围 */
  colorTone?: string
  /** 画面比例:1:1 16:9 9:16 4:3 3:4 */
  aspectRatio?: string
  /** 输出分辨率:如 1024x1024 / 2048x2048 / 3840x2160(生成前必须明确) */
  resolution?: string
  /** 用途:头像 / 海报 / 壁纸 / 文章配图 … */
  usage?: string
  /** 要避免的元素 */
  negativePrompts?: string
  /** 其他补充说明 */
  notes?: string
  /** 硬确认门:未确认时编排层拒绝 generate_image */
  confirmedAt?: number
}

export interface BriefSlotMeta {
  key: keyof ImageBrief
  label: string
  hint: string
  /** 关键槽位:缺失时模型应主动询问 */
  required?: boolean
}

export const BRIEF_SLOTS: BriefSlotMeta[] = [
  { key: 'subject', label: '主体', hint: '画什么:人物 / 物体 / 场景', required: true },
  { key: 'style', label: '风格', hint: '摄影、插画、3D、水彩…', required: true },
  { key: 'composition', label: '构图', hint: '视角、景别、画面布局' },
  { key: 'colorTone', label: '色调氛围', hint: '冷暖、明亮、暗黑…' },
  { key: 'aspectRatio', label: '画面比例', hint: '1:1 / 16:9 / 9:16 …', required: true },
  { key: 'resolution', label: '分辨率', hint: '1024x1024 / 2048x2048 / 3840x2160', required: true },
  { key: 'usage', label: '用途', hint: '头像、海报、壁纸…' },
  { key: 'negativePrompts', label: '避免元素', hint: '不希望出现的内容' },
  { key: 'notes', label: '补充说明', hint: '其他要求' }
]

export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const

// ---------- 设置(v3:连接分组 + 模型列表) ----------

/** 请求规范 */
export type ApiFormat = 'openai' | 'anthropic' | 'openai-responses'

/** 连接分组:一个服务的接入点(地址+密钥),下辖若干模型 */
export interface ModelConnection {
  id: string
  name: string
  /** 含版本路径,如 https://api.deepseek.com 或 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl: string
  apiKey: string
  /** 请求规范(语言模型连接的默认规范;模型可单独覆盖),默认 openai 兼容 */
  apiFormat?: ApiFormat
  /** 图片连接:生成端点,默认 /images/generations */
  genPath?: string
  /** 图片连接:编辑端点,默认 /images/edits */
  editPath?: string
}

/** 语言模型(挂在某个连接分组下) */
export interface ChatModel {
  id: string
  groupId: string
  /** 展示名(默认同 model) */
  name: string
  /** 模型 ID(发给服务的 model 字段) */
  model: string
  /** 请求规范覆盖(未设置=跟随分组);同一分组可混挂不同规范的模型(中转站场景) */
  apiFormat?: ApiFormat
  /** 请求地址路径覆盖(未设置=按规范与 Base URL 自动拼接),如 /v1/responses */
  chatPath?: string
  /** 上下文窗口(token),用于历史裁剪;默认 65536 */
  contextWindow?: number
  /** 最大输出 token;默认 8192 */
  maxOutputTokens?: number
  /** 语言模型必须支持图像识别(本应用核心依赖) */
  supportsVision?: boolean
  /** 思考模式:未设置=跟随服务端默认 */
  thinkingMode?: 'enabled' | 'disabled'
  /** 推理强度:未设置=服务端默认 */
  reasoningEffort?: string
  /** 该模型可选的推理强度档位(可增删;空=默认档位 none/low/medium/high/max) */
  effortLevels?: string[]
}

/** 生图模型(挂在某个连接分组下) */
export interface ImageModel {
  id: string
  groupId: string
  name: string
  model: string
  /** 单次生成张数上限(部分服务仅支持 1);默认 4 */
  maxN?: number
  /** 参考图/源图数量上限(edits image[]);默认 16 */
  maxReferenceImages?: number
  /** 单张参考图大小上限 MB;默认 25 */
  maxImageMB?: number
  /** 提示词长度上限(字符);默认 32000 */
  maxPromptChars?: number
  /** low / medium / high / auto;不填走服务默认 */
  quality?: string
  /** png / jpeg;不填走服务默认 */
  outputFormat?: string
  /** 编辑接口 input_fidelity;不填不发送 */
  inputFidelity?: string
}

export interface AppSettings {
  chatConnections: ModelConnection[]
  chatModels: ChatModel[]
  imageConnections: ModelConnection[]
  imageModels: ImageModel[]
  activeChatModelId?: string
  activeImageModelId?: string
  /** 对话请求空闲超时:连续这么久没有任何数据返回才中断(长回答不再被整请求 deadline 误杀) */
  chatTimeoutMs: number
  imageTimeoutMs: number
  /** 发送给 LLM 的历史图片上限(控制 token) */
  maxHistoryImages: number
  /** 配置结构版本(一次性迁移用,不在 UI 展示) */
  schemaVersion?: number
}

// ---------- 供 Provider/Agent 使用的拼装式扁平 profile(由 分组+模型 组合而成) ----------

export interface ChatProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  apiFormat?: ApiFormat
  /** 请求地址路径覆盖(模型级;未设置按规范默认拼接) */
  chatPath?: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsVision?: boolean
  thinkingMode?: 'enabled' | 'disabled'
  reasoningEffort?: string
}

export interface ImageProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
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

/** /models 返回的模型元数据 */
export interface ModelInfo {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  /** 如 ['text','image'] */
  inputModalities?: string[]
  /** 支持的推理强度档位 */
  effortLevels?: string[]
}

/** DeepSeek 官方默认预设:只需填 API Key 即可用(参数依据官方文档 2026-10) */
export const DEEPSEEK_CONN_ID = 'conn-deepseek'
export const DEEPSEEK_CHAT_MODEL_ID = 'model-deepseek-flash'
export const CF_FAN_CONN_ID = 'conn-cf-fan'
export const GPT_IMAGE2_MODEL_ID = 'model-gpt-image-2'
export const ZHIPU_CONN_ID = 'conn-zhipu'
export const COGVIEW_MODEL_ID = 'model-cogview-4'

export const DEFAULT_SETTINGS: AppSettings = {
  chatConnections: [
    {
      id: DEEPSEEK_CONN_ID,
      name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      apiFormat: 'openai'
    }
  ],
  chatModels: [
    {
      id: DEEPSEEK_CHAT_MODEL_ID,
      groupId: DEEPSEEK_CONN_ID,
      name: 'deepseek-flash',
      model: 'deepseek-flash',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      supportsVision: true
    }
  ],
  // 生图双预置:GPT-Image-2(cf.api.fan,依据 docs.packyapi.ai 文档 2026-10,其余参数走文档默认)+ 智谱 CogView-4
  imageConnections: [
    {
      id: CF_FAN_CONN_ID,
      name: 'GPT-Image-2 (cf.api.fan)',
      baseUrl: 'https://cf.api.fan',
      apiKey: '',
      genPath: '/v1/images/generations',
      editPath: '/v1/images/edits'
    },
    {
      id: ZHIPU_CONN_ID,
      name: '智谱',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: '',
      genPath: '/images/generations',
      editPath: '/images/edits'
    }
  ],
  imageModels: [
    {
      id: GPT_IMAGE2_MODEL_ID,
      groupId: CF_FAN_CONN_ID,
      name: 'gpt-image-2',
      model: 'gpt-image-2',
      maxN: 1,
      maxReferenceImages: 16,
      maxImageMB: 25,
      maxPromptChars: 32_000,
      outputFormat: 'png'
    },
    {
      id: COGVIEW_MODEL_ID,
      groupId: ZHIPU_CONN_ID,
      name: 'cogview-4',
      model: 'cogview-4'
    }
  ],
  activeChatModelId: DEEPSEEK_CHAT_MODEL_ID,
  activeImageModelId: GPT_IMAGE2_MODEL_ID,
  chatTimeoutMs: 120_000,
  imageTimeoutMs: 600_000,
  maxHistoryImages: 6,
  schemaVersion: 3
}

export interface TestResult {
  ok: boolean
  message: string
}

// ---------- Agent 事件(主进程 → 渲染进程) ----------

export interface StreamingState {
  active: boolean
  text: string
  toolCalls: ToolCallRecord[]
  assetIds: string[]
  error?: string
}

/** ask_user 工具的提问(选择题,UI 面板作答) */
export interface AgentQuestionOption {
  label: string
  description?: string
  /** 推荐答案(选择题必须有且仅有一个) */
  recommended?: boolean
}

export interface AgentQuestion {
  id: string
  text: string
  options: AgentQuestionOption[]
  /** 允许自由文本作答(默认允许,面板始终提供"其他"输入) */
  allowFreeText?: boolean
}

export type AgentEvent =
  | { type: 'user-message'; sessionId: string; message: ChatMessage }
  | { type: 'run-start'; sessionId: string }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'reasoning-delta'; sessionId: string; text: string }
  | { type: 'brief-updated'; sessionId: string; brief: ImageBrief }
  | { type: 'tool-status'; sessionId: string; call: ToolCallRecord }
  | { type: 'asset-added'; sessionId: string; asset: ImageAsset }
  | { type: 'ask-user'; sessionId: string; question: AgentQuestion }
  | { type: 'message-final'; sessionId: string; message: ChatMessage }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'run-end'; sessionId: string }

// ---------- 会话历史加载 ----------

export interface SessionData {
  session: SessionSummary
  messages: ChatMessage[]
  assets: Record<string, ImageAsset>
  brief: ImageBrief
}
