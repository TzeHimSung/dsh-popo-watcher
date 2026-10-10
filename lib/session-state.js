/** 窗口、待持久化状态与已确认发送回执。不会调用任何外部发送。 */
import { SENDS_LOG_CAP, SENT_MESSAGES_KEEP } from './limits.js'
export function createSessionState({ store, dirFor, readJsonSafe, stamp, now, nowMs, stampMs, record, onPause, getCollectionStop }) {
  let persistence = { ok: true, error: null }
  const pendingStates = new Map()
  const pendingReceipts = []
  const hydratedGroups = new Set()
  function readState(group, recover = false) {
    const state = { ...readJsonSafe(`${dirFor(group)}/state.json`), ...pendingStates.get(group) }
    if (recover && !hydratedGroups.has(group)) {
      hydratedGroups.add(group)
      const receipts = store?.readJsonlTail?.(`${dirFor(group)}/sends.jsonl`, SENDS_LOG_CAP.maxLines)?.rows ?? []
      const sent = Array.isArray(state.sentMessages) ? state.sentMessages : []
      const identity = entry => entry.msgId || `${entry.atMs ?? entry.at}:${entry.content}`
      const known = new Set(sent.map(identity))
      if (state.stopped === true && typeof state.stoppedReason === 'string' && state.stoppedReason.startsWith('持久化失败')) {
        const audited = new Set(receipts.map(identity))
        for (const entry of sent) {
          if (entry && typeof entry.content === 'string' && !audited.has(identity(entry))) pendingReceipts.push({ ...entry, group })
        }
        persistence = { ok: false, error: state.stoppedReason }
      }
      const latest = Number(state.lastSendEpochMs) || stampMs(state.lastSendTimeLocal) || 0
      const missing = receipts.map(entry => ({ ...entry, atMs: Number(entry?.atMs) || stampMs(entry?.at) }))
        .filter(entry => typeof entry.content === 'string' && Number.isFinite(entry.atMs) && entry.atMs >= latest && !known.has(identity(entry)))
      if (missing.length) {
        const last = missing.reduce((a, b) => a.atMs > b.atMs ? a : b)
        Object.assign(state, {
          sentCount: (Number(state.sentCount) || 0) + missing.length,
          sentMessages: [...sent, ...missing].slice(-SENT_MESSAGES_KEEP),
          lastSendEpochMs: last.atMs, lastSendTimeLocal: last.at,
          stopped: true, stoppedReason: '已确认发送回执的记账待恢复',
        })
        pendingStates.set(group, state)
        persistence = { ok: false, error: state.stoppedReason }
      }
    }
    return state
  }

  function writeState(group, value) {
    pendingStates.set(group, value)
    try {
      const directory = dirFor(group)
      const result = directory && store?.writeJsonAtomic
        ? store.writeJsonAtomic(`${directory}/state.json`, value)
        : { ok: false, error: '数据目录不可用' }
      if (result?.ok === true) pendingStates.delete(group)
      return result ?? { ok: false, error: '未确认写盘结果' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  function persistenceFailed(group, error) {
    const message = `持久化失败，自动监控已暂停：${error ?? '未知错误'}`
    persistence = { ok: false, error: message }
    onPause()
    writeState(group, { ...readState(group), stopped: true, stoppedAt: stamp(), stoppedReason: message })
    record('persistence', message)
  }

  function appendReceipt(receipt) {
    try {
      const append = store?.appendJsonlCapped ?? store?.appendJsonl
      return append?.call(store, `${dirFor(receipt.group)}/sends.jsonl`, receipt, SENDS_LOG_CAP)
        ?? { ok: false, error: 'store 不可用' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  function retryPersistence() {
    for (const [group, state] of pendingStates) {
      const written = writeState(group, state)
      if (written.ok !== true) { persistenceFailed(group, written.error); return written }
    }
    while (pendingReceipts.length) {
      const receipt = pendingReceipts[0]
      const written = appendReceipt(receipt)
      if (written.ok !== true) { persistenceFailed(receipt.group, written.error); return written }
      pendingReceipts.shift()
    }
    persistence = { ok: true, error: null }
    return { ok: true }
  }

  function windowInfo(group) {
    const collectionStop = getCollectionStop()
    const state = { ...readState(group), ...(collectionStop?.group === group ? collectionStop : {}) }
    const startedAt = state?.startedAt ?? null
    const endsAt = state?.endsAt ?? null
    let remainingSec = null
    if (typeof endsAt === 'string' && endsAt !== '') {
      const parsed = Date.parse(endsAt.replace(' ', 'T'))
      if (!Number.isNaN(parsed)) remainingSec = Math.round((parsed - now().getTime()) / 1000)
    }
    return {
      active: startedAt !== null && endsAt !== null && (remainingSec === null || remainingSec > 0),
      startedAt,
      endsAt,
      remainingSec,
      stopped: state?.stopped === true,
      stoppedAt: state?.stoppedAt ?? null,
      stoppedReason: state?.stoppedReason ?? null,
      collectionError: state?.collectionError ?? null,
      collectionFailures: state?.collectionFailures ?? 0,
      sentCount: typeof state?.sentCount === 'number' ? state.sentCount : 0,
      lastSendAt: state?.lastSendTimeLocal ?? null,
      lastSendContent: Array.isArray(state?.sentMessages) && state.sentMessages.length > 0
        ? (state.sentMessages[state.sentMessages.length - 1]?.content ?? null)
        : null,
      openingSentAt: state?.openingSentAt ?? null,
      selfUid: state?.selfUid ?? '',
    }
  }

  function recordSend({ group, selfUid, text, opening, msgId, fallbackState }) {
    const at = store?.nowStamp?.(now()) ?? new Date().toISOString()
    const entry = { msgId, at, atMs: nowMs(), content: text, opening }
    const collectionStop = getCollectionStop()
    const latest = { ...fallbackState, ...readState(group), ...(collectionStop?.group === group ? collectionStop : {}) }
    const written = writeState(group, {
      ...latest, group, selfUid,
      sentCount: (Number(latest.sentCount) || 0) + 1,
      lastSendTimeLocal: at, lastSendEpochMs: entry.atMs,
      sentMessages: [...(Array.isArray(latest.sentMessages) ? latest.sentMessages : []), entry].slice(-SENT_MESSAGES_KEEP),
      ...(opening ? { openingSentAt: at } : {}),
    })
    const receipt = { at, atMs: entry.atMs, msgId, group, opening, content: text }
    const audited = appendReceipt(receipt)
    if (audited.ok !== true) pendingReceipts.push(receipt)
    if (written?.ok !== true || audited.ok !== true) {
      const error = written?.ok !== true ? `写入 state.json 失败：${written?.error ?? '未知'}` : `写入发送流水失败：${audited.error ?? '未知'}`
      persistenceFailed(group, error)
      return { stateWritten: written?.ok === true, warnings: [`已发出，记账失败：${error}`] }
    }
    return { stateWritten: true, warnings: [] }
  }

  function beginWindow(group, cfg, hours) {
    const previous = readState(group, true)
    const recovered = retryPersistence()
    if (recovered.ok !== true) return { ok: false, error: `待恢复的记账仍未写入：${recovered.error}` }
    const startedAt = store?.nowStamp?.(now()) ?? new Date().toISOString()
    const endsAt = store?.nowStamp?.(new Date(now().getTime() + hours * 3600 * 1000)) ?? startedAt
    const written = writeState(group, {
      group, selfUid: previous?.selfUid ?? '', startedAt, endsAt,
      sentCount: typeof previous?.sentCount === 'number' ? previous.sentCount : 0,
      minGapSec: typeof cfg?.minGapSec === 'number' ? cfg.minGapSec : 20,
      lastSendTimeLocal: previous?.lastSendTimeLocal ?? null,
      lastSendEpochMs: typeof previous?.lastSendEpochMs === 'number' ? previous.lastSendEpochMs : 0,
      sentMessages: Array.isArray(previous?.sentMessages) ? previous.sentMessages : [],
      stopped: false, openingSentAt: previous?.openingSentAt ?? null,
    })
    if (written?.ok !== true) {
      persistenceFailed(group, written?.error)
      return { ok: false, error: `写入 state.json 失败：${written?.error ?? '未知'}` }
    }
    return { ok: true, window: { startedAt, endsAt, hours } }
  }

  function stopWindow(group, params) {
    const mode = params?.mode === 'mute' ? 'mute' : 'stop'
    const collectionStop = getCollectionStop()
    const state = {
      ...readState(group), ...(collectionStop?.group === group ? collectionStop : {}),
      stopped: true, stoppedAt: stamp(),
      stoppedReason: String(params?.reason ?? (mode === 'mute' ? '仅静音' : '停止监控')),
    }
    const written = writeState(group, state)
    if (written?.ok !== true) {
      persistenceFailed(group, written?.error)
      return { ok: false, error: `写入 state.json 失败：${written?.error ?? '未知'}` }
    }
    return { ok: true, mode, stoppedAt: state.stoppedAt }
  }

  return { readState, persistenceFailed, windowInfo, recordSend, beginWindow, stopWindow, get persistence() { return persistence } }
}
