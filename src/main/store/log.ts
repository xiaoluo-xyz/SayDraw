// 本地日志:崩溃、数据恢复、备份失败等主进程事件落到 userData/logs/app.log
// 只用同步写(量小、发生在异常路径,异步写可能来不及落盘);日志失败绝不影响主流程

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const MAX_LOG_BYTES = 1024 * 1024

export function logFile(): string {
  return path.join(app.getPath('userData'), 'logs', 'app.log')
}

export function appendLog(message: string): void {
  try {
    const file = logFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      // 文件还不存在:首次写入
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // 日志写失败不影响主流程
  }
}
