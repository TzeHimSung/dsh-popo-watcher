/** 判读兼容入口：问句加载、状态构造以及策略/HTTP 的既有导出。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prop } from './judge-policy.js'
export { DEFAULT_THRESHOLDS, GO_KINDS, STOP_KINDS, formatAnswers, decideRound, decideDraft, composeRoundView, composeRound } from './judge-policy.js'
export { createJudge } from './judge-client.js'
const QUESTIONS_PATH = fileURLToPath(new URL('./judge-questions.json', import.meta.url))
/** 认下 store.readText 形状 `{ok, value}` 与裸字符串两种读法。 */
function unwrapText(result, path) {
  if (typeof result === 'string') return { ok: true, text: result }
  if (result !== null && typeof result === 'object') {
    if (prop(result, 'ok') === false) {
      const error = prop(result, 'error')
      return { ok: false, error: `cannot read the question set: ${path}${error ? ` (${String(error)})` : ''}` }
    }
    const value = prop(result, 'value')
    if (typeof value === 'string') return { ok: true, text: value }
  }
  return { ok: false, error: `cannot read the question set: ${path}` }
}

/**
 * 读取问句集（源里 `Get-JsonFile -Path $QuestionsFile` 那一段）。
 * 懒惰读同目录的 `judge-questions.json`；`readText` 可注入（`(path) => string`，
 * 也接受 `store.readText` 的 `{ok, value}` 形状），注入函数抛错也算失败。
 *
 * @param readText - 可选读文件实现；不给则用 `node:fs.readFileSync`。
 * @returns `{ok:true, questions:{round, draft}}` 或 `{ok:false, error}`，绝不抛。
 */
export function loadQuestions(readText) {
  try {
    const read = typeof readText === 'function' ? readText : (path) => readFileSync(path, 'utf8')
    const readed = unwrapText(read(QUESTIONS_PATH), QUESTIONS_PATH)
    if (!readed.ok) return { ok: false, error: readed.error }
    if (readed.text === '') return { ok: false, error: `cannot read the question set: ${QUESTIONS_PATH}` }

    let parsed
    try {
      parsed = JSON.parse(readed.text)
    } catch (error) {
      return { ok: false, error: `cannot parse the question set: ${error instanceof Error ? error.message : String(error)}` }
    }

    const round = prop(prop(parsed, 'round'), 'questions')
    const draft = prop(prop(parsed, 'draft'), 'questions')
    if (!round || typeof round !== 'object' || !draft || typeof draft !== 'object') {
      return { ok: false, error: 'question set is missing round.questions / draft.questions' }
    }
    return { ok: true, questions: { round, draft } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Draft checks always evaluate exactly the text that will be sent. */
export function buildDraftState(state, text) {
  const our_draft = typeof text === 'string' ? text : ''
  try { return { ...state, our_draft } } catch { return { ...buildState(), our_draft } }
}

/**
 * 把会话切片整理成 System One 的 state 契约（等价于 popo-judge.ps1 的 New-State）。
 * @param input - `{ messages, selfUid, sinceMs, newMark, newMessageIds?, sentMessages, chat, now, replyTargets? }`。
 * @returns state 对象（任何异常都回落成空壳，绝不抛）。
 */
export function buildState(input = {}) {
  try {
    const {
      messages = [],
      selfUid = '',
      sinceMs = 0,
      newMark = 3,
      newMessageIds,
      sentMessages = [],
      chat = {},
      now = () => Date.now(),
      replyTargets = null,
    } = input
    const list = Array.isArray(messages) ? messages.filter(Boolean) : []
    const targetIds = Array.isArray(replyTargets) ? new Set(replyTargets.map(message => message?.msgId).filter(Boolean)) : null
    const freshIds = Array.isArray(newMessageIds) ? new Set(newMessageIds) : null
    if (targetIds !== null) {
      // 采集可继续进行：即使目标已不在最新 14 条中，也必须留在这轮上下文里。
      const present = new Set(list.map(message => message?.msgId).filter(Boolean))
      for (const message of replyTargets) {
        if (message?.msgId && !present.has(message.msgId)) {
          list.push(message)
          present.add(message.msgId)
        }
      }
      list.sort((left, right) => (left.t_msg ?? 0) - (right.t_msg ?? 0))
    }
    const nowMs = now()
    const total = list.length
    const conversation = list.map((message, index) => {
      const t = typeof message?.t_msg === 'number' ? message.t_msg : 0
      return {
        n: index + 1,
        minutes_ago: t > 0 ? Math.trunc((nowMs - t) / 60000) : 0,
        speaker: typeof message?.name === 'string' ? message.name : '',
        is_our_account: selfUid !== '' && message?.from === selfUid,
        // sinceMs > 0 → 严格按水位；否则按“最后 newMark 条”（与源实现的开关语义一致）
        is_new: targetIds !== null ? targetIds.has(message.msgId)
          : freshIds !== null ? freshIds.has(message.msgId) : sinceMs > 0 ? t > sinceMs : index + 1 > total - newMark,
        text: typeof message?.content === 'string' ? message.content : '',
      }
    })
    const recent = (Array.isArray(sentMessages) ? sentMessages : [])
      .map((entry) => (typeof entry === 'string' ? entry : String(entry?.content ?? '')))
      .filter((line) => line !== '')
      .slice(-4)
    return {
      chat: {
        setting: 'informal internal company group chat; colleagues talk shop, joke around, and tease each other',
        language: 'Simplified Chinese',
        our_account_display_name: 'blue big fat fish (a distilled copy of the account owner, who jokes about being one)',
        ...chat,
        ...(targetIds !== null ? { reply_scope: 'Only messages marked is_new are reply targets that mention our account. All other messages are context only.' } : {}),
      },
      conversation,
      our_recent_messages: recent,
    }
  } catch {
    return { chat: {}, conversation: [], our_recent_messages: [] }
  }
}
