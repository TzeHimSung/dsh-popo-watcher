/**
 * 守卫层：所有**能机械判定**的"该不该开口/这条能不能发"都收在这里（纯函数，无 IO）。
 *
 * 对应 skill 的两处：
 * - `popo-watch.ps1` 的 `Get-RoundView`（blocker = 不发；advisory = 提醒但不拦）；
 * - `popo-send.ps1` 的机械守卫（空 / @所有人 / 字数 / 死线 / 静音 / 最小间隔 / 不接自己的话 / 开场白豁免）。
 *
 * 语义判读（TypeSafe）与文案生成不在这里：它们由 `lib/judge.js` 与 `lib/llm.js` 负责，
 * 而且**只能加拒绝**，不能放开这里的任何一道机械守卫。
 *
 * @module dsh-popo-watcher/guards
 */

/** 纯图片/表情判定：整条消息就是一张图（含可选的无配文 token）。 */
export function isImageOnly(content) {
  if (typeof content !== 'string') return false
  const trimmed = content.trim()
  if (!/^\[https?:\/\//.test(trimmed)) return false
  const rest = trimmed.replace(/^\[https?:\/\/[^\]]*\]/, '').trim()
  return rest.length === 0
}

/**
 * 一轮的机械视图（blocker / advisory），等价于源实现的 `Get-RoundView`。
 * @param input - `{ messages, newCount, selfUid }`。
 * @returns `{ verdict, blockers, advisories, nextStep, lastFromSelf, lastAgeSec, lastImageOnly }`。
 */
export function roundView(input = {}) {
  try {
    return describeRound(input)
  } catch {
    return { verdict: 'blocked', blockers: ['invalidInput'], advisories: [], nextStep: 'Do not send; invalid round input.', lastFromSelf: false, lastAgeSec: -1, lastImageOnly: false }
  }
}

function describeRound(input) {
  const { messages = [], newCount = 0, selfUid = '', nowMs = Date.now() } = input
  const list = Array.isArray(messages) ? messages.filter(Boolean) : []
  const blockers = []
  const advisories = []

  let lastFromSelf = false
  let lastAgeSec = -1
  let lastImageOnly = false
  if (list.length > 0) {
    const last = list[list.length - 1]
    lastFromSelf = selfUid !== '' && last?.from === selfUid
    const stamp = typeof last?.t_msg === 'number' && last.t_msg > 0 ? last.t_msg : 0
    lastAgeSec = stamp > 0 ? Math.max(0, Math.trunc((nowMs - stamp) / 1000)) : -1
    lastImageOnly = isImageOnly(last?.content)
  }

  if (newCount <= 0) blockers.push('noNewMessages')
  if (lastFromSelf) blockers.push('lastFromSelf')
  if (lastImageOnly) blockers.push('lastMessageHasNoText')
  // 没有自己的 uid 时 lastFromSelf 根本没法判——说出来，而不是让它静默通过。
  if (selfUid === '') advisories.push('selfIdentityUnknown')

  const blocked = blockers.length > 0
  return {
    verdict: blocked ? 'blocked' : 'judge',
    blockers,
    advisories,
    nextStep: blocked
      ? 'Do not send. Record the blocker in the round log and end the round.'
      : 'Mechanical checks passed; a TypeSafe judgment normally follows. If judgeUnavailable appears, stay quiet unless configured otherwise.',
    lastFromSelf,
    lastAgeSec,
    lastImageOnly,
  }
}

/** `HH:MM` → 当天的分钟数（非法返回 null）。 */
function minutesOfClock(value) {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''))
  if (matched === null) return null
  return Number(matched[1]) * 60 + Number(matched[2])
}

/**
 * 是否处于安静时段（支持跨零点，例如 23:00–09:00）。
 * @param quietHours - `{ enabled, start, end }`。
 * @param date - 判定时刻（默认现在）。
 * @returns 布尔。
 */
export function quietHoursActive(quietHours, date = new Date()) {
  try {
    if (quietHours?.enabled !== true) return false
    const start = minutesOfClock(quietHours.start)
    const end = minutesOfClock(quietHours.end)
    if (start === null || end === null) return false
    const current = date.getHours() * 60 + date.getMinutes()
    if (start === end) return false
    return start < end ? current >= start && current < end : current >= start || current < end
  } catch {
    return false
  }
}

/** 发言记录的时刻（毫秒）：优先 `atMs`，退回本地时间字符串。 */
function sentAtMs(entry) {
  if (typeof entry?.atMs === 'number' && entry.atMs > 0) return entry.atMs
  if (typeof entry?.at === 'string') {
    const parsed = Date.parse(entry.at.replace(' ', 'T'))
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

/**
 * 滚动一小时内的发言条数（用于每小时上限）。
 * @param entries - state.sentMessages。
 * @param nowMs - 当前毫秒。
 * @returns 条数。
 */
export function sendsWithinLastHour(entries, nowMs = Date.now()) {
  try {
    if (!Array.isArray(entries)) return 0
    const floor = nowMs - 3600 * 1000
    return entries.filter((entry) => {
      const at = sentAtMs(entry)
      return at !== null && at >= floor
    }).length
  } catch {
    return 0
  }
}

/** Automatic scheduling and the final send guard use the same cooldown boundary. */
export function sendCooldownUntil(state = {}, config = {}) {
  const gapSec = Number(state?.minGapSec) > 0 ? Number(state.minGapSec) : Number(config?.minGapSec) > 0 ? Number(config.minGapSec) : 20
  const lastMs = typeof state?.lastSendEpochMs === 'number' ? state.lastSendEpochMs : 0
  return Number.isFinite(lastMs) && lastMs > 0 ? lastMs + gapSec * 1000 : 0
}

/**
 * 自动发送前的机械守卫（纯函数；手动发送由 `lib/send.js` 直接交给传输层）。
 * @param input - `{ text, config, state, lastMessage, selfUid, sentMessages, nowMs, opening, replyTargets? }`。
 * @returns `{ ok, reason?, detail?, warnings }`；`ok:false` 时 `reason` 是稳定的英文机器码。
 */
export function sendGuards(input = {}) {
  try {
    return checkSend(input)
  } catch {
    return { ok: false, reason: 'invalid input', warnings: [] }
  }
}

function checkSend(input) {
  const {
    text = '',
    config = {},
    state = {},
    lastMessage = null,
    selfUid = '',
    sentMessages = [],
    nowMs = Date.now(),
    opening = false,
    replyTargets = null,
  } = input
  const warnings = []

  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') return { ok: false, reason: 'empty message', warnings }
  if (!opening && config.replyOnlyWhenMentioned === true && (!Array.isArray(replyTargets) || replyTargets.length === 0)) {
    return { ok: false, reason: 'not mentioned', detail: '本次自动回复没有已确认的 @ 我新消息目标', warnings }
  }

  // @所有人的字样用码点拼，避免源码里出现会被误判的字面量。
  const atAllMarker = `@${String.fromCharCode(0x6240, 0x6709, 0x4eba)}`
  if (body.includes(atAllMarker)) return { ok: false, reason: 'at-all rejected', detail: 'never @ everybody unprompted', warnings }

  const maxChars = Number(config.maxChars) > 0 ? Number(config.maxChars) : 50
  const hardMaxChars = Number(config.hardMaxChars) > 0 ? Number(config.hardMaxChars) : 120
  if (body.length > hardMaxChars) {
    return { ok: false, reason: 'message too long', detail: `${body.length} 字超过硬上限 ${hardMaxChars}`, warnings }
  }
  if (body.length > maxChars) warnings.push(`message is ${body.length} chars, over the ${maxChars}-char soft limit`)

  if (state?.stopped === true) return { ok: false, reason: 'stopped flag set', detail: 'this window was stopped; a fresh start clears it', warnings }

  const endsAtMs = typeof state?.endsAt === 'string' ? Date.parse(state.endsAt.replace(' ', 'T')) : Number.NaN
  if (!Number.isNaN(endsAtMs) && nowMs > endsAtMs) return { ok: false, reason: 'past deadline', detail: String(state.endsAt), warnings }

  const retryAtMs = sendCooldownUntil(state, config)
  const lastMs = typeof state?.lastSendEpochMs === 'number' ? state.lastSendEpochMs : 0
  if (retryAtMs > nowMs) {
    const gapSec = (retryAtMs - lastMs) / 1000
    const elapsed = (nowMs - lastMs) / 1000
    return { ok: false, reason: 'too soon', detail: `last send ${elapsed.toFixed(1)}s ago, need ${gapSec}s`, retryAtMs, warnings }
  }

  if (quietHoursActive(config?.quietHours, new Date(nowMs))) {
    return { ok: false, reason: 'quiet hours', detail: `${config?.quietHours?.start ?? '?'}-${config?.quietHours?.end ?? '?'}`, warnings }
  }

  if (config?.hourlyCap?.enabled === true) {
    const cap = Number(config.hourlyCap.max) > 0 ? Number(config.hourlyCap.max) : 6
    const used = sendsWithinLastHour(sentMessages, nowMs)
    if (used >= cap) return { ok: false, reason: 'hourly cap reached', detail: `${used}/${cap} in the last hour`, warnings }
  }

  if (opening) {
    // 开场白是宣告不是接话：只豁免"最后一条是自己发的"和草稿判读，其余守卫照旧。
    const openedAt = typeof state?.openingSentAt === 'string' ? Date.parse(state.openingSentAt.replace(' ', 'T')) : Number.NaN
    const startedAt = typeof state?.startedAt === 'string' ? Date.parse(state.startedAt.replace(' ', 'T')) : Number.NaN
    if (!Number.isNaN(openedAt) && (Number.isNaN(startedAt) || openedAt >= startedAt)) {
      return { ok: false, reason: 'opening already sent', detail: `opening went out at ${state.openingSentAt}`, warnings }
    }
    return { ok: true, warnings }
  }

  // 不接自己的话：读不到最后发言人时**宁可拒发**（安静不算失败）。
  if (lastMessage === null || typeof lastMessage !== 'object') {
    return { ok: false, reason: 'cannot verify last speaker', detail: 'the newest message could not be established', warnings }
  }
  if (selfUid !== '' && lastMessage.from === selfUid) {
    return { ok: false, reason: 'self spoke last', detail: 'wait for someone else to speak', warnings }
  }

  return { ok: true, warnings }
}
