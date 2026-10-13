/** 历史导入与本地流水读取。导入只补缺，不恢复旧窗口。 */
import { SENT_MESSAGES_KEEP } from './limits.js'
export const LEGACY_DEFAULT_DIR = ''
const LEGACY_MAX_MESSAGES = 2000
const LEGACY_MAX_SENDS = 500
function normalizeLegacySent(entry) {
  if (entry === null || typeof entry !== 'object' || typeof entry.content !== 'string') return null
  const at = typeof entry.at === 'string' ? entry.at : ''
  const parsed = at === '' ? Number.NaN : Date.parse(at.replace(' ', 'T'))
  return {
    msgId: typeof entry.msgId === 'string' ? entry.msgId : '',
    at,
    atMs: Number.isFinite(Number(entry.atMs)) && Number(entry.atMs) > 0 ? Number(entry.atMs) : (Number.isFinite(parsed) ? parsed : 0),
    content: entry.content,
    opening: entry.opening === true,
  }
}

function normalizeLegacyMessage(row) {
  if (row === null || typeof row !== 'object') return null
  const t = Number(row.t_msg)
  if (!Number.isFinite(t) || t <= 0) return null
  return {
    t_msg: t,
    time: typeof row.time === 'string' ? row.time : '',
    from: typeof row.from === 'string' ? row.from : '',
    name: typeof row.name === 'string' ? row.name : '',
    msgId: typeof row.msgId === 'string' ? row.msgId : (typeof row.msg_id === 'string' ? row.msg_id : ''),
    content: typeof row.content === 'string' ? row.content : '',
  }
}

function copyJsonlIfMissing(input) {
  const { store, from, to, normalize, keep = 0 } = input
  try {
    const existing = store?.readText ? store.readText(to) : { ok: false }
    if (existing?.ok === true && String(existing.value).trim() !== '') return { ok: false, reason: '目标已有文件，未覆盖' }

    const source = store?.readText ? store.readText(from) : { ok: false, error: 'store 不可用' }
    if (source?.ok !== true) return { ok: false, reason: `源文件不可读：${source?.error ?? '未知'}` }

    const rows = []
    for (const line of String(source.value).split(/\r?\n/)) {
      if (line.trim() === '') continue
      try {
        const parsed = normalize(JSON.parse(line))
        if (parsed !== null) rows.push(parsed)
      } catch {
        // 坏行跳过：导入不该因为一行垃圾而整体失败
      }
    }
    if (rows.length === 0) return { ok: false, reason: '源文件里没有可用行' }
    const kept = keep > 0 && rows.length > keep ? rows.slice(-keep) : rows
    const written = store?.writeText ? store.writeText(to, `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`) : { ok: false, error: 'store 不可用' }
    if (written?.ok !== true) return { ok: false, reason: `写入失败：${written?.error ?? '未知'}` }
    return { ok: true, rows: kept.length }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
export function createHistory({ store, ensureConfig, dirFor, stamp, readJsonSafe, logger, record }) {
  async function importLegacy(params = {}) {
    const cfg = ensureConfig()
    const group = typeof cfg?.group === 'string' ? cfg.group : ''
    const directory = dirFor(group)
    if (group === '' || directory === '') return { ok: false, error: '未配置群 ID' }
    const from = typeof params?.from === 'string' && params.from.trim() !== ''
      ? params.from.trim().replace(/[\\/]+$/, '')
      : LEGACY_DEFAULT_DIR
    if (from === '') return { ok: false, error: '请指定历史数据源目录' }

    // skill 的运行时目录下按群分目录（`<run>/<group>/state.json`），也允许用户直接指到群目录。
    const candidates = [`${from}/${group}`, from]
    const sourceDir = candidates.find((candidate) => readJsonSafe(`${candidate}/state.json`) !== undefined)
    if (sourceDir === undefined) {
      return { ok: false, error: `源目录里没有可读的 state.json：${candidates.join(' 或 ')}` }
    }
    const sourceState = readJsonSafe(`${sourceDir}/state.json`)

    const imported = {}
    const skipped = {}

    // 1) state.json：身份 + 发言历史 + 最小间隔（**不导窗口**，见方法注释）。
    if (readJsonSafe(`${directory}/state.json`) !== undefined) {
      skipped.state = '目标已有 state.json，未覆盖'
    } else {
      const sentMessages = (Array.isArray(sourceState.sentMessages) ? sourceState.sentMessages : [])
        .map(normalizeLegacySent)
        .filter((entry) => entry !== null)
        .slice(-SENT_MESSAGES_KEEP)
      const state = {
        group,
        ...(typeof sourceState.groupName === 'string' && sourceState.groupName !== '' ? { groupName: sourceState.groupName } : {}),
        selfUid: typeof sourceState.selfUid === 'string' ? sourceState.selfUid : '',
        minGapSec: Number.isFinite(Number(sourceState.minGapSec)) ? Number(sourceState.minGapSec) : 20,
        sentCount: sentMessages.length > 0 ? sentMessages.length : (Number(sourceState.sentCount) || 0),
        lastSendTimeLocal: typeof sourceState.lastSendTimeLocal === 'string' ? sourceState.lastSendTimeLocal : null,
        lastSendEpochMs: Number.isFinite(Number(sourceState.lastSendEpochMs)) ? Number(sourceState.lastSendEpochMs) : 0,
        sentMessages,
        openingSentAt: null, // 新窗口自己会放开一条开场白
        stopped: true,
        stoppedAt: stamp(),
        stoppedReason: '导入完成，等开窗',
      }
      const written = store?.writeJsonAtomic ? store.writeJsonAtomic(`${directory}/state.json`, state) : { ok: false, error: 'store 不可用' }
      if (written?.ok !== true) return { ok: false, error: `写入 state.json 失败：${written?.error ?? '未知'}` }
      imported.state = { selfUid: state.selfUid, sentMessages: sentMessages.length, window: '未导入（保持未开窗）' }
    }

    // 2) 水位：避免把旧消息重放成"新消息"。
    if (readJsonSafe(`${directory}/poller.json`) !== undefined) {
      skipped.poller = '目标已有 poller.json，未覆盖'
    } else {
      const legacyWatermark = readJsonSafe(`${sourceDir}/poller-state.json`)
      const lastSeenMsgTime = Number(legacyWatermark?.lastSeenMsgTime)
      if (!Number.isFinite(lastSeenMsgTime) || lastSeenMsgTime <= 0) {
        skipped.poller = '源目录没有可用的 poller-state.json'
      } else {
        const written = store?.writeJsonAtomic
          ? store.writeJsonAtomic(`${directory}/poller.json`, {
              lastSeenMsgTime,
              updatedAt: typeof legacyWatermark.updatedAt === 'string' ? legacyWatermark.updatedAt : stamp(),
              selfUid: typeof sourceState.selfUid === 'string' ? sourceState.selfUid : '',
              watchedMsgs: 0,
            })
          : { ok: false, error: 'store 不可用' }
        if (written?.ok !== true) return { ok: false, error: `写入 poller.json 失败：${written?.error ?? '未知'}` }
        imported.poller = { lastSeenMsgTime }
      }
    }

    // 3) 消息流水与发言流水：整份复制（目标缺文件才做），字段名对齐插件内部形状。
    const messages = copyJsonlIfMissing({
      store,
      from: `${sourceDir}/messages.jsonl`,
      to: `${directory}/messages.jsonl`,
      normalize: normalizeLegacyMessage,
      keep: LEGACY_MAX_MESSAGES,
    })
    if (messages.ok === true) imported.messages = { rows: messages.rows }
    else skipped.messages = messages.reason

    const sends = copyJsonlIfMissing({
      store,
      from: `${sourceDir}/sends.jsonl`,
      to: `${directory}/sends.jsonl`,
      normalize: (row) => (row !== null && typeof row === 'object' && typeof row.content === 'string' ? row : null),
      keep: LEGACY_MAX_SENDS,
    })
    if (sends.ok === true) imported.sends = { rows: sends.rows }
    else skipped.sends = sends.reason

    logger?.(`watcher: 导入完成（来自 ${sourceDir}）→ ${Object.keys(imported).join(', ') || '无'}；跳过 ${Object.keys(skipped).join(', ') || '无'}`)
    return { ok: true, group, from: sourceDir, imported, skipped }
  }

  function sends(limit = 20) {
    try {
      const cfg = ensureConfig()
      const directory = dirFor(cfg?.group ?? '')
      if (directory === '' || !store?.readJsonlTail) return { ok: false, rows: [], error: '数据目录不可用' }
      return store.readJsonlTail(`${directory}/sends.jsonl`, Number.isFinite(limit) ? Number(limit) : 20)
    } catch (error) {
      record('sends', error)
      return { ok: false, rows: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  function log(limit = 50) {
    try {
      const cfg = ensureConfig()
      const directory = dirFor(cfg?.group ?? '')
      if (directory === '' || !store?.readJsonlTail) return { ok: false, lines: [], error: '数据目录不可用' }
      const take = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 50
      const rows = []
      const judged = store.readJsonlTail(`${directory}/judge.jsonl`, take)
      for (const row of judged.rows ?? []) {
        rows.push(`${row?.at ?? ''} [判读] ${row?.mode ?? ''} ${row?.action ?? row?.decision ?? ''} ${row?.reason ?? ''} ${row?.detail ?? ''} ${String(row?.reasons ?? row?.blocks ?? '')}`.trim())
      }
      const rounds = store.readJsonlTail(`${directory}/round.jsonl`, take)
      for (const row of rounds.rows ?? []) {
        rows.push(`${row?.now ?? ''} [一轮] verdict=${row?.verdict ?? ''} reason=${row?.reason ?? ''} sendReason=${row?.sendReason ?? ''} source=${row?.decisionSource ?? ''} model=${row?.model ?? ''} finish=${row?.finishReason ?? ''} blockers=${(row?.blockers ?? []).join('+') || '-'} new=${row?.newCount ?? 0} 耗时=${row?.ms ?? '?'}ms`.trim())
      }
      const polls = store.readLineTail ? store.readLineTail(`${directory}/poll.log`, take) : { lines: [] }
      for (const line of polls.lines ?? []) rows.push(line)
      return { ok: true, lines: rows.sort().slice(-take) }
    } catch (error) {
      record('log', error)
      return { ok: false, lines: [], error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { importLegacy, sends, log }
}
