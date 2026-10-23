// preload 桥:向渲染进程暴露类型化 API(基于 contextBridge,渲染进程无 Node 能力)

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AgentEvent,
  ApiFormat,
  AppSettings,
  ImageAsset,
  ImageBrief,
  ModelInfo,
  SessionData,
  SessionSummary,
  TestResult,
  WindowState
} from '@shared/types'

const api = {
  /** 订阅 Agent 事件流,返回取消订阅函数 */
  onAgentEvent(callback: (event: AgentEvent) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, event: AgentEvent): void => callback(event)
    ipcRenderer.on(IPC.EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.EVENT, listener)
  },

  app: {
    /** 应用版本号(侧栏展示;别再写死,免得界面版本和实际构建对不上) */
    version: (): Promise<string> => ipcRenderer.invoke(IPC.APP_INFO)
  },

  /** 窗口控制:应用是无边框窗口,顶部没有系统标题栏,按钮由渲染进程自绘 */
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),
    /** 最大化 ↔ 还原,返回操作后的最大化状态 */
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_TOGGLE_MAXIMIZE),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),
    /** 最大化状态变化(双击拖拽区、Win+↑、贴靠布局都会触发),返回取消订阅函数 */
    onStateChange(callback: (state: WindowState) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, state: WindowState): void => callback(state)
      ipcRenderer.on(IPC.WINDOW_STATE, listener)
      return () => ipcRenderer.removeListener(IPC.WINDOW_STATE, listener)
    }
  },

  sessions: {
    list: (): Promise<SessionSummary[]> => ipcRenderer.invoke(IPC.SESSIONS_LIST),
    create: (opts?: string | { title?: string; projectPath?: string }): Promise<SessionSummary> =>
      ipcRenderer.invoke(IPC.SESSIONS_CREATE, typeof opts === 'string' ? { title: opts } : (opts ?? {})),
    rename: (id: string, title: string): Promise<boolean> => ipcRenderer.invoke(IPC.SESSIONS_RENAME, id, title),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.SESSIONS_REMOVE, id),
    /** 选择项目文件夹(主进程弹窗),自动初始化 要求.md / 需求规格.md;取消返回 null */
    selectProject: (sessionId: string): Promise<{ path: string; createdFiles: string[] } | null> =>
      ipcRenderer.invoke(IPC.SESSIONS_SELECT_PROJECT, sessionId),
    /** 把会话移出工作区(只解除关联,不动磁盘文件) */
    clearProject: (sessionId: string): Promise<SessionSummary | undefined> =>
      ipcRenderer.invoke(IPC.SESSIONS_CLEAR_PROJECT, sessionId)
  },

  chat: {
    history: (sessionId: string): Promise<SessionData> => ipcRenderer.invoke(IPC.CHAT_HISTORY, sessionId),
    send: (
      sessionId: string,
      text: string,
      assetIds?: string[],
      confirmBrief?: boolean,
      fileTexts?: { name: string; content: string }[]
    ): Promise<boolean> => ipcRenderer.invoke(IPC.CHAT_SEND, sessionId, text, assetIds, confirmBrief, fileTexts),
    cancel: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(IPC.CHAT_CANCEL, sessionId),
    /** 在问答面板作答 ask_user */
    answerQuestion: (sessionId: string, questionId: string, answer: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.CHAT_ANSWER_QUESTION, sessionId, questionId, answer)
  },

  assets: {
    /** dataUrl 上传(image/*;base64),kind: user-upload | mask;label 用于区分蒙版类型 */
    upload: (sessionId: string, dataUrl: string, kind: ImageAsset['kind'], baseAssetId?: string, label?: string): Promise<ImageAsset> =>
      ipcRenderer.invoke(IPC.ASSETS_UPLOAD, sessionId, dataUrl, kind, baseAssetId, label),
    /** 弹出图片右键菜单(复制/另存为) */
    contextMenu: (assetId: string): Promise<boolean> => ipcRenderer.invoke(IPC.ASSETS_CONTEXT_MENU, assetId),
    /** 选用候选图:草稿 → 正式版本链成员 */
    promote: (assetId: string): Promise<ImageAsset | undefined> => ipcRenderer.invoke(IPC.ASSETS_PROMOTE, assetId),
    /** 同参再生成:用该图的提示词与参数再出一张 */
    regenerate: (assetId: string): Promise<ImageAsset> => ipcRenderer.invoke(IPC.ASSETS_REGENERATE, assetId),
    /** 导出生成参数(.recipe.json),取消返回 false */
    exportRecipe: (assetId: string): Promise<boolean> => ipcRenderer.invoke(IPC.ASSETS_RECIPE, assetId),
    /** 读取资产为 data URL(画布合成用,data: 源不会污染 canvas) */
    dataUrl: (assetId: string): Promise<string | null> => ipcRenderer.invoke(IPC.ASSETS_DATA_URL, assetId),
    /** 批量导出多比例图片 + 交付清单;不传 dir 时弹文件夹选择框 */
    exportSet: (payload: {
      files: { fileName: string; dataUrl: string }[]
      manifest?: string
      dir?: string
    }): Promise<{ ok: boolean; saved: number; dir: string }> => ipcRenderer.invoke(IPC.ASSETS_EXPORT_SET, payload)
  },

  brief: {
    /** 直接补写需求规格(套用模板);槽位变化会自动作废已确认状态 */
    patch: (sessionId: string, patch: Partial<ImageBrief>): Promise<ImageBrief> =>
      ipcRenderer.invoke(IPC.BRIEF_PATCH, sessionId, patch)
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    save: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings),
    setActive: (kind: 'chat' | 'image', profileId: string | undefined): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET_ACTIVE, kind, profileId),
    listModels: (baseUrl: string, apiKey: string, apiFormat?: ApiFormat): Promise<ModelInfo[]> =>
      ipcRenderer.invoke(IPC.SETTINGS_LIST_MODELS, baseUrl, apiKey, apiFormat),
    testChat: (profile: { baseUrl: string; apiKey: string; model: string; apiFormat?: ApiFormat; chatPath?: string }): Promise<TestResult> =>
      ipcRenderer.invoke(IPC.SETTINGS_TEST_CHAT, profile),
    testImage: (profile: { baseUrl: string; apiKey: string; model: string; genPath?: string }): Promise<TestResult> =>
      ipcRenderer.invoke(IPC.SETTINGS_TEST_IMAGE, profile)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
