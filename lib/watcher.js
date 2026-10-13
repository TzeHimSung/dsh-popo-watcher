/**
 * 水群服务（watcher）：状态快照、配置读写、窗口与循环的生命周期入口。
 *
 * 分工（与 skill 的脚本等价，但收敛到一个进程内）：
 * - 本模块是**唯一写者**：state.json / 游标 / 流水都由它（以及它持有的 poller / sender）写；
 *   RPC 与工具只调用本模块的方法，经内部串行队列；采集故障同步停用，发送记账合并最新状态。
 * - 采集在 `lib/poller.js`，判读策略在 `lib/judge.js`，机械守卫在 `lib/guards.js`，
 *   一轮怎么编排在 `lib/round.js`，文案在 `lib/llm.js`；本模块只做装配与记账。
 * - 自动轮次：窗口开着时，采集一回新消息就判一轮（`runRound`），有切口才发一句。
 *   拿不准 / 判读不可用一律安静（见 `lib/round.js` 文件头）。
 *
 * 纪律：所有公开方法**绝不抛错**；构造函数不做 IO（首次读取发生在第一次调用里，且失败降级）。
 *
 * @module dsh-popo-watcher/watcher
 */

import { createPoller } from './poller.js'
import { createSettings } from './watcher-settings.js'
import { createHistory } from './watcher-history.js'
import { createSessionState } from './session-state.js'
import { ROUND_LOG_CAP, JUDGE_LOG_CAP } from './limits.js'
import { buildDraftState, buildState, composeRoundView, decideDraft, decideRound, loadQuestions } from './judge.js'
import { roundView } from './guards.js'
import { resolveKeySource } from './key-source.js'
import { createRound } from './round.js'
import { createSender } from './send.js'
import { validateGroup } from './config.js'

/** 错误环形缓冲上限。 */
const MAX_ERRORS = 5

export { LEGACY_DEFAULT_DIR } from './watcher-history.js'

/**
 * 创建 watcher 实例。
 * @param options - 依赖注入（全部可选，便于测试）。
 * @param options.store - `lib/store.js` 模块（IO，never-throw）。
 * @param options.config - `lib/config.js` 模块（纯函数）。
 * @param options.transport - `lib/popo.js` 的 transport（也可以只给 `getTransport`）。
 * @param options.judge - `lib/judge.js` 模块（未用；策略函数按需 import）。
 * @param options.compose - 文案层（未用；文案走 `draftWriter`）。
 * @param options.judgeClient - `createJudge()` 的结果（语义判读；缺省＝判读不可用）。
 * @param options.draftWriter - `createDraftWriter()` 的结果（写文案；缺省＝不会自动发言）。
 * @param options.getModelSelection - 当前实际生成路由；只读本地配置，不查询模型目录。
 * @param options.sender - 自定义发送流水线（测试用）；缺省由 `createSender` 造。
 * @param options.autoRound - 采集到新消息后是否自动判一轮（默认 true；测试可关）。
 * @param options.keyResolver - `({name, env, file}) => Promise<{key, source}>`，默认走 `lib/key-source.js`。
 * @param options.logger - 结构化日志，形如 `(message) => void`。
 * @param options.now - 取当前时间，默认 `() => new Date()`。
 * @param options.env - 环境对象（定位数据根），默认 `process.env`。
 * @param options.getTransport - `() => Transport | null`，惰性取传输层（宿主服务可能后到）。
 * @param options.schedule - 定时器注入（测试用），形如 `(fn, ms) => cancel`。
 * @returns watcher 实例。
 */
export function createWatcher(options = {}) {
  const {
    store,
    config,
    transport,
    judge,
    compose,
    logger,
    now = () => new Date(),
    env = process.env,
    getTransport,
    schedule,
    autoRound = true,
    judgeClient,
    sender,
    draftWriter,
    getModelSelection,
    keyResolver = resolveKeySource,
  } = options

  /** 错误环形缓冲。 */
  const errors = []
  /** 降级状态的起点（派生字段：只在"从正常变成不正常"的那一刻记一次时间）。 */
  let degradedSince = null
  /** 串行队列：所有写操作按序执行。 */
  let queue = Promise.resolve()
  /** dispose 标记，置位后不再产生新写入。 */
  let disposed = false
  /** 不可恢复故障或连续失败达到上限时停用；落盘失败也不能继续自动发言。 */
  let collectionStop = null
  let controlVersion = 0

  const settings = createSettings({ store, config, root, env, keyResolver, record, stamp, isLocked: configLocked, logger })
  const { ensureConfig, hasStoredKey } = settings
  const history = createHistory({ store, ensureConfig, dirFor, stamp, readJsonSafe, logger, record })
  const session = createSessionState({ store, dirFor, readJsonSafe, stamp, now, nowMs, stampMs, record,
    onPause: () => poller.stop(), getCollectionStop: () => collectionStop })
  const { readState, persistenceFailed, windowInfo } = session

  /** 一轮怎么编排（机械层 + 判读 + 写文案）；发送与记账仍在本模块。 */
  const roundRunner = createRound({ judgeClient, draftWriter, logger, now })
  /** 最近一轮的摘要（快照里给页面/工具看）。 */
  let lastRound = null
  /** 已经有排队/在跑的轮次时不再叠加：一次采集只判一轮。 */
  let roundPending = false

  /** 采集循环：只负责捕获，捕获到新消息后触发一轮判断。 */
  const poller = createPoller({
    store,
    getTransport: () => {
      try {
        if (typeof getTransport === 'function') return getTransport()
        return transport ?? null
      } catch (error) {
        record('poller.transport', error)
        return null
      }
    },
    logger,
    now,
    ...(typeof schedule === 'function' ? { schedule } : {}),
    // 群目录由 watcher 给（它才知道数据根用的是哪个 env），poller 不再自己算一份。
    resolveDir: (group) => dirFor(group),
    // 可恢复故障由 poller 退避；终止故障持久化，窗口到期也自退。
    shouldStop: () => {
      try {
        const poll = poller.state()
        if (poll.failureStopReason) {
          const reason = poll.failureStopReason
          if (poll.lastErrorKind === 'persistence') {
            persistenceFailed(poll.group, poll.lastError)
            return reason
          }
          collectionStop = { group: poll.group, stopped: true, stoppedAt: stamp(), stoppedReason: reason, collectionError: poll.lastError ?? '采集失败', collectionFailures: poll.consecutiveFailures }
          try {
            const stopped = stopMonitoring({ reason })
            if (stopped.ok !== true) record('collection.stop', stopped.error)
          } catch (error) {
            record('collection.stop', error)
          }
          return reason
        }
        const cfg = ensureConfig()
        const group = typeof cfg?.group === 'string' ? cfg.group : ''
        if (group === '') return null
        const win = windowInfo(group)
        if (win.startedAt === null) return null
        if (typeof win.remainingSec === 'number' && win.remainingSec <= 0) return `窗口已过期（${win.endsAt ?? '—'}）`
        return null
      } catch {
        return null
      }
    },
    onMessages: (messages) => {
      try {
        logger?.(`watcher: 新消息 ${messages.length} 条`)
        if (autoRound !== false) triggerRound(messages)
      } catch (error) {
        record('onMessages', error)
      }
    },
  })

  /** 触发一轮（单飞：上一轮没跑完就跳过，绝不堆叠）。 */
  function triggerRound(messages) {
    if (disposed || roundPending) {
      logger?.('watcher: 上一轮还没结束，跳过本次触发')
      return
    }
    roundPending = true
    const failureVersion = poller.state().failureVersion
    // 走同一个串行队列：判读/发送与页面手动操作不会互相插队。
    void enqueue(() => runOneRound(messages, failureVersion))
      .catch((error) => record('round', error))
      .finally(() => {
        roundPending = false
      })
  }

  /** 发送流水线（机械守卫 + 草稿判读 + 传输）；状态记账仍由本模块独占。 */
  const senderInstance = sender ?? createSender({ judgeClient, logger })

  /** 记录一条错误（绝不抛）。 */
  function record(type, error) {
    try {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ at: stamp(), type, message })
      while (errors.length > MAX_ERRORS) errors.shift()
      logger?.(`[${type}] ${message}`)
    } catch {
      // 记录失败本身也不能抛
    }
  }

  /** 本地时间戳（store 缺失时回落到 Date）。 */
  function stamp() {
    try {
      return store?.nowStamp ? store.nowStamp(now()) : now().toISOString()
    } catch {
      return ''
    }
  }

  /** 数据根（store 缺失时返回空串）。 */
  function root() {
    try {
      return store?.dataRoot ? store.dataRoot(env) : ''
    } catch (error) {
      record('store.root', error)
      return ''
    }
  }

  /** 某个 group 的目录。 */
  function dirFor(group) {
    try {
      return store?.groupDir ? store.groupDir(root(), group) : ''
    } catch (error) {
      record('store.groupDir', error)
      return ''
    }
  }

  /** 群与采集间隔必须在停止后修改；包括静音但采集仍运行的情况。 */
  function configLocked(cfg) {
    const win = windowInfo(cfg?.group ?? '')
    return poller.state().running === true || (win.active === true && win.stopped !== true)
  }

  /** 串行执行（写操作按序；异常不外泄）。 */
  function enqueue(task) {
    const run = queue.then(async () => {
      if (disposed) return { ok: false, error: '实例已释放' }
      try {
        return await task()
      } catch (error) {
        record('queue', error)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    // 保持队列不断链：即使内部返回失败，也不让后续任务被 reject 拖死。
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** 读一个 JSON 文件（never-throw）。 */
  function readJsonSafe(file) {
    try {
      const result = store?.readJson ? store.readJson(file, undefined) : { ok: false, value: undefined }
      return result?.ok ? result.value : undefined
    } catch (error) {
      record('store.readJson', error)
      return undefined
    }
  }

  /** 快照（供 RPC / 工具 / 页面）。绝不抛。 */
  function snapshot() {
    const cfg = ensureConfig()
    const group = typeof cfg?.group === 'string' ? cfg.group : ''
    const win = windowInfo(group)
    const pollerState = (() => {
      try {
        return poller.state()
      } catch (error) {
        record('poller.state', error)
        return { running: false, lastSeenMsgTime: 0, updatedAt: null, watchedMsgs: null, selfUid: '', lastError: '采集状态不可用' }
      }
    })()
    const onDisk = readJsonSafe(`${dirFor(group)}/poller.json`)
    let lagSec = null
    if (typeof onDisk?.updatedAt === 'string') {
      const parsed = Date.parse(onDisk.updatedAt.replace(' ', 'T'))
      if (!Number.isNaN(parsed)) lagSec = Math.round((now().getTime() - parsed) / 1000)
    }
    const transportInfo = (() => {
      try {
        const active = typeof getTransport === 'function' ? getTransport() : transport
        return active?.describe ? active.describe() : { ok: false, error: '传输层未接入' }
      } catch (error) {
        record('transport.describe', error)
        return { ok: false, error: '传输层不可用' }
      }
    })()
    const windowActive = win.active && win.stopped !== true
    // 当前故障只取本实例的采集结果；磁盘上的旧停止原因保留在 window 中作为历史。
    const failures = pollerState.consecutiveFailures ?? 0
    const unhealthy = !session.persistence.ok || failures > 0 || (collectionStop?.group === group && Boolean(collectionStop.collectionError))
    if (unhealthy && degradedSince === null) degradedSince = stamp()
    if (!unhealthy) degradedSince = null
    const degraded = {
      active: unhealthy,
      reason: unhealthy ? (session.persistence.error ?? pollerState.lastError ?? collectionStop?.collectionError ?? '采集失败') : null,
      since: degradedSince,
    }
    return {
      ok: true,
      value: {
        phase: disposed ? 'disposed' : unhealthy ? 'degraded' : windowActive ? 'running' : 'idle',
        group,
        dataRoot: root(),
        window: win,
        poll: {
          intervalSec: typeof cfg?.intervalSec === 'number' ? cfg.intervalSec : null,
          lagSec,
          updatedAt: pollerState.updatedAt ?? onDisk?.updatedAt ?? null,
          lastSeenMsgTime: pollerState.configured === true
            ? pollerState.lastSeenMsgTime
            : (typeof onDisk?.lastSeenMsgTime === 'number' ? onDisk.lastSeenMsgTime : 0),
          watchedMsgs: pollerState.configured === true
            ? pollerState.watchedMsgs
            : (typeof onDisk?.watchedMsgs === 'number' ? onDisk.watchedMsgs : null),
          running: pollerState.running === true,
          consecutiveFailures: failures,
          lastError: pollerState.lastError ?? null,
          lastErrorKind: pollerState.lastErrorKind ?? null,
          recovering: pollerState.recovering === true,
          failureLimit: pollerState.failureLimit,
          nextRetryAt: pollerState.nextRetryAt ?? null,
        },
        sends: { count: win.sentCount, lastSendAt: win.lastSendAt, lastSendContent: win.lastSendContent },
        selfUid: win.selfUid || pollerState.selfUid || '',
        judge: {
          enabled: cfg?.judge?.enabled === true,
          model: cfg?.judge?.model ?? null,
          unavailablePolicy: cfg?.judge?.unavailablePolicy ?? null,
          available: null,
          // 只说"设置页里存了 key"，绝不回显 key 本身（快照会进页面与工具输出）。
          keyStored: hasStoredKey(),
        },
        llm: {
          provider: cfg?.llm?.provider || null,
          model: cfg?.llm?.model || null,
          fallback: '宿主默认档（ctx.agentDefaultModel）',
          resolved: (() => { try { return getModelSelection?.() ?? null } catch { return null } })(),
        },
        transport: transportInfo,
        dryRun: cfg?.dryRun === true,
        replyOnlyWhenMentioned: cfg?.replyOnlyWhenMentioned === true,
        round: lastRound,
        degraded: { ...degraded },
        warnings: [...settings.warnings],
        configState: settings.state,
        errors: [...errors],
        persistence: { ...session.persistence },
        now: stamp(),
      },
    }
  }

  /** `YYYY-MM-DD HH:mm:ss` → 毫秒（读不动给 NaN）。 */
  function stampMs(stamp) {
    if (typeof stamp !== 'string' || stamp === '') return Number.NaN
    const parsed = Date.parse(stamp.replace(' ', 'T'))
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }

  /** 当前毫秒（now 注入值坏掉时回落 `Date.now`）。 */
  function nowMs() {
    try {
      const value = now().getTime()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  /**
   * 发送流水线（不在队列里：调用方负责排队）。
   * 自动发送准备上下文后交给 `lib/send.js`；手动发送只校验目标和正文。状态记账由本模块独占。
   * @param params - `{ text, opening?, manual? }`。
   * @returns 发送结果，永不抛。
   */
  async function deliverText(params = {}, replyContext = null) {
    const cfg = ensureConfig()
    const group = validateGroup(cfg?.group) ?? ''
    const directory = dirFor(group)
    if (group === '' || directory === '') return { ok: false, reason: 'no group configured', detail: '未配置有效目标群' }

    const text = typeof params.text === 'string' ? params.text : ''
    if (text.trim() === '') return { ok: false, reason: 'empty message', detail: '消息不能为空' }
    const manual = params.manual === true
    const opening = !manual && params.opening === true
    if (!manual && !session.persistence.ok) return { ok: false, stage: 'guard', reason: 'persistence failed', detail: session.persistence.error }
    if (!manual && collectionStop?.group === group) return { ok: false, stage: 'guard', reason: 'collection stopped', detail: collectionStop.stoppedReason }
    const failureVersion = manual ? null : params.failureVersion ?? poller.state().failureVersion
    if (!manual && (poller.state().consecutiveFailures > 0 || poller.state().failureVersion !== failureVersion)) {
      return { ok: false, stage: 'guard', reason: 'collection stopped', detail: '采集中断，本次自动回复已作废' }
    }

    const state = readState(group, !manual)
    const selfUid = replyContext?.uid || (typeof state.selfUid === 'string' && state.selfUid) || (manual ? '' : poller.state().selfUid) || ''
    let context = {}
    if (!manual) {
      const messages = (poller.readMessages(50, group).rows ?? []).filter(Boolean)
      const questions = loadQuestions()
      context = {
        lastMessage: messages.length > 0 ? messages[messages.length - 1] : null,
        judgeState: buildState({
          messages: messages.slice(-14), selfUid, sinceMs: 0, newMark: 1,
          sentMessages: Array.isArray(state.sentMessages) ? state.sentMessages : [],
          replyTargets: replyContext?.targets ?? null,
          ...(replyContext?.displayName ? { chat: { our_account_display_name: replyContext.displayName } } : {}),
        }),
        draftQuestions: questions.ok === true ? questions.questions.draft : null,
      }
    }

    const result = await senderInstance.deliver({
      transport: (() => {
        try {
          return typeof getTransport === 'function' ? getTransport() : transport ?? null
        } catch (error) {
          record('send.transport', error)
          return null
        }
      })(),
      group,
      text,
      opening,
      manual,
      canSend: () => {
        const poll = poller.state()
        const win = windowInfo(group)
        return !disposed && session.persistence.ok && collectionStop?.group !== group && poll.consecutiveFailures === 0
          && poll.failureVersion === failureVersion && win.active && !win.stopped
          && (!replyContext || !poll.selfUid || poll.selfUid === replyContext.uid)
      },
      dryRun: cfg?.dryRun === true,
      config: cfg,
      state,
      selfUid,
      replyTargets: replyContext?.targets ?? null,
      sentMessages: Array.isArray(state.sentMessages) ? state.sentMessages : [],
      ...context,
      nowMs: nowMs(),
    })

    // 判读/守卫流水（成功与拒绝都记，便于复盘"为什么没发"）。
    try {
      const append = store?.appendJsonlCapped ?? store?.appendJsonl
      append?.call(store, `${directory}/judge.jsonl`, {
        at: store?.nowStamp?.(now()) ?? '',
        mode: opening ? 'opening' : 'send',
        decision: result.ok === true ? (result.dryRun === true ? 'dry' : 'sent') : 'blocked',
        reason: result.reason ?? '',
        detail: String(result.detail ?? '').slice(0, 300),
        msgId: result.msgId ?? '',
        warnings: result.warnings ?? [],
      }, JUDGE_LOG_CAP)
    } catch {
      // 日志失败不影响发送结果
    }

    if (result.ok === true && result.dryRun !== true) {
      const saved = session.recordSend({ group, selfUid, text, opening, msgId: result.msgId ?? '', fallbackState: state })
      return { ...result, stateWritten: saved.stateWritten, warnings: [...(result.warnings ?? []), ...saved.warnings] }
    }
    return result
  }

  /** 官方 @ 筛选与当前显示名共同确认目标；仅查询，不改变采集水位。 */
  async function mentionedReplies(newMessages, group, selfUid) {
    const quiet = reason => ({ targets: [], displayName: '', reason })
    if (!selfUid) return quiet('无法确认当前账号，本轮不回复')
    const fresh = (Array.isArray(newMessages) ? newMessages : []).filter(message => message?.msgId
      && Number.isSafeInteger(message.t_msg) && message.t_msg > 0 && message.from !== selfUid)
    if (fresh.length === 0) return quiet('本轮没有可确认的 @ 我新消息')
    try {
      const active = typeof getTransport === 'function' ? getTransport() : transport
      if (!active?.search || !active?.currentUser) return quiet('@ 识别接口不可用，本轮不回复')
      const times = fresh.map(message => message.t_msg)
      // 服务端搜索在秒级边界上会漏掉极窄毫秒区间；放宽一秒后仍按消息 ID 求交。
      const found = await active.search({
        group, pageSize: 50, atMembers: [selfUid],
        timeStart: Math.max(0, Math.min(...times) - 1000), timeEnd: Math.max(...times) + 1000,
      })
      if (found?.ok !== true || !Array.isArray(found.value?.messages)) return quiet(`@ 消息查询失败：${found?.error ?? '无有效结果'}`)
      if (found.value.uid !== selfUid) return quiet('@ 查询账号与采集账号不一致，本轮不回复')
      const ids = new Set(found.value.messages.map(message => message?.msgId).filter(Boolean))
      const candidates = fresh.filter(message => ids.has(message.msgId))
      if (candidates.length === 0) return quiet('本轮没有直接 @ 当前账号的新消息')
      const identity = await active.currentUser()
      if (identity?.ok !== true) return quiet(`读取当前账号显示名失败：${identity?.error ?? '无有效结果'}`)
      if (identity.value?.uid !== selfUid) return quiet('当前账号与采集账号不一致，本轮不回复')
      const names = (Array.isArray(identity.value.names) ? identity.value.names : [])
        .filter(name => typeof name === 'string' && name.trim() !== '' && name.trim() !== '所有人').map(name => name.trim())
      if (names.length === 0) return quiet('当前账号显示名不可用，本轮不回复')
      // ponytail: 搜索 API 不返回 atUids，组合识别可能误认手打/引用的同名 @；原始成员字段可用后改用 UID 判定。
      const patterns = names.map(name => new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s\\p{P}\\p{S}])`, 'u'))
      const targets = candidates.filter(message => typeof message.content === 'string' && patterns.some(pattern => pattern.test(message.content)))
      return { uid: selfUid, targets, displayName: names.join(' / '), reason: targets.length ? '' : '本轮没有正文直接 @ 当前显示名的新消息' }
    } catch (error) {
      record('mention', error)
      return quiet('@ 消息识别失败，本轮不回复')
    }
  }

  /**
   * 跑一轮：只在窗口活着时判；判读完只有 `speak` 才交给发送流水线。
   * 记账：`round.jsonl` 一行（成功/拒绝/安静都记，便于复盘）。
   * @param newMessages - 这一批新消息。
   * @returns `{ ok, verdict, reason, text?, send? }`，永不抛（异常由队列兜底）。
   */
  async function runOneRound(newMessages, failureVersion = poller.state().failureVersion) {
    const startedMs = nowMs()
    const cfg = ensureConfig()
    const group = typeof cfg?.group === 'string' ? cfg.group : ''
    const directory = dirFor(group)
    if (group === '' || directory === '') return { ok: false, error: '未配置群 ID' }
    if (!session.persistence.ok) return { ok: true, verdict: 'skipped', reason: session.persistence.error }
    if (collectionStop?.group === group) return { ok: true, verdict: 'skipped', reason: collectionStop.stoppedReason }
    if (poller.state().consecutiveFailures > 0 || poller.state().failureVersion !== failureVersion) {
      return { ok: true, verdict: 'skipped', reason: '采集恢复中或本轮消息已失效' }
    }

    const state = readState(group, true)
    if (state.stopped === true) return { ok: true, verdict: 'skipped', reason: '窗口已静音/停止' }
    if (typeof state.startedAt !== 'string' || state.startedAt === '') return { ok: true, verdict: 'skipped', reason: '从未开窗' }
    const endsAtMs = stampMs(state.endsAt)
    if (Number.isFinite(endsAtMs) && startedMs > endsAtMs) return { ok: true, verdict: 'skipped', reason: '窗口已过期' }

    const messages = (poller.readMessages(50, group).rows ?? []).filter(Boolean)
    const selfUid = cfg.replyOnlyWhenMentioned === true
      ? poller.state().selfUid || state.selfUid || ''
      : (typeof state.selfUid === 'string' && state.selfUid) || poller.state().selfUid || ''
    const newCount = Array.isArray(newMessages) ? newMessages.length : 0
    const questions = loadQuestions()
    const replyContext = cfg.replyOnlyWhenMentioned === true
      && roundView({ messages, newCount, selfUid, nowMs: startedMs }).verdict !== 'blocked'
      ? await mentionedReplies(newMessages, group, selfUid) : null

    const plan = await roundRunner.plan({
      messages,
      newCount,
      selfUid,
      sentMessages: Array.isArray(state.sentMessages) ? state.sentMessages : [],
      config: cfg,
      questions: questions.ok === true ? questions.questions.round : null,
      replyTargets: replyContext?.targets,
      selfDisplayName: replyContext?.displayName,
      mentionReason: replyContext?.reason,
    })

    let send = null
    if (plan.verdict === 'speak') send = await deliverText({ text: plan.draft, opening: false, failureVersion }, replyContext)

    const verdict = send === null
      ? plan.verdict
      : send.ok === true
        ? (send.dryRun === true ? 'dry' : 'sent')
        : 'send-blocked'
    const entry = {
      now: store?.nowStamp?.(now()) ?? '',
      verdict,
      planned: plan.verdict,
      action: plan.view?.action ?? '',
      blockers: plan.view?.blockers ?? [],
      advisories: plan.view?.advisories ?? [],
      reason: plan.reason ?? '',
      sendReason: send?.reason ?? '',
      sendWarnings: Array.isArray(send?.warnings) ? send.warnings : [],
      newCount,
      ms: Math.max(0, nowMs() - startedMs),
      draft: plan.draft ?? '',
      msgId: send?.msgId ?? '',
    }
    lastRound = { at: entry.now, verdict, reason: entry.reason, newCount, draft: entry.draft, sendReason: entry.sendReason }
    try {
      // 一轮一行的流水：长期开窗（连着的 24h 窗口）也要有天花板。
      const append = store?.appendJsonlCapped ?? store?.appendJsonl
      append?.(`${directory}/round.jsonl`, entry, ROUND_LOG_CAP)
    } catch {
      // 流水失败不影响本轮结论
    }
    logger?.(`watcher: 一轮 ${verdict}（${entry.reason}${entry.sendReason === '' ? '' : `；${entry.sendReason}`}）`)
    return { ok: true, verdict, reason: entry.reason, text: plan.draft, send, view: plan.view }
  }

  /** 同步停止，故障回调不等待正在判读/发送的队列；记账会合并此标记。 */
  function stopMonitoring(params = {}) {
    const cfg = ensureConfig()
    const group = typeof cfg?.group === 'string' ? cfg.group : ''
    if (params?.mode !== 'mute') poller.stop()
    if (dirFor(group) === '') return { ok: false, error: '数据根不可用' }
    return session.stopWindow(group, params)
  }

  return {
    /** 状态快照。 */
    status() {
      try {
        return snapshot()
      } catch (error) {
        record('status', error)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** 手动检查只读登录状态，独立于轮次写队列，避免等待 CLI 时阻塞停止按钮。 */
    async checkCli() {
      try {
        if (disposed) return { ok: false, error: '实例已释放' }
        const active = typeof getTransport === 'function' ? getTransport() : transport
        if (typeof active?.checkAuth !== 'function') return { ok: false, error: 'POPO CLI 检查不可用：宿主未提供传输服务，请重新加载插件。' }
        return await active.checkAuth()
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** 当前配置（含默认值与告警）。 */
    getConfig(options = {}) {
      return settings.getConfig(options)
    },

    /** 修改配置：规范化 + 落盘，只接受已知字段。 */
    updateConfig(patch) {
      return enqueue(() => settings.updateConfig(patch))
    },

    /**
     * 判读 key 的状态：**只说有没有、从哪来，绝不回显 key 本身**。
     * @returns Promise<`{ ok, configured, source }`>，永不 reject。
     */
    keyStatus() {
      return enqueue(() => settings.keyStatus())
    },

    /**
     * 存一个判读 key（设置页用）。写入 `<数据根>/secret.json`，返回值里**不带 key**。
     * @param key - 用户输入的 key。
     * @returns Promise<`{ ok, configured?, source?, error? }`>，永不 reject。
     */
    setKey(key) {
      return enqueue(() => settings.setKey(key))
    },

    /**
     * 清除设置页存的 key（环境变量/注册表那两档不受影响）。
     * @returns Promise<`{ ok, configured, source, error? }`>，永不 reject。
     */
    clearKey() {
      return enqueue(() => settings.clearKey())
    },

    /**
     * 从 skill 的数据目录导入历史（身份 / 发言记录 / 水位 / 消息流水）。
     *
     * 纪律：**只补缺，绝不覆盖**——目标文件已存在就跳过并如实说明；**不导入窗口**
     * （导入完是"已停止"状态，不点开窗就不会采集、不会发言）。
     * @param params - `{ from? }`：源目录，默认 `LEGACY_DEFAULT_DIR`。
     * @returns Promise<`{ ok, group, from, imported, skipped, error? }`>，永不 reject。
     */
    importLegacy(params = {}) {
      return enqueue(() => history.importLegacy(params))
    },

    /** 开新窗口：重算 endsAt、清 stopped，然后启动采集（水位与发言记录保留）。 */
    startWindow(params = {}) {
      const requestedVersion = ++controlVersion
      return enqueue(async () => {
        if (requestedVersion !== controlVersion) return { ok: false, error: '开始请求已取消' }
        const poll = poller.state()
        if (poll.inFlight && !poll.running) return { ok: false, error: '上一轮采集尚未结束，请稍后重新开启' }
        const cfg = ensureConfig()
        const group = typeof cfg?.group === 'string' ? cfg.group : ''
        if (group === '') return { ok: false, error: '配置里没有群 ID' }
        const directory = dirFor(group)
        if (directory === '') return { ok: false, error: '数据根不可用' }
        const hours = Number.isFinite(params?.hours) && params.hours > 0 ? Number(params.hours) : cfg.windowHours
        const begun = session.beginWindow(group, cfg, hours)
        if (begun.ok !== true) return begun
        const { startedAt, endsAt } = begun.window

        collectionStop = null
        const configured = poller.configure({ group, intervalSec: cfg.intervalSec })
        if (configured?.ok !== true) return { ok: false, error: configured?.error ?? '配置采集失败' }
        const started = await poller.start()
        if (requestedVersion !== controlVersion) return { ok: false, error: '开始请求已取消' }
        if (started?.ok !== true) return { ok: false, error: `采集失败，已自动停止：${started?.error ?? '未知错误'}` }
        // 新窗口从"没有降级"重新开始计时（degraded 是派生字段，这里只清掉起点）。
        degradedSince = null
        logger?.(`watcher: 窗口已开启 ${startedAt} → ${endsAt}（${hours}h）`)

        // 开场白：窗口一起来就先打个招呼（每窗口一条，守卫在 lib/guards.js 的 opening 分支里卡）。
        // 采集已经起来了，所以这一步失败也只是少一句招呼，不回滚窗口。
        let opening = null
        if (cfg?.opening?.enabled === true && typeof cfg.opening.text === 'string' && cfg.opening.text !== '') {
          opening = started.recovering === true
            ? { ok: false, reason: '首次采集失败，本窗口不补发开场白' }
            : await deliverText({ text: cfg.opening.text, opening: true })
          if (opening?.ok !== true) logger?.(`watcher: 开场白未发出（${opening?.reason ?? '未知'}）`)
        }
        return { ok: true, window: { startedAt, endsAt, hours }, polling: started?.ok === true, recovering: started.recovering === true, opening }
      })
    },

    /** 停止：mode=stop 同时停采集；mode=mute 只标记静音（采集继续）。 */
    stop(params = {}) {
      // 同步失效旧草稿并提交停止状态；迟到回执会合并最新状态。
      try {
        if (disposed) return Promise.resolve({ ok: false, error: '实例已释放' })
        controlVersion += 1
        return Promise.resolve(stopMonitoring(params))
      } catch (error) {
        return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },

    /** 本轮发言记录（页面 / 工具用）。 */
    sends(limit = 20) {
      return history.sends(limit)
    },

    /** 日志尾部（判读流水 + 每轮记录 + 轮询日志合并，给页面看）。 */
    log(limit = 50) {
      return history.log(limit)
    },

    /**
     * 主动发一条（页面手动发送 / agent 工具 / 自动轮次都用它）。
     * 排队执行；真正的流水线在内部函数 `deliverText()`（轮次里复用它，避免重复排队死锁）。
     * @param params - `{ text, opening?, manual? }`；仅页面显式发送传 manual:true，自动轮次不传。
     * @returns 发送结果（含被守卫拒绝的 reason），永不抛。
     */
    sendNow(params = {}) {
      return enqueue(() => deliverText(params))
    },

    /**
     * 立刻判一轮（自动轮次的公开入口；采集回调内部也会调它）。
     * 只判不发状态：判读/文案都在这里，机械守卫与发送走 `deliverText`。
     * @param newMessages - 这一批新消息（采集回来的），用来算"有几条是新的"。
     * @returns `{ ok, verdict, reason, text?, send? }`，永不抛。
     */
    runRound(newMessages = []) {
      const failureVersion = poller.state().failureVersion
      return enqueue(() => runOneRound(newMessages, failureVersion))
    },

    /**
     * 立刻跑一次判读（不改状态、不发送）：
     * - 不给 `draft` → 判"这一轮有没有切口"（机械视图 + TypeSafe round）；
     * - 给了 `draft` → 判"这句草稿能不能发"（草稿模式）。
     * @param params - `{ draft? }`。
     * @returns `{ ok, view?, judgement?, decision?, error? }`，永不抛。
     */
    judgeNow(params = {}) {
      return enqueue(async () => {
        const cfg = ensureConfig()
        const group = typeof cfg?.group === 'string' ? cfg.group : ''
        const directory = dirFor(group)
        if (group === '' || directory === '') return { ok: false, error: '未配置群 ID' }

        const state = readState(group)
        const messages = (poller.readMessages(50, group).rows ?? []).filter(Boolean)
        const selfUid = (typeof state.selfUid === 'string' && state.selfUid) || poller.state().selfUid || ''
        const questions = loadQuestions()
        if (questions.ok !== true) return { ok: false, error: questions.error ?? '问句集不可用' }

        const draft = typeof params.draft === 'string' && params.draft.trim() !== '' ? params.draft : null
        const judgeState = buildState({
          messages: messages.slice(-14),
          selfUid,
          sinceMs: 0,
          newMark: draft === null ? 1 : messages.length,
          sentMessages: Array.isArray(state.sentMessages) ? state.sentMessages : [],
        })

        if (judgeClient === undefined || judgeClient === null) {
          return { ok: false, error: '判读客户端未接入（需要宿主 llm/fetch 环境）' }
        }
        if (draft !== null) {
          const result = await judgeClient.runDraft(buildDraftState(judgeState, draft), questions.questions.draft)
          if (result?.ok !== true) return { ok: false, error: result?.error ?? '判读失败' }
          return { ok: true, mode: 'draft', draft, answers: result.answers, formatted: result.formatted, decision: decideDraft(result.answers, draft, cfg?.judge?.thresholds) }
        }

        const view = roundView({ messages, newCount: judgeState.conversation.filter((row) => row.is_new).length, selfUid, nowMs: now().getTime() })
        if (view.verdict === 'blocked') return { ok: true, mode: 'round', view, judgement: null, answerCount: null }
        const result = await judgeClient.runRound(judgeState, questions.questions.round)
        if (result?.ok !== true) {
          return { ok: true, mode: 'round', view, judgement: null, error: result?.error ?? '判读失败', answerCount: null }
        }
        const decision = decideRound(result.answers, cfg?.judge?.thresholds)
        const composed = composeRoundView(view, {
          ok: true,
          action: decision.action,
          kind: decision.kind,
          guidance: decision.guidance,
          reasons: decision.reasons,
          advisories: decision.advisories,
        })
        return { ok: true, mode: 'round', view: composed, judgement: result.answers, answerCount: Object.keys(result.answers ?? {}).length }
      })
    },

    /** 页面实时读取服务端最近消息；独立于采集、判读和发送，不写任何监控状态。 */
    async messages(limit = 30) {
      try {
        if (disposed) return { ok: false, error: '实例已释放' }
        const cfg = ensureConfig()
        const group = typeof cfg?.group === 'string' ? cfg.group : ''
        if (settings.state === 'error') return { ok: false, error: '配置读取失败，无法确认目标群' }
        if (!/^\d+$/.test(group)) return { ok: false, error: '未配置有效的群 ID' }
        const active = typeof getTransport === 'function' ? getTransport() : transport
        if (typeof active?.search !== 'function') return { ok: false, error: 'POPO 消息读取不可用：宿主未提供传输服务' }
        const take = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 30
        // 不传采集器的 sessionFile：传输层会创建独立临时文件并负责清理。
        const result = await active.search({ group, pageSize: take })
        if (disposed || ensureConfig()?.group !== group) return { ok: false, error: '目标群或插件实例已变化，请重新读取' }
        if (result?.ok !== true) return { ok: false, error: result?.error ?? '获取群消息失败' }
        const messages = result.value?.messages
        if (!Array.isArray(messages) || messages.some(row => !Number.isFinite(row?.t_msg) || row.t_msg <= 0)) {
          return { ok: false, error: 'POPO 未返回有效的消息列表' }
        }
        return { ok: true, rows: [...messages].sort((a, b) => b.t_msg - a.t_msg).slice(0, take), group, fetchedAt: stamp() }
      } catch (error) {
        record('messages', error)
        return { ok: false, rows: [], error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** 宿主启动时按需恢复：窗口未过期且未静音、且 autoResume 打开才启动采集。 */
    resume() {
      return enqueue(async () => {
        try {
          const cfg = ensureConfig()
          const group = typeof cfg?.group === 'string' ? cfg.group : ''
          if (group === '') return { ok: true, resumed: false, reason: '未配置群 ID' }
          readState(group, true)
          if (cfg?.autoResume !== true) return { ok: true, resumed: false, reason: 'autoResume 关闭' }
          const win = windowInfo(group)
          if (win.startedAt === null || win.endsAt === null) return { ok: true, resumed: false, reason: '从未开窗' }
          if (win.stopped === true) return { ok: true, resumed: false, reason: '窗口处于静音/停止' }
          if (typeof win.remainingSec === 'number' && win.remainingSec <= 0) return { ok: true, resumed: false, reason: '窗口已过期' }
          const configured = poller.configure({ group, intervalSec: cfg.intervalSec })
          if (configured?.ok !== true) return { ok: false, error: configured?.error ?? '配置采集失败' }
          const started = await poller.start()
          if (started?.ok !== true) return { ok: false, error: started?.error ?? '采集失败' }
          logger?.(`watcher: 恢复采集（窗口剩余 ${win.remainingSec ?? '未知'} 秒）`)
          return { ok: true, resumed: started?.ok === true, recovering: started.recovering === true }
        } catch (error) {
          record('resume', error)
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })
    },

    /** 释放：幂等，停采集并拒绝后续写入。 */
    dispose() {
      if (disposed) return
      disposed = true
      try {
        poller.dispose()
      } catch (error) {
        void error
      }
      try {
        queue = Promise.resolve()
      } catch (error) {
        void error
      }
    },
  }
}
