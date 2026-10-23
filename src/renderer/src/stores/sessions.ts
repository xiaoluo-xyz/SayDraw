// 会话列表状态

import { create } from 'zustand'
import type { SessionSummary } from '@shared/types'
import { useChatStore } from './chat'

interface SessionsStore {
  sessions: SessionSummary[]
  currentId: string | null
  settingsOpen: boolean
  load: () => Promise<void>
  /** 新建会话:不传工作目录 = 独立会话(直接开画);传了 = 在该工作区下新建 */
  create: (projectPath?: string) => Promise<void>
  select: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  /** 把会话移出工作区(只解除关联,不动磁盘文件) */
  clearProject: (id: string) => Promise<void>
  setSettingsOpen: (open: boolean) => void
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: [],
  currentId: null,
  settingsOpen: false,

  load: async () => {
    const sessions = await window.api.sessions.list()
    set({ sessions })
    if (!get().currentId && sessions.length > 0) {
      await get().select(sessions[0].id)
    }
  },

  create: async (projectPath) => {
    const s = await window.api.sessions.create(projectPath ? { projectPath } : {})
    set({ sessions: [s, ...get().sessions], currentId: s.id })
    useChatStore.getState().reset()
    await useChatStore.getState().loadFor(s.id)
  },

  select: async (id) => {
    if (get().currentId === id) return
    set({ currentId: id })
    await useChatStore.getState().loadFor(id)
  },

  remove: async (id) => {
    await window.api.sessions.remove(id)
    const rest = get().sessions.filter((s) => s.id !== id)
    set({ sessions: rest })
    if (get().currentId === id) {
      if (rest.length > 0) {
        set({ currentId: rest[0].id })
        await useChatStore.getState().loadFor(rest[0].id)
      } else {
        set({ currentId: null })
        useChatStore.getState().reset()
      }
    }
  },

  rename: async (id, title) => {
    await window.api.sessions.rename(id, title)
    set({ sessions: get().sessions.map((s) => (s.id === id ? { ...s, title } : s)) })
  },

  clearProject: async (id) => {
    const updated = await window.api.sessions.clearProject(id)
    if (!updated) return
    set({ sessions: get().sessions.map((s) => (s.id === id ? { ...s, projectPath: undefined } : s)) })
  },

  setSettingsOpen: (open) => set({ settingsOpen: open })
}))
