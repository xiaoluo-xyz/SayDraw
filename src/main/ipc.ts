// IPC 处理器注册:invoke 通道 + agent 事件推送

import { BrowserWindow, ClipboardItem, Menu, app, clipboard, dialog, ipcMain, nativeImage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import type {
  ApiFormat,
  AgentEvent,
  AppSettings,
  ImageAsset,
  ModelInfo,
  SessionData,
  SessionSummary,
  TestResult
} from '@shared/types'
import { getDb } from './store/db'
import { getSettings } from './store/settings'
import { readAssetBuffer, removeSessionAssets, saveDataUrlAsset } from './store/assets'
import fs from 'node:fs'
import { setSessionProject, type ProjectSetupResult } from './store/projects'
import { runAgentTurn, cancelRun } from './agent/loop'
import { answerQuestion, cancelSessionQuestions } from './agent/askUser'
import { chatProviderPing } from './providers/chat'
import { listModels } from './providers/models'
import { imagePing } from './providers/images'
import { errText } from './providers/http'

function readAssetBufferSafe(asset: ImageAsset): Buffer | null {
  try {
    return readAssetBuffer(asset)
  } catch {
    return null
  }
}

function emit(event: AgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.EVENT, event)
  }
}

export function registerIpc(): void {
  const db = getDb()
  const settings = getSettings()

  // ---------- 应用元信息 ----------

  ipcMain.handle(IPC.APP_INFO, () => app.getVersion())

  // ---------- 会话 ----------

  ipcMain.handle(IPC.SESSIONS_LIST, (): SessionSummary[] => db.listSessions())

  ipcMain.handle(IPC.SESSIONS_CREATE, (_e, title?: string): SessionSummary => db.createSession(title))

  ipcMain.handle(IPC.SESSIONS_RENAME, (_e, id: string, title: string) => {
    db.renameSession(id, title)
    return true
  })

  ipcMain.handle(IPC.SESSIONS_REMOVE, (_e, id: string) => {
    const projectPath = db.getSession(id)?.projectPath
    db.deleteSession(id)
    removeSessionAssets(id, projectPath)
    return true
  })

  /** 选择项目文件夹(仅文件夹),设置到会话并初始化 要求.md / 需求规格.md;取消选择返回 null */
  ipcMain.handle(IPC.SESSIONS_SELECT_PROJECT, async (_e, sessionId: string): Promise<ProjectSetupResult | null> => {
    const win = BrowserWindow.getAllWindows()[0]
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择项目文件夹' })
    if (picked.canceled || !picked.filePaths[0]) return null
    return setSessionProject(sessionId, picked.filePaths[0])
  })

  // ---------- 会话数据 ----------

  ipcMain.handle(IPC.CHAT_HISTORY, (_e, sessionId: string): SessionData => {
    const session = db.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    const assets: Record<string, ImageAsset> = {}
    for (const a of db.assets(sessionId)) assets[a.id] = a
    return {
      session,
      messages: db.messages(sessionId),
      assets,
      brief: db.brief(sessionId)
    }
  })

  ipcMain.handle(
    IPC.CHAT_SEND,
    (
      _e,
      sessionId: string,
      text: string,
      assetIds?: string[],
      confirmBrief?: boolean,
      fileTexts?: { name: string; content: string }[]
    ) => {
      if (!text.trim() && !(assetIds?.length) && !(fileTexts?.length)) throw new Error('消息内容为空')
      // 异步执行,进度通过事件推送
      void runAgentTurn(
        sessionId,
        { text: text.trim(), assetIds: assetIds ?? [], fileTexts, confirmBrief },
        emit
      ).catch((err) => emit({ type: 'error', sessionId, message: errText(err) }))
      return true
    }
  )

  ipcMain.handle(IPC.CHAT_CANCEL, (_e, sessionId: string) => {
    const cancelled = cancelRun(sessionId)
    cancelSessionQuestions(sessionId) // 释放问答面板挂起,避免循环卡死
    return cancelled
  })

  /** 用户在问答面板作答 ask_user */
  ipcMain.handle(IPC.CHAT_ANSWER_QUESTION, (_e, sessionId: string, questionId: string, answer: string) => {
    return answerQuestion(questionId, answer)
  })

  // ---------- 资产 ----------

  ipcMain.handle(
    IPC.ASSETS_UPLOAD,
    (_e, sessionId: string, dataUrl: string, kind: ImageAsset['kind'], baseAssetId?: string, label?: string): ImageAsset =>
      saveDataUrlAsset({ sessionId, dataUrl, kind, baseAssetId, label })
  )

  /** 图片右键菜单:复制到剪贴板 / 另存为 */
  ipcMain.handle(IPC.ASSETS_CONTEXT_MENU, (e: IpcMainInvokeEvent, assetId: string): boolean => {
    const asset = db.asset(assetId)
    if (!asset || asset.kind === 'mask') return false
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const buffer = readAssetBufferSafe(asset)

    const menu = Menu.buildFromTemplate([
      {
        label: '复制图片',
        enabled: Boolean(buffer),
        click: () => {
          if (!buffer) return
          const png = nativeImage.createFromBuffer(buffer).toPNG()
          void clipboard.write([new ClipboardItem({ 'image/png': new Blob([png]) })])
        }
      },
      {
        label: '另存为…',
        enabled: Boolean(buffer),
        click: () => {
          if (!buffer || !win) return
          void (async () => {
            const ext = asset.mime.includes('jpeg') ? 'jpg' : asset.mime.includes('webp') ? 'webp' : 'png'
            const picked = await dialog.showSaveDialog(win, {
              title: '保存图片',
              defaultPath: `${asset.id}.${ext}`,
              filters: [
                { name: '图片', extensions: [ext] },
                { name: '所有文件', extensions: ['*'] }
              ]
            })
            if (!picked.canceled && picked.filePath) {
              fs.writeFileSync(picked.filePath, buffer)
            }
          })()
        }
      }
    ])
    menu.popup({ window: win })
    return true
  })

  // ---------- 设置 ----------

  ipcMain.handle(IPC.SETTINGS_GET, (): AppSettings => settings.load())

  ipcMain.handle(IPC.SETTINGS_SAVE, (_e, next: AppSettings) => {
    if (!Array.isArray(next.chatConnections) || !Array.isArray(next.imageConnections)) throw new Error('设置格式不正确')
    return settings.save(next)
  })

  ipcMain.handle(IPC.SETTINGS_SET_ACTIVE, (_e, kind: 'chat' | 'image', profileId: string | undefined) => {
    return settings.setActive(kind, profileId)
  })

  ipcMain.handle(
    IPC.SETTINGS_LIST_MODELS,
    (_e, baseUrl: string, apiKey: string, apiFormat?: ApiFormat): Promise<ModelInfo[]> =>
      listModels({ baseUrl, apiKey, apiFormat })
  )

  ipcMain.handle(
    IPC.SETTINGS_TEST_CHAT,
    async (
      _e,
      profile: { baseUrl: string; apiKey: string; model: string; apiFormat?: ApiFormat; chatPath?: string; maxOutputTokens?: number }
    ): Promise<TestResult> => {
      try {
        await chatProviderPing({ ...profile, id: 'test', name: 'test' })
        return { ok: true, message: `连接成功:${profile.model}` }
      } catch (err) {
        return { ok: false, message: errText(err) }
      }
    }
  )

  ipcMain.handle(IPC.SETTINGS_TEST_IMAGE, async (_e, profile: { baseUrl: string; apiKey: string; model: string; genPath?: string }): Promise<TestResult> => {
    try {
      await imagePing({ ...profile, id: 'test', name: 'test', genPath: profile.genPath })
      return { ok: true, message: `生成测试通过:${profile.model}` }
    } catch (err) {
      return { ok: false, message: errText(err) }
    }
  })
}
