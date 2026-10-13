/**
 * 采集循环：每 `intervalSec` 秒拉一次群消息，落 `messages.jsonl` 与轮询水位。
 *
 * 这一层刻意只做"捕获"，不做判断（对应 skill 里 watcher 与 agent 的分工）：采集绝不能因为
 * 决策慢而停摆，所以这里是独立的、可单飞、可退避的定时任务；判读与发送接在 `onMessages` 上
 * （watcher 收到新消息后触发一轮，见 `lib/watcher.js` 的 `triggerRound`）。
 *
 * 纪律：
 * - never-throw：任何失败都记日志 + 计数，不抛；
 * - 单飞：上一轮没结束就跳过本次（旧的 20s 节奏靠它保证，不叠加请求）；
 * - 退避：连续失败时按 `intervalSec * 2^n` 递增，上限 `maxBackoffSec`；成功即清零；
 * - 定时器可注入（测试用），默认基于 `setTimeout` 自重排，避免 `setInterval` 的重叠与漂移。
 *
 * @module dsh-popo-watcher/poller
 */

/** 单次搜索的条数（与 skill 的 `pageSize=15` 一致）。 */
const PAGE_SIZE = 15

/** 退避上限（秒）。 */
const MAX_BACKOFF_SEC = 300

/** 首次失败也计数：最多四次重试，第五次连续失败停止。 */
const FAILURE_LIMIT = 5

/** 日志行数上限（`poll.log`）。 */
const LOG_LINES = 500

/** `messages.jsonl` 的上限：20 秒一条的流水必须有个天花板。 */
import { MESSAGE_CAP } from './limits.js'

/**
 * 创建采集循环。
 * @param options - 依赖注入。
 * @param options.store - `lib/store.js` 模块。
 * @param options.getTransport - `() => Transport | null`，每次调用都重新取（宿主服务可能后到）。
 * @param options.logger - 日志回调。
 * @param options.now - 取当前时间（默认 `() => new Date()`）。
 * @param options.schedule - `(fn, ms) => cancel`，默认 `setTimeout`。
 * @param options.onMessages - `(messages) => void`，新消息落盘后的回调。
 * @param options.onPollSuccess - `(messages) => void`，水位保存成功后的回调，包括没有新消息的轮次。
 * @param options.shouldStop - `() => string | null`：采集前后检查"外部原因该收工了吗"，
 *   返回原因字符串即停表（例如窗口已过期）。默认不干预。
 * @param options.resolveDir - `(group) => string`：群目录由调用方给（watcher 是路径的唯一主人）。
 *   缺省才回落到 `store.dataRoot()` + `store.groupDir()`——**别让两处各算一份路径**：
 *   `dataRoot()` 读的是 `process.env`，与调用方注入的 env 可能不是同一个 home。
 * @returns 采集循环实例。
 */
export function createPoller(options = {}) {
  const {
    store,
    getTransport,
    logger,
    now = () => new Date(),
    schedule = (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
    onMessages,
    onPollSuccess,
    shouldStop,
    resolveDir,
  } = options

  /** 当前目标（configure 后才有）。 */
  let target = null
  /** 是否处于运行状态。 */
  let running = false
  /** 取消当前排队的定时器。 */
  let cancelTimer = null
  /** 单飞标记。 */
  let inFlight = false
  /** 连续失败次数。 */
  let consecutiveFailures = 0
  /** 水位与活性。 */
  let watermark = { lastSeenMsgTime: 0, updatedAt: null, selfUid: '', watchedMsgs: 0 }
  /** 最近一次失败原因（供 UI 显示）。 */
  let lastError = null
  let lastErrorKind = null
  let retryable = false
  /** 故障序号不随成功清零，用于作废故障前尚未提交的回复。 */
  let failureVersion = 0
  /** 运行代次阻止停止/重开前的回调和在途结果影响新一轮。 */
  let runVersion = 0
  /** 下次重试的 Unix 毫秒时间；正常采集、正在请求或停止时为空。 */
  let nextRetryAt = null
  /** 水位是否已从磁盘读过（没读过时 state() 会惰性读一次，避免页面显示 0）。 */
  let watermarkLoaded = false
  /** CLI 噪声是否已经记过日志（只记一次）。 */
  let noiseLogged = false
  /** dispose 标记。 */
  let disposed = false

  /**
   * 群目录（store 不可用时返回空串）。
   * @param group - 可选：显式指定群 ID（未 `configure` 也能读历史消息）；缺省用当前目标。
   */
  function dir(group) {
    try {
      const target0 = typeof group === 'string' && group !== '' ? group : target?.group
      if (!target0) return ''
      // 调用方给了路径就听调用方的（watcher 是唯一知道数据根的人）。
      if (typeof resolveDir === 'function') {
        const resolved = resolveDir(target0)
        if (typeof resolved === 'string' && resolved !== '') return resolved
      }
      if (!store?.dataRoot || !store?.groupDir) return ''
      return store.groupDir(store.dataRoot(), target0)
    } catch (error) {
      logger?.(`poller: 解析数据目录失败 ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /** 日志（失败忽略）。 */
  function log(line) {
    try {
      const file = dir()
      if (file === '' || !store?.appendLineCapped) return
      store.appendLineCapped(`${file}/poll.log`, `${store.nowStamp?.(now()) ?? ''} ${line}`, LOG_LINES)
    } catch {
      // 日志失败不影响采集
    }
  }

  /** 读水位（失败回落内存值）。 */
  function loadWatermark() {
    try {
      const file = dir()
      if (file === '' || !store?.readJson) return
      const read = store.readJson(`${file}/poller.json`, undefined)
      const value = read?.ok === true ? read.value : undefined
      if (value === null || typeof value !== 'object') return
      watermark = {
        lastSeenMsgTime: typeof value.lastSeenMsgTime === 'number' ? value.lastSeenMsgTime : watermark.lastSeenMsgTime,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : watermark.updatedAt,
        selfUid: typeof value.selfUid === 'string' ? value.selfUid : watermark.selfUid,
        watchedMsgs: typeof value.watchedMsgs === 'number' ? value.watchedMsgs : watermark.watchedMsgs,
      }
    } catch {
      // 读失败就用内存里的水位
    }
  }

  /** 只有确认写盘成功，才提交这一批水位。 */
  function saveWatermark(value) {
    try {
      const file = dir()
      if (file === '' || !store?.writeJsonAtomic) return { ok: false, error: '水位存储不可用' }
      return store.writeJsonAtomic(`${file}/poller.json`, { ...value })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 追加一条消息（带上限：长期开窗不会把 messages.jsonl 撑成无限大）。 */
  function appendMessage(record) {
    try {
      const file = dir()
      // 优先带上限的版本；注入的 store 只有 plain appendJsonl 时也照跑（第三个参数被忽略）。
      const append = store?.appendJsonlCapped ?? store?.appendJsonl
      if (file === '' || typeof append !== 'function') return { ok: false, error: '消息存储不可用' }
      return append.call(store, `${file}/messages.jsonl`, record, MESSAGE_CAP)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  function failed(result) {
    consecutiveFailures += 1
    failureVersion += 1
    lastError = result?.error ?? '未知失败'
    retryable = result?.retryable === true
    const kind = result?.kind ?? 'upstream'
    lastErrorKind = kind
    log(`poll failed (${kind}, ${consecutiveFailures}/${FAILURE_LIMIT}): ${lastError}`)
    return { ok: false, kind, newCount: 0, error: lastError }
  }

  function failureStopReason() {
    if (consecutiveFailures === 0) return null
    if (lastErrorKind === 'persistence') return `持久化失败，已自动停止：${lastError}`
    if (!retryable) return `采集失败，已自动停止：${lastError}`
    if (consecutiveFailures >= FAILURE_LIMIT) return `连续失败 ${FAILURE_LIMIT} 次，已停止：${lastError}`
    return null
  }

  /** watcher 在回调中持久化故障停止原因；独立采集器也遵守失败上限。 */
  function stopIfNeeded() {
    let reason = failureStopReason()
    try {
      reason = shouldStop?.() || reason
    } catch (error) {
      logger?.(`poller: shouldStop 抛错（忽略）${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof reason !== 'string' || reason === '') return false
    running = false
    nextRetryAt = null
    runVersion += 1
    if (cancelTimer !== null) cancelTimer()
    cancelTimer = null
    log(`poller stop: ${reason}`)
    return true
  }

  /**
   * 跑一轮采集（生产由定时器调用；测试可直接调）。
   * @returns `{ ok, kind?, newCount, error? }`。
   */
  async function tickOnce() {
    if (disposed || target === null) return { ok: false, kind: 'idle', newCount: 0, error: '未配置目标群' }
    if (inFlight) return { ok: false, kind: 'busy', newCount: 0, error: '上一轮未结束' }

    const transport = (() => {
      try {
        return getTransport?.() ?? null
      } catch (error) {
        logger?.(`poller: 取传输层失败 ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    })()
    if (transport === null) {
      return failed({ kind: 'cli-missing', error: '传输层不可用（宿主未提供 subprocess 服务或找不到 popo-cli）' })
    }

    const version = runVersion
    inFlight = true
    try {
      const sessionFile = `${dir()}/session.json`
      const result = await transport.search({ group: target.group, pageSize: PAGE_SIZE, sessionFile })
      if (disposed || version !== runVersion || stopIfNeeded()) return { ok: false, kind: 'cancelled', newCount: 0, error: '采集已停止' }
      if (result?.ok !== true) {
        return failed(result)
      }

      const messages = Array.isArray(result.value?.messages) ? result.value.messages : []
      // CLI 输出里的噪声（例如 `> [!WARNING]` 提示）只记一次，免得每 20 秒刷一行。
      const noise = typeof result.value?.noise === 'string' ? result.value.noise : ''
      if (noise !== '' && noiseLogged === false) {
        noiseLogged = true
        log(`cli noise: ${noise.slice(0, 200)}`)
      }
      const fresh = messages
        .filter((message) => typeof message?.t_msg === 'number' && message.t_msg > watermark.lastSeenMsgTime)
        .sort((left, right) => left.t_msg - right.t_msg)

      let appended = 0
      const nextWatermark = { ...watermark }
      // 水位写入失败后，已落盘的批次前缀不能在显式恢复时重复追加。
      const recent = store?.readJsonlTail?.(`${dir()}/messages.jsonl`, PAGE_SIZE)?.rows ?? []
      const savedIds = new Set(recent.map(message => message?.msgId).filter(Boolean))
      for (const message of fresh) {
        const written = message.msgId && savedIds.has(message.msgId) ? { ok: true } : appendMessage(message)
        if (written?.ok !== true) return failed({ kind: 'persistence', error: `写入消息失败：${written?.error ?? '未知错误'}` })
        appended += 1
        if (message.msgId) savedIds.add(message.msgId)
        nextWatermark.lastSeenMsgTime = Math.max(nextWatermark.lastSeenMsgTime, message.t_msg)
        log(`new msg ${message.time} ${message.name}`)
      }

      const uid = typeof result.value?.uid === 'string' ? result.value.uid : ''
      const committed = {
        ...nextWatermark,
        selfUid: uid !== '' ? uid : watermark.selfUid,
        updatedAt: store?.nowStamp?.(now()) ?? new Date().toISOString(),
        watchedMsgs: watermark.watchedMsgs + appended,
      }
      const saved = saveWatermark(committed)
      if (saved?.ok !== true) return failed({ kind: 'persistence', error: `写入水位失败：${saved?.error ?? '未知错误'}` })
      watermark = committed
      consecutiveFailures = 0
      lastError = null
      lastErrorKind = null
      retryable = false
      nextRetryAt = null

      if (appended > 0) {
        try {
          onMessages?.(fresh)
        } catch (error) {
          logger?.(`poller: onMessages 回调失败 ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try {
        onPollSuccess?.(fresh)
      } catch (error) {
        logger?.(`poller: onPollSuccess 回调失败（忽略）${error instanceof Error ? error.message : String(error)}`)
      }
      return { ok: true, newCount: appended }
    } catch (error) {
      if (disposed || version !== runVersion) return { ok: false, kind: 'cancelled', newCount: 0, error: '采集已停止' }
      return failed({ kind: 'spawn', error: error instanceof Error ? error.message : String(error) })
    } finally {
      inFlight = false
    }
  }

  /** 下一次该等多久（退避）。 */
  function nextDelayMs() {
    const base = Number.isFinite(target?.intervalSec) ? Number(target.intervalSec) : 20
    const factor = consecutiveFailures > 0 ? Math.min(2 ** consecutiveFailures, 16) : 1
    return Math.min(base * factor, MAX_BACKOFF_SEC) * 1000
  }

  /** 自重排：跑一轮，再按当前退避排下一轮；外部原因要求收工时直接停表。 */
  async function loop(version) {
    if (!running || disposed || version !== runVersion || stopIfNeeded()) return
    cancelTimer = null
    nextRetryAt = null
    await tickOnce()
    if (!running || disposed || version !== runVersion || stopIfNeeded()) return
    const delay = nextDelayMs()
    nextRetryAt = consecutiveFailures > 0 ? now().getTime() + delay : null
    cancelTimer = schedule(() => {
      void loop(version)
    }, delay)
  }

  return {
    /**
     * 配置目标群与节奏（幂等；变化时重置水位缓存并重新读取磁盘水位）。
     * @param next - `{ group, intervalSec }`。
     */
    configure(next) {
      try {
        const group = String(next?.group ?? '')
        if (group === '') return { ok: false, error: '缺少群 ID' }
        const changed = target === null || target.group !== group
        target = { group, intervalSec: Number.isFinite(next?.intervalSec) ? Number(next.intervalSec) : 20 }
        if (changed) {
          watermark = { lastSeenMsgTime: 0, updatedAt: null, selfUid: '', watchedMsgs: 0 }
          loadWatermark()
          log(`poller configured group=${group} interval=${target.intervalSec}s`)
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** 启动轮询（幂等）；首轮完成后再确认启动结果。 */
    async start() {
      try {
        if (disposed) return { ok: false, error: '实例已释放' }
        if (target === null) return { ok: false, error: '未配置目标群' }
        if (running) return { ok: true, alreadyRunning: true, recovering: consecutiveFailures > 0 }
        if (inFlight) return { ok: false, error: '上一轮采集尚未结束，请稍后重新开启' }
        consecutiveFailures = 0
        lastError = null
        lastErrorKind = null
        retryable = false
        nextRetryAt = null
        running = true
        runVersion += 1
        log('poller start')
        await loop(runVersion)
        if (!running) return { ok: false, error: lastError ?? '采集已停止' }
        return { ok: true, recovering: consecutiveFailures > 0 }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** 停止轮询（幂等；在途的一轮让它自己结束）。 */
    stop() {
      try {
        running = false
        nextRetryAt = null
        runVersion += 1
        failureVersion += 1
        if (cancelTimer !== null) {
          cancelTimer()
          cancelTimer = null
        }
        log('poller stop')
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** 释放：停止并拒绝后续调用。 */
    dispose() {
      try {
        this.stop()
      } catch {
        // 忽略
      }
      disposed = true
    },

    /** 采集快照（供 status / 页面）。 */
    state() {
      // 没配置过也先把磁盘上的水位读出来：否则页面会显示"已抓 0 条"，看起来像丢数据。
      if (!watermarkLoaded && target !== null) {
        loadWatermark()
        watermarkLoaded = true
      }
      return {
        configured: target !== null,
        group: target?.group ?? null,
        running,
        intervalSec: target?.intervalSec ?? null,
        lastSeenMsgTime: watermark.lastSeenMsgTime,
        updatedAt: watermark.updatedAt,
        selfUid: watermark.selfUid,
        watchedMsgs: watermark.watchedMsgs,
        inFlight,
        consecutiveFailures,
        lastError,
        lastErrorKind,
        retryable,
        failureVersion,
        failureLimit: FAILURE_LIMIT,
        failureStopReason: failureStopReason(),
        recovering: running && consecutiveFailures > 0 && failureStopReason() === null,
        nextRetryAt,
      }
    },

    /**
     * 最近消息（供 RPC / 页面 / 轮次判读）。
     * @param limit - 取最后多少条。
     * @param group - 可选群 ID；不给则用当前目标（这样 `configure` 之前也能读历史消息）。
     */
    readMessages(limit = 30, group) {
      try {
        const file = dir(group)
        if (file === '' || !store?.readJsonlTail) return { ok: false, rows: [], error: '数据目录不可用' }
        return store.readJsonlTail(`${file}/messages.jsonl`, limit)
      } catch (error) {
        return { ok: false, rows: [], error: error instanceof Error ? error.message : String(error) }
      }
    },

    /** 测试用：直接跑一轮。 */
    tickOnce,
  }
}
