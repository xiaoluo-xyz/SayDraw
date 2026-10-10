// IPC 通道名集中定义,主进程与 preload 共用

export const IPC = {
  /** 主进程 → 渲染进程 推送 AgentEvent */
  EVENT: 'agent:event',

  SESSIONS_LIST: 'sessions:list',
  SESSIONS_CREATE: 'sessions:create',
  SESSIONS_RENAME: 'sessions:rename',
  SESSIONS_REMOVE: 'sessions:remove',
  SESSIONS_SELECT_PROJECT: 'sessions:select-project',

  CHAT_HISTORY: 'chat:history',
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_ANSWER_QUESTION: 'chat:answer-question',
  ASSETS_UPLOAD: 'assets:upload',
  ASSETS_CONTEXT_MENU: 'assets:context-menu',

  /** 应用元信息(版本号等) */
  APP_INFO: 'app:info',

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
