/**
 * 发送流水线：自动发送走机械守卫、草稿判读和演练；手动发送直接走公共传输与回执处理。
 *
 * 分工：
 * - `lib/guards.js` 出机械结论；`lib/judge.js` 出语义结论（**只能加拒绝**）；
 * - 本模块只负责按顺序把它们串起来并调用传输层，**不写任何文件、不碰 state**（唯一写者是 watcher）。
 *
 * 纪律：never-throw；失败返回 `{ ok:false, stage, reason, detail }`，
 * `stage ∈ {'guard','assessment','transport'}`，`reason` 尽量沿用 skill 的英文机器码。
 *
 * @module dsh-popo-watcher/send
 */

import { buildDraftState, decideDraft } from './judge.js'
import { sendGuards } from './guards.js'
import { isAborted, withAbort } from './deadline.js'

/**
 * 创建发送器。
 * @param options - 注入点。
 * @param options.judgeClient - `lib/judge.js` 的 `createJudge()` 结果（可缺省＝不做语义检查）。
 * @param options.logger - 日志回调。
 * @returns `{ deliver }`。
 */
export function createSender(options = {}) {
  const { judgeClient, logger } = options

  /**
   * 走完整条发送流水线。
   * @param input - `{ transport, group, text, opening, manual, canSend?, signal?, dryRun, config, state, lastMessage, selfUid, sentMessages, judgeState, draftQuestions, nowMs, replyTargets? }`。
   * @returns `{ ok, msgId?, dryRun?, warnings, stage?, reason?, detail?, assessment? }`。
   */
  async function deliver(input = {}) {
    let signal, manual
    try {
      const {
        transport,
        group,
        text,
        opening = false,
        manual: manualOption = false,
        canSend,
        signal: requestSignal,
        dryRun = false,
        config = {},
        state = {},
        lastMessage = null,
        selfUid = '',
        sentMessages = [],
        judgeState = null,
        draftQuestions = null,
        replyTargets = null,
        nowMs = Date.now(),
      } = input
      manual = manualOption
      signal = requestSignal
      if (manual !== true) signal?.throwIfAborted()

      const guard = manual === true ? { ok: true, warnings: [] }
        : sendGuards({ text, config, state, lastMessage, selfUid, sentMessages, nowMs, opening, replyTargets })
      if (guard.ok !== true) {
        return {
          ok: false,
          stage: 'guard',
          reason: guard.reason ?? 'guard rejected',
          detail: guard.detail ?? '',
          warnings: guard.warnings ?? [],
          assessment: null,
          ...(guard.retryAtMs ? { retryAtMs: guard.retryAtMs } : {}),
        }
      }

      const warnings = [...(guard.warnings ?? [])]
      let assessment = null

      // 语义守卫排在所有机械守卫之后（机械拦住就不浪费一次请求）；开场白不跑判读。
      if (manual !== true && opening !== true && config?.judge?.enabled !== false && judgeClient && judgeState && draftQuestions) {
        const available = await withAbort(() => judgeClient.available?.(), signal)
        if (available?.ok === true) {
          const result = await withAbort(() => judgeClient.runDraft(buildDraftState(judgeState, text), draftQuestions), signal)
          if (result?.ok === true) {
            assessment = result
            const decision = decideDraft(result.answers, text, config?.judge?.thresholds)
            if (decision?.decision === 'block') {
              const first = Array.isArray(decision.blocks) ? decision.blocks[0] : null
              return {
                ok: false,
                stage: 'assessment',
                reason: `assessment blocked: ${first?.reason ?? first?.question ?? 'blocked'}`,
                detail: safeJson(decision),
                warnings,
                assessment,
              }
            }
          } else {
            // 判读不可用就是放行（skill 的取向：语义层可以拒绝一句话，但不该让技能停摆）。
            warnings.push(`judgeUnavailable: ${result?.error ?? 'unknown'}`)
            logger?.(`send: 判读不可用，按机械守卫放行（${result?.error ?? 'unknown'}）`)
          }
        } else {
          warnings.push(`judgeUnavailable: ${available?.error ?? 'unknown'}`)
        }
      }

      // 判读期间可能发生采集故障；真正提交前再确认自动发言仍可用。
      if (manual !== true) signal?.throwIfAborted()
      if (manual !== true && typeof canSend === 'function' && canSend() !== true) {
        return { ok: false, stage: 'guard', reason: 'collection stopped', detail: '采集中断或监控已停止，本次自动回复已作废', warnings, assessment }
      }
      if (manual !== true && dryRun === true) return { ok: true, dryRun: true, warnings, assessment }

      if (!transport?.send) {
        return { ok: false, stage: 'transport', reason: 'cli-missing', detail: '传输层不可用', warnings, assessment }
      }
      const sent = await transport.send({ group, text })
      if (sent?.ok !== true) {
        return {
          ok: false,
          stage: 'transport',
          reason: sent?.kind ?? 'send failed',
          detail: sent?.error ?? '未知失败',
          warnings,
          assessment,
        }
      }
      // 已发送但传输层没读到 msgId（回应的成功形状变了）：如实记下来，别当成失败去重发。
      const sendWarnings = [...warnings]
      if (sent.value?.unrecognized === true) {
        sendWarnings.push(sent.value?.msgId === '' || sent.value?.msgId === undefined
          ? 'send ack unrecognized: 已发送，但没读到 msgId（形状变了，记得核对 parser）'
          : 'send ack unrecognized: id 来自正则兜底，不是结构化字段')
      }
      return { ok: true, msgId: sent.value?.msgId ?? '', warnings: sendWarnings, assessment }
    } catch (error) {
      if (manual !== true && isAborted(signal)) {
        return { ok: false, stage: 'guard', reason: 'round cancelled', detail: '本轮已取消，未提交发送', warnings: [], assessment: null }
      }
      // 兜底：绝不把异常抛给宿主。
      return {
        ok: false,
        stage: 'transport',
        reason: 'send exception',
        detail: error instanceof Error ? error.message : String(error),
        warnings: [],
        assessment: null,
      }
    }
  }

  return { deliver }
}

/** JSON 文本（失败回落空对象）。 */
function safeJson(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}
