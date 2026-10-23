// IPC 通道名集中定义,主进程与 preload 共用

export const IPC = {
  /** 主进程 → 渲染进程 推送 AgentEvent */
  EVENT: 'agent:event',

  SESSIONS_LIST: 'sessions:list',
  SESSIONS_CREATE: 'sessions:create',
  SESSIONS_RENAME: 'sessions:rename',
  SESSIONS_REMOVE: 'sessions:remove',
  SESSIONS_SELECT_PROJECT: 'sessions:select-project',
  SESSIONS_CLEAR_PROJECT: 'sessions:clear-project',

  CHAT_HISTORY: 'chat:history',
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_ANSWER_QUESTION: 'chat:answer-question',
  /** 渲染进程直接补写需求规格(套用模板);变更会自动作废已有确认 */
  BRIEF_PATCH: 'brief:patch',
  ASSETS_UPLOAD: 'assets:upload',
  ASSETS_CONTEXT_MENU: 'assets:context-menu',
  ASSETS_PROMOTE: 'assets:promote',
  /** 同参再生成(不经过对话模型) */
  ASSETS_REGENERATE: 'assets:regenerate',
  /** 导出生成参数 .recipe.json */
  ASSETS_RECIPE: 'assets:recipe',
  /** 读取资产为 data URL(渲染进程做画布合成时需要未污染图源) */
  ASSETS_DATA_URL: 'assets:data-url',
  /** 批量导出(多比例交付族):写图片 + 交付清单到文件夹 */
  ASSETS_EXPORT_SET: 'assets:export-set',

  /** 应用元信息(版本号等) */
  APP_INFO: 'app:info',

  /** 无边框窗口:自绘标题栏的窗口控制与最大化状态推送 */
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_STATE: 'window:state',

  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_SET_ACTIVE: 'settings:set-active',
  SETTINGS_TEST_CHAT: 'settings:test-chat',
  SETTINGS_TEST_IMAGE: 'settings:test-image',
  SETTINGS_LIST_MODELS: 'settings:list-models'
} as const

/** 渲染进程通过自定义协议访问图片资产:app-asset://{sessionId}/{fileName} */
export function assetUrl(sessionId: string, fileName: string): string {
  return `app-asset://${sessionId}/${fileName}`
}
