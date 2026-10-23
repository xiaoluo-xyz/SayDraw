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
  ImageBrief,
  ModelInfo,
  SessionData,
  SessionSummary,
  TestResult
} from '@shared/types'
import { getDb } from './store/db'
import { getSettings } from './store/settings'
import { assetToDataUrl, readAssetBuffer, removeSessionAssets, saveBufferAsset, saveDataUrlAsset } from './store/assets'
import fs from 'node:fs'
import path from 'node:path'
import { clearSessionProject, ensureProjectFiles, setSessionProject, type ProjectSetupResult } from './store/projects'
import { runAgentTurn, cancelRun } from './agent/loop'
import { answerQuestion, cancelSessionQuestions } from './agent/askUser'
import { chatProviderPing } from './providers/chat'
import { listModels } from './providers/models'
import { editImage, generateImages, guessMime, imagePing } from './providers/images'
import { errText } from './providers/http'
import { buildRecipe } from '@shared/recipe'

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

  // ---------- 无边框窗口控制(自绘标题栏) ----------
  // 主窗口 frame:false,系统标题栏被去掉,这几个按钮是唯一的窗口操作入口;
  // 统一用事件来源窗口(BrowserWindow.fromWebContents),避免多窗口时操作错对象。

  const senderWindow = (e: IpcMainInvokeEvent): BrowserWindow | null => BrowserWindow.fromWebContents(e.sender)

  ipcMain.handle(IPC.WINDOW_MINIMIZE, (e) => {
    senderWindow(e)?.minimize()
  })

  ipcMain.handle(IPC.WINDOW_TOGGLE_MAXIMIZE, (e): boolean => {
    const win = senderWindow(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle(IPC.WINDOW_CLOSE, (e) => {
    senderWindow(e)?.close()
  })

  ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, (e): boolean => senderWindow(e)?.isMaximized() ?? false)

  // ---------- 会话 ----------

  ipcMain.handle(IPC.SESSIONS_LIST, (): SessionSummary[] => db.listSessions())

  /**
   * 新建会话:title / projectPath 都可选 —— 不选工作目录也能直接开始画;
   * 选了目录(或在某个工作区里点「+」)就挂到该目录下,并确保 要求.md / 需求规格.md / 素材/ / 生成图片/ 存在。
   */
  ipcMain.handle(
    IPC.SESSIONS_CREATE,
    (_e, opts?: string | { title?: string; projectPath?: string }): SessionSummary => {
      const normalized = typeof opts === 'string' ? { title: opts } : (opts ?? {})
      const title = normalized.title?.trim() || '新会话'
      const projectPath = normalized.projectPath?.trim()
      if (!projectPath) return db.createSession(title)
      let resolved = ''
      try {
        resolved = ensureProjectFiles(projectPath).path
      } catch (err) {
        throw new Error(`工作目录不可用:${err instanceof Error ? err.message : String(err)}`)
      }
      const session = db.createSession(title, resolved)
      setSessionProject(session.id, resolved)
      return session
    }
  )

  /** 把会话移出工作区(只解除关联,不动磁盘文件) */
  ipcMain.handle(IPC.SESSIONS_CLEAR_PROJECT, (_e, sessionId: string): SessionSummary | undefined => {
    clearSessionProject(sessionId)
    return db.getSession(sessionId)
  })

  ipcMain.handle(IPC.SESSIONS_RENAME, (_e, id: string, title: string) => {
    db.renameSession(id, title)
    return true
  })

  ipcMain.handle(IPC.SESSIONS_REMOVE, (_e, id: string) => {
    // 先中止该会话正在跑的 Agent,再删数据 —— 否则运行中的循环会继续 addMessage,
    // 把消息写进已删除的会话(孤儿消息),甚至回写刚被清理掉的资产目录
    cancelRun(id)
    cancelSessionQuestions(id)
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

  /** 渲染进程补写需求规格(套用模板):槽位变化会自动作废已确认,并同步到界面 */
  ipcMain.handle(IPC.BRIEF_PATCH, (_e, sessionId: string, patch: Partial<ImageBrief>): ImageBrief => {
    const brief = db.patchBrief(sessionId, patch as ImageBrief)
    emit({ type: 'brief-updated', sessionId, brief })
    return brief
  })

  // ---------- 资产 ----------

  ipcMain.handle(
    IPC.ASSETS_UPLOAD,
    (_e, sessionId: string, dataUrl: string, kind: ImageAsset['kind'], baseAssetId?: string, label?: string): ImageAsset =>
      saveDataUrlAsset({ sessionId, dataUrl, kind, baseAssetId, label })
  )

  /** 选用候选图:草稿 → 正式版本链成员 */
  ipcMain.handle(IPC.ASSETS_PROMOTE, (_e, assetId: string): ImageAsset | undefined => db.promoteAsset(assetId))

  /** 读资产为 data URL:渲染进程把图画进 canvas 时需要未污染图源(app-asset:// 会污染) */
  ipcMain.handle(IPC.ASSETS_DATA_URL, (_e, assetId: string): string | null => {
    const asset = db.asset(assetId)
    if (!asset || asset.kind === 'mask') return null
    try {
      return assetToDataUrl(asset)
    } catch {
      return null
    }
  })

  /** 批量导出:把渲染进程生成的多比例图片与交付清单写进文件夹(dir 缺省时弹选择框) */
  ipcMain.handle(
    IPC.ASSETS_EXPORT_SET,
    async (
      e: IpcMainInvokeEvent,
      payload: { files: { fileName: string; dataUrl: string }[]; manifest?: string; dir?: string }
    ): Promise<{ ok: boolean; saved: number; dir: string }> => {
      let dir = payload.dir
      if (!dir) {
        const win = BrowserWindow.fromWebContents(e.sender)
        const picked = win
          ? await dialog.showOpenDialog(win, { title: '选择导出文件夹', properties: ['openDirectory', 'createDirectory'] })
          : await dialog.showOpenDialog({ title: '选择导出文件夹', properties: ['openDirectory', 'createDirectory'] })
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, saved: 0, dir: '' }
        dir = picked.filePaths[0]
      }
      fs.mkdirSync(dir, { recursive: true })
      let saved = 0
      for (const file of payload.files) {
        const match = /^data:([^;]+);base64,(.+)$/i.exec(file.dataUrl)
        if (!match) continue
        fs.writeFileSync(path.join(dir, path.basename(file.fileName)), Buffer.from(match[2], 'base64'))
        saved++
      }
      if (payload.manifest) fs.writeFileSync(path.join(dir, '交付清单.md'), payload.manifest, 'utf8')
      return { ok: true, saved, dir }
    }
  )

  /**
   * 同参再生成:直接用该图保存的提示词与参数再出一张,不重新走对话模型。
   * 生成图 → 重新文生图;编辑图 → 用原源图(与蒙版)重做一次编辑。
   */
  ipcMain.handle(IPC.ASSETS_REGENERATE, async (_e, assetId: string): Promise<ImageAsset> => {
    const asset = db.asset(assetId)
    if (!asset) throw new Error('图片不存在')
    const prompt = asset.prompt?.trim()
    if (!prompt) throw new Error('这张图没有保存提示词,无法同参复现')
    const profile = getSettings().activeImageProfile()
    if (!profile) throw new Error('当前未配置生图服务')

    const meta = asset.meta ?? {}
    const timeoutMs = settings.load().imageTimeoutMs
    const editedFrom = (meta.editedFrom ?? [])
      .map((id) => db.asset(id))
      .filter((a): a is ImageAsset => a !== undefined && a.kind !== 'mask')
    const editImages = editedFrom
      .map((src) => {
        const buffer = readAssetBufferSafe(src)
        return buffer ? { buffer, mime: src.mime } : null
      })
      .filter((x): x is { buffer: Buffer; mime: string } => x !== null)
    const maskAsset = meta.maskAssetId ? db.asset(meta.maskAssetId) : undefined
    const maskBuffer = maskAsset ? readAssetBufferSafe(maskAsset) : null

    const started = Date.now()
    const result =
      editImages.length > 0
        ? await editImage({
            profile,
            prompt,
            images: editImages,
            mask: maskBuffer ?? undefined,
            ratio: meta.ratio,
            size: meta.size,
            quality: meta.quality,
            timeoutMs
          })
        : await generateImages({
            profile,
            prompt,
            ratio: meta.ratio,
            // 快照没记尺寸时用资产自身尺寸,保证「同参复现」连分辨率一致
            size: meta.size ?? (asset.width && asset.height ? `${asset.width}x${asset.height}` : undefined),
            n: 1,
            quality: meta.quality,
            timeoutMs
          })

    if (!result.buffers.length) throw new Error('接口未返回图片')
    const created = saveBufferAsset({
      sessionId: asset.sessionId,
      buffer: result.buffers[0],
      mime: guessMime(result.buffers[0]),
      kind: editImages.length > 0 ? 'edited' : 'generated',
      parentId: editImages.length > 0 ? editedFrom[0].id : undefined,
      prompt,
      meta: {
        ...meta,
        actualSize: result.actualSize,
        dropped: result.dropped.length ? result.dropped : undefined,
        elapsedMs: Date.now() - started,
        cost: profile.pricePerImage && profile.pricePerImage > 0 ? Number(profile.pricePerImage.toFixed(4)) : undefined
      }
    })
    emit({ type: 'asset-added', sessionId: created.sessionId, asset: created })
    return created
  })

  /** 导出生成参数:提示词 + 模型/尺寸/画质等快照,便于复现与归档 */
  ipcMain.handle(IPC.ASSETS_RECIPE, async (e: IpcMainInvokeEvent, assetId: string): Promise<boolean> => {
    const asset = db.asset(assetId)
    if (!asset) return false
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: '导出生成参数',
      defaultPath: `${asset.id}.recipe.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return false
    const payload = buildRecipe(asset)
    fs.writeFileSync(picked.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return true
  })

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
