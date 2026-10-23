// ask_user 挂起问题管理:工具执行等待用户在 UI 面板作答

import type { AgentQuestion } from '@shared/types'

interface Pending {
  sessionId: string
  resolve: (answer: string) => void
}

const pendings = new Map<string, Pending>()

/** 问答默认超时:用户长时间不答不能让本轮永久挂起(10 分钟) */
export const QUESTION_TIMEOUT_MS = 10 * 60_000

/** 挂起一个问题,直到用户作答(返回所选答案);超时按「未回答」收尾 */
export function askUser(sessionId: string, question: AgentQuestion, timeoutMs = QUESTION_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendings.has(question.id)) return
      pendings.delete(question.id)
      resolve('用户未回答(超时)')
    }, timeoutMs)
    // 不让定时器把进程钉住
    timer.unref?.()
    pendings.set(question.id, {
      sessionId,
      resolve: (answer) => {
        clearTimeout(timer)
        resolve(answer)
      }
    })
  })
}

/** 用户作答(UI 面板 → IPC);返回是否命中挂起问题 */
export function answerQuestion(questionId: string, answer: string): boolean {
  const p = pendings.get(questionId)
  if (!p) return false
  pendings.delete(questionId)
  p.resolve(answer.trim() || '(空)')
  return true
}

/** 会话被取消/停止时释放全部挂起问题,避免循环卡死 */
export function cancelSessionQuestions(sessionId: string): void {
  for (const [id, p] of [...pendings.entries()]) {
    if (p.sessionId === sessionId) {
      pendings.delete(id)
      p.resolve('用户未回答(已停止)')
    }
  }
}
