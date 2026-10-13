/**
 * 轮次编排（round）：把「这一轮该不该开口、开口说什么」串成一条流水线。
 *
 * 对应 skill 里 agent 每轮做的事（`popo-watch.ps1 -Action round` + 写文案那一步），
 * 但插件里没有 agent 在环，所以：
 * - 机械层与语义层（`lib/guards.js` / `lib/judge.js`）照旧，**判读只能加拒绝**；
 * - "写那句话"这一步交给宿主 LLM（`lib/llm.js`）；
 * - 判读关闭或拿不准时，由宿主 LLM 自行判断并写文案；没有切口仍返回 SKIP。
 *
 * 本模块**不写盘、不发送、不碰 transport**：它只出结论（`verdict` + 草稿文本），
 * 记账与发送由 watcher（唯一写者）按结论执行。
 *
 * @module dsh-popo-watcher/round
 */

import { buildState, composeRoundView, decideRound } from './judge.js'
import { roundView } from './guards.js'
import { isSkipLine } from './llm.js'
import { isAborted, withAbort } from './deadline.js'

/** 判读层给出的"可以开口"结论。 */
const SPEAK = 'speak'
/** 这一轮不发（机械挡住 / 判读说没切口 / 拿不准）。 */
const QUIET = 'quiet'
const LLM_GUIDANCE = '请自行判断这些新消息是否值得回复。能补充可靠信息或自然接话才回复，话题已收尾、只有确认或没有合适内容时返回 SKIP。'

/**
 * 把会话切片写成给模型看的一段文字（越朴素越好：模型只需要看懂谁在说什么）。
 * @param input - `{ conversation, ourRecent, guidance }`。
 * @returns 提示词文本。
 */
export function buildDraftPrompt(input = {}) {
  try { return draftPrompt(input) } catch { return '' }
}

function draftPrompt(input) {
  const { conversation = [], ourRecent = [], guidance = '', maxChars = 50, onlyReplyTargets = false } = input
  const lines = []
  lines.push('最近群聊（从旧到新，[新] 是这一轮刚进来的）：')
  if (onlyReplyTargets) lines.push('本轮只回复标记为 [新] 的 @ 我消息；其余消息仅作背景，不得转而回复其他话题。')
  for (const row of conversation) {
    const speaker = typeof row?.speaker === 'string' && row.speaker !== '' ? row.speaker : '某人'
    const text = typeof row?.text === 'string' ? row.text : ''
    lines.push(`${row?.n ?? '?'}. ${row?.is_new === true ? '[新] ' : ''}${speaker}：${text}`)
  }
  if (Array.isArray(ourRecent) && ourRecent.length > 0) {
    lines.push('')
    lines.push(`我们最近说过的（不要重复这些）：${ourRecent.join(' / ')}`)
  }
  if (typeof guidance === 'string' && guidance !== '') {
    lines.push('')
    lines.push(`这一轮的判断：${guidance}`)
  }
  lines.push('')
  lines.push(`现在写一句话回群里：中文、一行、${maxChars} 字以内、有信息量、不要复述别人刚说的话。`)
  lines.push('输出前自行检查：不编造账号主人的个人事实，不重复已有内容，不泄露凭据、内部地址或本机路径；只输出最终回复。')
  lines.push('如果没有值得说的，只回 SKIP 四个字母，不要解释。')
  return lines.join('\n')
}

/**
 * 创建轮次编排器。
 * @param options - 注入点。
 * @param options.judge - `lib/judge.js` 模块（纯策略）。
 * @param options.judgeClient - `createJudge()` 的结果；缺省＝语义层不可用。
 * @param options.draftWriter - `lib/llm.js` 的 `createDraftWriter()` 结果；缺省＝不会自动写文案。
 * @param options.logger - 日志回调。
 * @param options.now - 取当前时间（默认 `() => new Date()`）。
 * @returns `{ plan }`，`plan` 永不抛错、永不 reject。
 */
export function createRound(options = {}) {
  const { judge, judgeClient, draftWriter, logger, now = () => new Date() } = options

  /** 当前毫秒（注入值坏掉时回落 `Date.now`）。 */
  function nowMs() {
    try {
      const value = now()
      const ms = value instanceof Date ? value.getTime() : Number(value)
      return Number.isFinite(ms) ? ms : Date.now()
    } catch {
      return Date.now()
    }
  }

  /**
   * 判一轮。
   * @param input - `{ messages, newCount, newMessageIds?, selfUid, sentMessages, config, questions, signal? }`。
   * @returns `{ verdict, view, judgement, draft, reason }`；任何异常都退回 `quiet`，绝不抛。
   */
  async function plan(input = {}) {
    let signal
    try {
      signal = input?.signal
      return await withAbort(() => planRound(input, signal), signal)
    } catch (error) {
      return { verdict: QUIET, view: null, judgement: null, draft: '',
        cancelled: isAborted(signal),
        reason: isAborted(signal) ? '本轮已取消' : `round error: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async function planRound(input, signal) {
    try {
      const { messages = [], newCount = 0, selfUid = '', sentMessages = [], config = {}, questions = null } = input
      const list = Array.isArray(messages) ? messages.filter(Boolean) : []
      const freshIds = Array.isArray(input.newMessageIds) ? new Set(input.newMessageIds) : null
      const candidates = [...list, ...(Array.isArray(input.replyTargets) ? input.replyTargets : [])]
      const freshCount = freshIds === null ? newCount : new Set(candidates.filter(message => freshIds.has(message?.msgId)).map(message => message.msgId)).size

      // 1) 机械层：没有新消息 / 最后一条是自己 / 最后一条是纯图 → 直接收工。
      const view0 = roundView({ messages: list, newCount: freshCount, selfUid, nowMs: nowMs() })
      if (view0.verdict === 'blocked') {
        return { verdict: QUIET, view: view0, judgement: null, draft: '', reason: `mechanical: ${view0.blockers.join('+')}` }
      }
      const replyTargets = config.replyOnlyWhenMentioned === true ? input.replyTargets : null
      if (config.replyOnlyWhenMentioned === true && (!Array.isArray(replyTargets) || replyTargets.length === 0)) {
        const view = { ...view0, verdict: 'blocked', blockers: [...view0.blockers, 'notMentioned'], nextStep: 'Do not send; no confirmed new messages mention our account.' }
        return { verdict: QUIET, view, judgement: null, draft: '', reason: input.mentionReason || '本轮没有确认直接 @ 当前账号的新消息' }
      }

      // 2) 语义层：TypeSafe 判读（只在机械过关后才花这一次请求）。
      const judgeState = buildState({
        messages: freshIds === null ? list.slice(-14)
          : list.filter((message, index) => index >= list.length - 14 || freshIds.has(message.msgId)),
        selfUid,
        sinceMs: 0,
        newMark: freshCount > 0 ? freshCount : 1,
        newMessageIds: input.newMessageIds,
        sentMessages,
        now: nowMs,
        replyTargets,
        ...(input.selfDisplayName ? { chat: { our_account_display_name: input.selfDisplayName } } : {}),
      })

      const enabled = config?.judge?.enabled !== false
      let judgement = null
      if (enabled && judgeClient && questions) {
        const available = await safeCall(() => judgeClient.available?.())
        signal?.throwIfAborted()
        if (available?.ok === true) {
          const result = await safeCall(() => judgeClient.runRound(judgeState, questions))
          judgement = result?.ok === true ? result : { ok: false, error: `judgeUnavailable: ${result?.error ?? 'unknown'}` }
        } else {
          judgement = { ok: false, error: `judgeUnavailable: ${available?.error ?? 'unknown'}` }
        }
      } else if (enabled) {
        judgement = { ok: false, error: 'judgeUnavailable: 判读客户端未接入' }
      }

      // 先把概率映射成结论（action/kind/guidance），再合成视图：
      // `composeRoundView` 只认 judgement 上的 `action`，直接喂原始 answers 会被当成"拿不准"。
      const decision = judgement?.ok === true ? decideRound(judgement.answers, config?.judge?.thresholds) : null
      const semantic = decision === null
        ? judgement
        : {
            ok: true,
            action: decision.action,
            kind: decision.kind,
            guidance: decision.guidance,
            reasons: decision.reasons,
            advisories: decision.advisories,
          }

      // 语义层只能加拒绝：composeRoundView 只做加法。
      let view = enabled ? composeRoundView(view0, semantic) : { ...view0, action: 'llm', nextStep: LLM_GUIDANCE }
      let guidance = decision?.guidance !== undefined && decision.guidance !== '' ? decision.guidance : view.nextStep ?? ''
      let reason = 'composed'

      if (decision !== null) {
        view = { ...view, action: decision.action, kind: decision.kind, reasons: decision.reasons, advisories: view.advisories }
        reason = decision.action === 'quiet' ? `judge quiet: ${decision.reasons.join('+') || decision.kind}` : `judge ${decision.action}`
      } else {
        reason = enabled ? String(judgement?.error ?? 'judge unavailable') : 'llm judgement'
      }

      // 明确拒绝不可绕过；关闭判读、不确定或显式配置的故障回落交给 LLM 自行判断。
      const judgeUsable = judgement?.ok === true
      const policy = config?.judge?.unavailablePolicy === 'llm' ? 'llm' : 'quiet'
      const selfJudge = !enabled || decision?.action === 'unsure' || (!judgeUsable && policy === 'llm')
      const decisionSource = selfJudge ? 'llm' : 'typesafe'
      const canDraft = view.verdict !== 'blocked' && (view.verdict === SPEAK || selfJudge)
      if (!canDraft) return { verdict: QUIET, view, judgement, draft: '', reason, decisionSource }
      if (selfJudge) guidance = LLM_GUIDANCE

      if (!draftWriter || typeof draftWriter.write !== 'function') {
        return { verdict: QUIET, view, judgement, draft: '', reason: '有切口但没有文案层（llm 未接入）' }
      }

      const prompt = buildDraftPrompt({
        conversation: judgeState.conversation ?? [],
        ourRecent: judgeState.our_recent_messages ?? [],
        guidance,
        maxChars: Number(config?.maxChars) > 0 ? Number(config.maxChars) : 50,
        onlyReplyTargets: config.replyOnlyWhenMentioned === true,
      })
      signal?.throwIfAborted()
      const written = await safeCall(() => draftWriter.write({
        system: config?.prompt?.system ?? '',
        prompt,
        temperature: config?.llm?.temperature,
        signal,
      }))
      signal?.throwIfAborted()
      const generation = { decisionSource, model: written?.model ?? '', finishReason: written?.finishReason ?? null }

      if (written?.ok !== true) {
        logger?.(`round: 文案层失败（${written?.error ?? '未知'}），本轮不发`)
        return { verdict: QUIET, view, judgement, draft: '', reason: `draft unavailable: ${written?.error ?? 'unknown'}`, ...generation }
      }
      if (isSkipLine(written.text)) {
        return { verdict: QUIET, view, judgement, draft: '', reason: 'model said SKIP', ...generation }
      }
      if (typeof written.text !== 'string' || written.text.trim() === '') {
        return { verdict: QUIET, view, judgement, draft: '', reason: 'draft empty', ...generation }
      }
      return { verdict: SPEAK, view, judgement, draft: written.text, reason: `draft: ${written.model ?? ''}`.trim(), ...generation }
    } catch (error) {
      if (isAborted(signal)) return { verdict: QUIET, view: null, judgement: null, draft: '', cancelled: true, reason: '本轮已取消' }
      // 兜底：编排层的任何异常都等于"这轮不开口"。
      logger?.(`round: 异常 ${error instanceof Error ? error.message : String(error)}`)
      return { verdict: QUIET, view: null, judgement: null, draft: '', reason: `round error: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  return { plan }
}

/** 调一个可能抛错/可能不返回 Promise 的注入函数，统一成 `{ok:false,error}`。 */
async function safeCall(fn) {
  try {
    const value = await fn()
    return value ?? { ok: false, error: 'empty' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
