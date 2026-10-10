/** 纯判读策略、阈值与视图合成；无 IO。 */
/**
 * 默认阈值，逐项抄自 `popo-judge.ps1` 的 `$TH`（docs/interfaces.md §6）。
 * 这份是冻结的默认值：调用方要改就自己 spread 一份，别改这里。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  roundFiller: 0.80,
  roundHeated: 0.80,
  roundKindStrong: 0.70,
  roundKindConf: 0.55,
  roundKindGo: 0.50,
  roundKindGoConf: 0.60,
  roundAimedAtUs: 0.60,
  roundAimedHeated: 0.70, // “冲我们来的”压过“房间在冒火”
  roundOpenVeto: 0.70, // 附近有开放的提问就取消 filler 静音
  roundOpenGo: 0.85, // 明显开放的提问本身就是切口
  roundScreen: 0.85, // suspectInstruction advisory
  draftRepeat: 0.85,
  draftSelfClaim: 0.70,
  draftConflict: 0.70,
  draftFiller: 0.70,
  draftLeak: 0.60,
  draftWarn: 0.50,
  draftWarnLeak: 0.40,
})

/** 可以接话的类型（`$GO_KINDS`）。 */
export const GO_KINDS = Object.freeze(['question', 'technical_topic', 'joke_or_tease'])

/** 不该接话的类型（`$STOP_KINDS`）。 */
export const STOP_KINDS = Object.freeze(['venting_or_conflict', 'logistics', 'closed'])

/** `Get-RoundDecision` 里硬编码的 0.60（不是 `$TH` 的一项，照抄）。 */
const FILLER_GO_VETO = 0.60

/** 判读不确定时的引导语（源里的默认 `$guidance`）。 */
const GUIDANCE_UNSURE =
  'Mechanical checks passed and the model is not sure. Judge it yourself: see SKILL.md, then write one line or stay quiet.'

/** quiet 的引导语：源里用 `switch -Regex`，即**子串**匹配且大小写不敏感，顺序即优先级。 */
const QUIET_GUIDANCE = [
  [/venting_or_conflict/i, 'Someone is venting or the chat has friction. Do not send: an outside line lands wrong here.'],
  [/logistics/i, 'Two people are arranging something between themselves. Not ours; do not send.'],
  [/closed/i, 'The thread is closed. Nothing to add; do not send.'],
]

/** quiet 的兜底引导语。 */
const QUIET_GUIDANCE_DEFAULT = 'No opening in the last messages. Do not send; end the round.'

/** opening 的引导语：源里是普通 `switch`，即**相等**匹配且大小写不敏感。 */
const OPEN_GUIDANCE = {
  question: 'Someone asked something answerable. Reply only if you actually have the answer.',
  technical_topic: 'Tech talk is on the table. Speak only if you bring a fact or angle that is not already in the chat.',
  joke_or_tease: 'Someone threw a line to play with. One short line back is enough.',
}

/** opening 的兜底引导语。 */
const OPEN_GUIDANCE_DEFAULT = 'There is an opening. One short, new line, or stay quiet.'

/** “冲我们来的”时的引导语（压过 kind 分派）。 */
const OPEN_GUIDANCE_AIMED = 'This one is aimed at our account. Answer it, briefly.'

/** 大小写不敏感的类型集合（PowerShell 的 `-contains` 就是不敏感比较）。 */
const GO_KIND_SET = new Set(GO_KINDS.map((kind) => kind.toLowerCase()))
const STOP_KIND_SET = new Set(STOP_KINDS.map((kind) => kind.toLowerCase()))

/* -------------------------------------------------------------------------- */
/* 取值助手：全部 never-throw                                                  */
/* -------------------------------------------------------------------------- */

/** 读对象属性；非对象、或取值抛错时给 `undefined`（源里 `$null.prop` 也是静默空）。 */
export function prop(value, key) {
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  try {
    return value[key]
  } catch {
    return undefined
  }
}

/**
 * 大小写不敏感地读属性：PowerShell 的成员查找（`$a.probabilities.($name)`、
 * `$Answers.PSObject.Properties[$Key]`）以及 hashtable 的键查找都不区分大小写，
 * 所以 `kind='Closed'` 能命中 `probabilities.closed`。先精确命中，再忽略大小写找唯一一个。
 */
function propCI(value, key) {
  const exact = prop(value, key)
  if (exact !== undefined) return exact
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  const target = String(key).toLowerCase()
  try {
    for (const name of Object.keys(value)) {
      if (name.toLowerCase() === target) return value[name]
    }
  } catch {
    // 取键失败就当没有
  }
  return undefined
}

/** 转有限数字；数字字符串也接受，其余回落 `fallback`。 */
function toNumber(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return fallback
}

/**
 * 取某个 `noul` 问题的概率，语义对齐源的 `Get-NoulValue`：
 * 答案集不是对象、或没有这个 key → `-1.0`（一定低于任何阈值）；
 * key 在但 `noul` 是空值 → `0.0`（源里 `[double]$null` 就是 0）；
 * `noul` 转不成数字 → `-1.0`（源里 catch 后返回 `-1.0`）。
 */
function noulOf(answers, key) {
  const answer = propCI(answers, key)
  if (answer === undefined) return -1.0
  // `formatAnswers` 压过之后这里就是个裸数字（源脚本只喂原始 answers，所以这是刻意的宽容）
  if (typeof answer === 'number') return Number.isFinite(answer) ? answer : -1.0
  const raw = prop(answer, 'noul')
  if (raw === null || raw === undefined) return 0.0
  return toNumber(raw, -1.0)
}

/**
 * 取 `kind` 这个 choice 答案：类型名、该类型的概率、置信度。
 * 概率优先读 `probabilities[choice]`（源的做法），缺失时回落到 `p`（`formatAnswers` 的形状）。
 */
function readKind(answers) {
  const raw = propCI(answers, 'kind')
  if (!raw) return { name: '', p: 0, c: 0, present: false }
  const chosen = prop(raw, 'choice')
  const name = chosen === undefined || chosen === null ? '' : String(chosen)
  let p = toNumber(propCI(prop(raw, 'probabilities'), name), NaN)
  if (!Number.isFinite(p)) p = toNumber(prop(raw, 'p'), NaN)
  if (!Number.isFinite(p)) p = 0.0
  return { name, p, c: toNumber(prop(raw, 'confidence'), 0.0), present: true }
}

/** 该类型是否在不该接话的名单里（大小写不敏感）。 */
function isStopKind(kindName) {
  return STOP_KIND_SET.has(String(kindName).toLowerCase())
}

/** 该类型是否在可以接话的名单里（大小写不敏感）。 */
function isGoKind(kindName) {
  return GO_KIND_SET.has(String(kindName).toLowerCase())
}

/**
 * 四舍五入到 `digits` 位，**平局取偶**：对齐 .NET `[Math]::Round(double, int)` 的默认行为
 * （banker's rounding），这样阈值附近的文案与源脚本一致。
 */
function roundHalfEven(value, digits) {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  const scaled = value * factor
  const lower = Math.floor(scaled)
  const diff = scaled - lower
  if (diff > 0.5) return (lower + 1) / factor
  if (diff < 0.5) return lower / factor
  return (lower % 2 === 0 ? lower : lower + 1) / factor
}

/**
 * 把数字渲染进 reason 文案：先按源那样 `Round(x, n)`，再用最短十进制表示。
 * 所以 `0.8` 打出来就是 `0.8`（PowerShell 拼字符串也不会补成 `0.80`）。
 */
function fmtNumber(value, digits) {
  return String(roundHalfEven(value, digits))
}

/** 合并并净化调用方给的阈值：未知项忽略，非法值回落默认（永不因为阈值炸掉）。 */
function normalizeThresholds(thresholds) {
  const source = thresholds !== null && typeof thresholds === 'object' ? thresholds : {}
  const merged = {}
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    merged[key] = toNumber(prop(source, key), DEFAULT_THRESHOLDS[key])
  }
  return merged
}

/* -------------------------------------------------------------------------- */
/* formatAnswers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 把一个答案映射压成紧凑、统一的视图（源 `Format-Answer`）：
 * `noul` → 3 位小数的数字；`choice` → `{choice, p, confidence}` 各 3 位小数；其它类型丢弃。
 * 类型名大小写不敏感（PowerShell 的 `switch` 就是不敏感比较）。
 *
 * @param raw - TypeSafe 返回的 `answers`（任意坏输入都不抛）。
 * @returns 只含 `noul` / `choice` 两类答案的新对象。
 */
export function formatAnswers(raw) {
  const out = {}
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object') return out
    for (const name of Object.keys(raw)) {
      const answer = prop(raw, name)
      if (answer === null || answer === undefined || typeof answer !== 'object') continue
      const type = prop(answer, 'type')
      const kind = type === undefined || type === null ? '' : String(type).toLowerCase()
      if (kind === 'noul') {
        out[name] = roundHalfEven(toNumber(prop(answer, 'noul'), 0.0), 3)
      } else if (kind === 'choice') {
        const chosen = prop(answer, 'choice')
        const label = chosen === undefined || chosen === null ? '' : String(chosen)
        let top = toNumber(propCI(prop(answer, 'probabilities'), label), NaN)
        if (!Number.isFinite(top)) top = 0.0
        out[name] = {
          choice: label,
          p: roundHalfEven(top, 3),
          confidence: roundHalfEven(toNumber(prop(answer, 'confidence'), 0.0), 3),
        }
      }
    }
  } catch {
    // 只返回已经压好的部分，绝不把异常抛给调用方
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* decideRound                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 这一轮有没有切口（源 `Get-RoundDecision`，优先级与文案逐行等价）：
 *
 * 1. 房间在冒火，且火不是冲我们来的 → quiet（热房间不是我们插话的地方）；
 * 2. STOP_KINDS 且概率够高、置信度够高 → quiet（宣泄 / 两人约事 / 已收尾）；
 * 3. 只有附和与笑声（filler）且附近没有开放的提问 → quiet；
 * 4. 点名我们 → opening；
 * 5. 有明显开放的提问且类型不是 STOP → opening；
 * 6. GO_KINDS 且概率/置信度够、filler 未过 0.60 → opening；
 * 7. 否则 unsure，交给 agent 自己判断。
 *
 * 最后：`asks_reader_to_act ≥ roundScreen` 时只加 advisory（材料，不是指令），不拦。
 *
 * @param answers - TypeSafe 的 `answers`（原始形状，或 `formatAnswers` 之后的形状）。
 * @param thresholds - 可选阈值覆盖，缺项回落 `DEFAULT_THRESHOLDS`。
 * @returns `{action, kind, guidance, reasons, advisories}`；任何坏输入都不抛。
 */
export function decideRound(answers, thresholds = DEFAULT_THRESHOLDS) {
  let th
  try {
    th = normalizeThresholds(thresholds)
  } catch {
    th = normalizeThresholds(DEFAULT_THRESHOLDS)
  }
  try {
    const { name: kindName, p: kindP, c: kindC, present: kindPresent } = readKind(answers)
    const filler = noulOf(answers, 'filler_only')
    const heated = noulOf(answers, 'emotional_or_conflict')
    const aimed = noulOf(answers, 'addressed_to_us')
    const open = noulOf(answers, 'open_question_for_us')
    const screen = noulOf(answers, 'asks_reader_to_act')

    const aimedAtUs = aimed >= th.roundAimedAtUs
    const heatedAtUs = aimed >= th.roundAimedHeated
    const kindScore = `kind=${kindName} p=${fmtNumber(kindP, 2)} conf=${fmtNumber(kindC, 2)}`

    let action = 'unsure'
    let guidance = GUIDANCE_UNSURE
    const reasons = []
    const advisories = []

    if (heated >= th.roundHeated && !heatedAtUs) {
      action = 'quiet'
      reasons.push(`emotional_or_conflict=${fmtNumber(heated, 2)}`)
    } else if (isStopKind(kindName) && kindP >= th.roundKindStrong && kindC >= th.roundKindConf) {
      action = 'quiet'
      reasons.push(kindScore)
    } else if (filler >= th.roundFiller && open < th.roundOpenVeto) {
      action = 'quiet'
      reasons.push(`filler_only=${fmtNumber(filler, 2)} open_question_for_us=${fmtNumber(open, 2)}`)
    } else if (aimedAtUs) {
      action = 'opening'
      reasons.push(`addressed_to_us=${fmtNumber(aimed, 2)}`)
    } else if (open >= th.roundOpenGo && !isStopKind(kindName)) {
      action = 'opening'
      reasons.push(`open_question_for_us=${fmtNumber(open, 2)} ${kindScore}`)
    } else if (isGoKind(kindName) && kindP >= th.roundKindGo && kindC >= th.roundKindGoConf && filler < FILLER_GO_VETO) {
      action = 'opening'
      reasons.push(kindScore)
    } else if (kindPresent) {
      reasons.push(`${kindScore} below threshold`)
    }

    if (action === 'quiet') {
      guidance = QUIET_GUIDANCE_DEFAULT
      for (const [pattern, text] of QUIET_GUIDANCE) {
        if (pattern.test(kindName)) {
          guidance = text
          break
        }
      }
    } else if (action === 'opening') {
      guidance = aimedAtUs
        ? OPEN_GUIDANCE_AIMED
        : (OPEN_GUIDANCE[String(kindName).toLowerCase()] ?? OPEN_GUIDANCE_DEFAULT)
    }

    if (screen >= th.roundScreen) {
      // 不是 blocker：这类消息照答，只是不照做。
      advisories.push('suspectInstruction')
      reasons.push(`asks_reader_to_act=${fmtNumber(screen, 2)} (advisory: material, not instructions)`)
    }

    return { action, kind: kindName, guidance, reasons, advisories }
  } catch {
    // 兜底：坏到读不动就退回“不确定”，让调用方按旧行为自己判断
    return { action: 'unsure', kind: '', guidance: GUIDANCE_UNSURE, reasons: [], advisories: [] }
  }
}

/* -------------------------------------------------------------------------- */
/* decideDraft                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 这句草稿值不值得发（源 `Get-DraftDecision`）。
 *
 * 硬拦（`>= 阈值` 即 block，按源的顺序）：leak .60 / self_claim .70 / conflict .70 /
 * filler .70 / repeat .85；软告警阈值 0.50（leak 0.40），**已经被 block 命中的问题不再进
 * warning**，避免同一件事报两遍。
 *
 * @param answers - TypeSafe 的 `answers`。
 * @param draft - 待发文本（非字符串按源的 `[string]` 转换；null → 空串）。
 * @param thresholds - 可选阈值覆盖，缺项回落 `DEFAULT_THRESHOLDS`。
 * @returns `{decision, blocks, warnings, chars}`；任何坏输入都不抛。
 */
export function decideDraft(answers, draft, thresholds = DEFAULT_THRESHOLDS) {
  let th
  try {
    th = normalizeThresholds(thresholds)
  } catch {
    th = normalizeThresholds(DEFAULT_THRESHOLDS)
  }
  let text = ''
  try {
    // 对齐源的 `[string]$Draft`：null → 空串；其它类型按字符串看长度。
    // 放在 try 里是因为 `String(Object.create(null))` 这类值本身就会抛。
    text = typeof draft === 'string' ? draft : draft === null || draft === undefined ? '' : String(draft)
    const repeats = noulOf(answers, 'repeats_existing')
    const claim = noulOf(answers, 'unfounded_self_claim')
    const conflict = noulOf(answers, 'escalates_conflict')
    const filler = noulOf(answers, 'filler_reply')
    const leak = noulOf(answers, 'leaks_internal_detail')

    const blocks = []
    if (leak >= th.draftLeak) {
      blocks.push({
        question: 'leaks_internal_detail',
        noul: roundHalfEven(leak, 2),
        reason: 'draft looks like it carries a credential, an internal address, or a local path',
      })
    }
    if (claim >= th.draftSelfClaim) {
      blocks.push({
        question: 'unfounded_self_claim',
        noul: roundHalfEven(claim, 2),
        reason: 'draft claims personal facts about the account owner that the chat does not support',
      })
    }
    if (conflict >= th.draftConflict) {
      blocks.push({
        question: 'escalates_conflict',
        noul: roundHalfEven(conflict, 2),
        reason: 'draft would make the friction worse',
      })
    }
    if (filler >= th.draftFiller) {
      blocks.push({
        question: 'filler_reply',
        noul: roundHalfEven(filler, 2),
        reason: 'draft is only laughter or agreement, with nothing in it',
      })
    }
    if (repeats >= th.draftRepeat) {
      blocks.push({
        question: 'repeats_existing',
        noul: roundHalfEven(repeats, 2),
        reason: 'draft repeats what is already on the table',
      })
    }

    const warnPairs = [
      ['leaks_internal_detail', leak, th.draftWarnLeak],
      ['unfounded_self_claim', claim, th.draftWarn],
      ['escalates_conflict', conflict, th.draftWarn],
      ['filler_reply', filler, th.draftWarn],
      ['repeats_existing', repeats, th.draftWarn],
    ]
    const blocked = new Set(blocks.map((item) => item.question))
    const warnings = []
    for (const [question, value, threshold] of warnPairs) {
      if (!blocked.has(question) && value >= threshold) {
        warnings.push({ question, noul: roundHalfEven(value, 2) })
      }
    }

    return {
      decision: blocks.length > 0 ? 'block' : 'pass',
      blocks,
      warnings,
      chars: text.length,
    }
  } catch {
    return { decision: 'pass', blocks: [], warnings: [], chars: text.length }
  }
}

/* -------------------------------------------------------------------------- */
/* composeRoundView                                                           */
/* -------------------------------------------------------------------------- */

/** 把值规整成数组（非数组给空数组，绝不因坏形状炸掉）。 */
function toArray(value) {
  return Array.isArray(value) ? value.slice() : []
}

/**
 * 判读结论是否可用：对齐源的 `if (-not $Judge -or (-not $Judge.ok))`。
 * 额外宽容：手工构造、没有 `ok` 字段但带 `action` 的判读也按可用处理（`runRound` 的结果总是带 `ok`）。
 */
function isJudgeAvailable(judgement) {
  if (!judgement || typeof judgement !== 'object') return false
  const ok = prop(judgement, 'ok')
  if (ok === true) return true
  if (ok === undefined || ok === null) {
    const action = prop(judgement, 'action')
    return action === 'opening' || action === 'quiet' || action === 'unsure'
  }
  return false
}

/** 取判读的引导语（缺省给空串，对齐源的 `[string]$Judge.guidance`）。 */
function guidanceOf(judgement) {
  const value = prop(judgement, 'guidance')
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 把机械视图（`verdict` / `blockers` / `advisories` / `nextStep`）与判读结论合成一张视图
 * （源 `Add-JudgeToView`）。
 *
 * 只做加法，**永不删除**已有 blocker：
 * - 判读不可用（null / `ok:false`）→ advisories 加 `judgeUnavailable`（另有 error 时附 `judgeError`），
 *   verdict / blockers / nextStep 一律不动，退回“agent 自己判断”的旧行为；
 * - `action='opening'` → verdict 置 `speak`，nextStep 用 guidance；
 * - `action='quiet'` → verdict 置 `blocked`，blockers 追加 `noOpening`，nextStep 用 guidance；
 * - 其它（含 `unsure`）→ advisories 加 `judgeUnsure`，verdict 不动，nextStep 用 guidance。
 * - 判读自带的 advisories（如 `suspectInstruction`）一并并入。
 *
 * 两点与源脚本的差别（都是刻意的）：
 * 1. **不改入参**：源的 `Add-JudgeToView` 就地改哈希表，这里返回新对象，避免调用方共享状态被改；
 * 2. 机械层已经判 `blocked` 时，`opening` 不再把 verdict 翻成 `speak`
 *    （源脚本靠调用点 `$view.verdict -eq 'judge'` 保证不会遇到这种组合，
 *    docs/interfaces.md §5「绝不放开机械 blocker」在这里也兜一层）。
 *
 * @param view - 机械视图；缺字段按空处理。
 * @param judgement - `runRound` 的结果（或 null）。
 * @returns 合成后的新视图。
 */
export function composeRoundView(view, judgement) {
  try {
    return composeView(view, judgement)
  } catch {
    return { verdict: 'blocked', blockers: ['invalidInput'], advisories: [], nextStep: 'Do not send; invalid judgement input.' }
  }
}

function composeView(view, judgement) {
  const base = view !== null && typeof view === 'object' ? view : {}
  const out = { ...base }
  const blockers = toArray(prop(base, 'blockers'))
  const advisories = toArray(prop(base, 'advisories'))

  if (!isJudgeAvailable(judgement)) {
    advisories.push('judgeUnavailable')
    out.advisories = advisories
    const error = prop(judgement, 'error')
    if (error) out.judgeError = String(error)
    return out
  }

  for (const advisory of toArray(prop(judgement, 'advisories'))) {
    advisories.push(String(advisory))
  }

  const action = String(prop(judgement, 'action') ?? '').toLowerCase()
  if (action === 'opening') {
    if (String(prop(base, 'verdict') ?? '') !== 'blocked') out.verdict = 'speak'
    out.nextStep = guidanceOf(judgement)
  } else if (action === 'quiet') {
    out.verdict = 'blocked'
    blockers.push('noOpening')
    out.nextStep = guidanceOf(judgement)
  } else {
    advisories.push('judgeUnsure')
    out.nextStep = guidanceOf(judgement)
  }

  out.blockers = blockers
  out.advisories = advisories
  return out
}

/** 别名：docs/interfaces.md §5 把本函数写作 `composeRound`。 */
export const composeRound = composeRoundView

/* -------------------------------------------------------------------------- */
/* loadQuestions                                                              */
/* -------------------------------------------------------------------------- */
