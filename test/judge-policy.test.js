/**
 * 判读层策略测试：不联网、不碰真实数据目录，答案全部内联构造。
 *
 * 覆盖 docs/interfaces.md §5/§6 与移植源 `popo-judge.ps1` 的每一条分支：
 * 热房间 / 热+点名 / STOP_KINDS / filler 的 open 否决 / aimed、open、GO_KIND 触发 opening /
 * 全不命中 unsure / suspectInstruction advisory；draft 的 5 个 block、5 个 warning 与去重；
 * `composeRoundView` 的三个分支与「永不删除机械 blocker」；`loadQuestions` 的正常与失败路径。
 *
 * 跑法：`node --test test/judge-policy.test.js`
 *
 * @module dsh-popo-watcher/test/judge-policy
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_THRESHOLDS,
  GO_KINDS,
  STOP_KINDS,
  composeRound,
  composeRoundView,
  decideDraft,
  decideRound,
  formatAnswers,
  loadQuestions,
} from '../lib/judge.js'

/** 造一个 `noul` 答案（源脚本里 `asks_reader_to_act` 这类概率）。 */
const noul = (value) => ({ type: 'noul', noul: value })

/** 造一个 `choice` 答案（源脚本里 `kind` 这种带概率表 + 置信度的选择题）。 */
const pick = (name, probabilities, confidence) => ({ type: 'choice', choice: name, probabilities, confidence })

/** 判读不确定时的引导语（源里的默认 `$guidance`）。 */
const GUIDANCE_UNSURE =
  'Mechanical checks passed and the model is not sure. Judge it yourself: see SKILL.md, then write one line or stay quiet.'

/** 机械层过关、还没判读时的视图（源 `Get-RoundView` 的形状）。 */
const mechanicalView = () => ({
  verdict: 'judge',
  blockers: [],
  advisories: ['selfIdentityUnknown'],
  nextStep: 'Mechanical checks passed; a TypeSafe judgment normally follows. If judgeUnavailable appears, decide it yourself with SKILL.md.',
  lastFromSelf: false,
  lastAgeSec: 12,
})

/* ========================================================================== */
/* 常量契约                                                                    */
/* ========================================================================== */

test('阈值与类型名单是冻结的默认值，逐项等于 popo-judge.ps1 的 $TH', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    roundFiller: 0.8,
    roundHeated: 0.8,
    roundKindStrong: 0.7,
    roundKindConf: 0.55,
    roundKindGo: 0.5,
    roundKindGoConf: 0.6,
    roundAimedAtUs: 0.6,
    roundAimedHeated: 0.7,
    roundOpenVeto: 0.7,
    roundOpenGo: 0.85,
    roundScreen: 0.85,
    draftRepeat: 0.85,
    draftSelfClaim: 0.7,
    draftConflict: 0.7,
    draftFiller: 0.7,
    draftLeak: 0.6,
    draftWarn: 0.5,
    draftWarnLeak: 0.4,
  })
  // 冻结：调用方要改就自己 spread 一份，避免全局默认被就地改掉。
  assert.equal(Object.isFrozen(DEFAULT_THRESHOLDS), true)
  assert.deepEqual([...GO_KINDS], ['question', 'technical_topic', 'joke_or_tease'])
  assert.deepEqual([...STOP_KINDS], ['venting_or_conflict', 'logistics', 'closed'])
})

test('导出契约：8 个具名导出齐备（含 interfaces.md §5 的 composeRound 别名）', () => {
  assert.equal(typeof decideRound, 'function')
  assert.equal(typeof decideDraft, 'function')
  assert.equal(typeof formatAnswers, 'function')
  assert.equal(typeof composeRoundView, 'function')
  assert.equal(typeof loadQuestions, 'function')
  assert.equal(composeRound, composeRoundView)
  assert.ok(Array.isArray(GO_KINDS) && Array.isArray(STOP_KINDS))
  assert.equal(typeof DEFAULT_THRESHOLDS, 'object')
})

/* ========================================================================== */
/* decideRound                                                                 */
/* ========================================================================== */

test('decideRound：热房间（火不是冲我们来的）→ quiet', () => {
  const result = decideRound({ emotional_or_conflict: noul(0.82) })
  assert.deepEqual(result, {
    action: 'quiet',
    kind: '',
    guidance: 'No opening in the last messages. Do not send; end the round.',
    reasons: ['emotional_or_conflict=0.82'],
    advisories: [],
  })
})

test('decideRound：热但点名了我们 → opening（点名压过静音）', () => {
  const aimed = decideRound({ emotional_or_conflict: noul(0.9), addressed_to_us: noul(0.72) })
  assert.equal(aimed.action, 'opening')
  assert.deepEqual(aimed.reasons, ['addressed_to_us=0.72'])
  assert.equal(aimed.guidance, 'This one is aimed at our account. Answer it, briefly.')

  // 0.65 够“喊到我们”（≥0.60）但不够“火冲我们来的”（<0.70）→ 仍然是热房间，静音。
  const heated = decideRound({ emotional_or_conflict: noul(0.9), addressed_to_us: noul(0.65) })
  assert.equal(heated.action, 'quiet')
  assert.deepEqual(heated.reasons, ['emotional_or_conflict=0.9'])
})

test('decideRound：STOP_KINDS 概率+置信度双达标 → quiet，各带自己的引导语', () => {
  const venting = decideRound({ kind: pick('venting_or_conflict', { venting_or_conflict: 0.82, question: 0.1 }, 0.7) })
  assert.deepEqual(venting, {
    action: 'quiet',
    kind: 'venting_or_conflict',
    guidance: 'Someone is venting or the chat has friction. Do not send: an outside line lands wrong here.',
    reasons: ['kind=venting_or_conflict p=0.82 conf=0.7'],
    advisories: [],
  })

  const logistics = decideRound({ kind: pick('logistics', { logistics: 0.75 }, 0.8) })
  assert.equal(logistics.action, 'quiet')
  assert.equal(logistics.guidance, 'Two people are arranging something between themselves. Not ours; do not send.')

  const closed = decideRound({ kind: pick('closed', { closed: 0.71 }, 0.56) })
  assert.equal(closed.action, 'quiet')
  assert.equal(closed.guidance, 'The thread is closed. Nothing to add; do not send.')

  // 类型名比较大小写不敏感（PowerShell 的 -contains / switch），返回值保留原样。
  const mixed = decideRound({ kind: pick('Closed', { Closed: 0.8 }, 0.9) })
  assert.equal(mixed.action, 'quiet')
  assert.equal(mixed.kind, 'Closed')
  assert.equal(mixed.guidance, 'The thread is closed. Nothing to add; do not send.')
  assert.deepEqual(mixed.reasons, ['kind=Closed p=0.8 conf=0.9'])
})

test('decideRound：STOP_KIND 但概率或置信度不够 → 落到 unsure', () => {
  const lowConf = decideRound({ kind: pick('venting_or_conflict', { venting_or_conflict: 0.82 }, 0.5) })
  assert.equal(lowConf.action, 'unsure')
  assert.deepEqual(lowConf.reasons, ['kind=venting_or_conflict p=0.82 conf=0.5 below threshold'])

  const lowP = decideRound({ kind: pick('closed', { closed: 0.69 }, 0.9) })
  assert.equal(lowP.action, 'unsure')
  assert.deepEqual(lowP.reasons, ['kind=closed p=0.69 conf=0.9 below threshold'])
  assert.equal(lowP.guidance, GUIDANCE_UNSURE)
})

test('decideRound：filler 静音，但附近的开放提问可以否决它', () => {
  const quiet = decideRound({ filler_only: noul(0.9), open_question_for_us: noul(0.5) })
  assert.equal(quiet.action, 'quiet')
  assert.deepEqual(quiet.reasons, ['filler_only=0.9 open_question_for_us=0.5'])

  // open 恰好 0.70 = roundOpenVeto：`open < .70` 不成立 → 否决 filler 静音。
  const vetoed = decideRound({ filler_only: noul(0.9), open_question_for_us: noul(0.7) })
  assert.equal(vetoed.action, 'unsure')
  assert.deepEqual(vetoed.reasons, [])
  assert.equal(vetoed.guidance, GUIDANCE_UNSURE)

  // open 0.69 还不够否决。
  const stillQuiet = decideRound({ filler_only: noul(0.8), open_question_for_us: noul(0.69) })
  assert.equal(stillQuiet.action, 'quiet')
})

test('decideRound：点名我们（0.60 线）→ opening', () => {
  const hit = decideRound({ addressed_to_us: noul(0.61) })
  assert.deepEqual(hit.reasons, ['addressed_to_us=0.61'])
  assert.equal(hit.action, 'opening')
  assert.equal(hit.guidance, 'This one is aimed at our account. Answer it, briefly.')

  const below = decideRound({ addressed_to_us: noul(0.59) })
  assert.equal(below.action, 'unsure')
  assert.deepEqual(below.reasons, [])
})

test('decideRound：明显开放的提问（0.85 线）→ opening，STOP_KIND 除外', () => {
  const open = decideRound({ open_question_for_us: noul(0.9), kind: pick('question', { question: 0.4 }, 0.3) })
  assert.equal(open.action, 'opening')
  assert.deepEqual(open.reasons, ['open_question_for_us=0.9 kind=question p=0.4 conf=0.3'])
  assert.equal(open.guidance, 'Someone asked something answerable. Reply only if you actually have the answer.')

  // open 很高但类型是 STOP_KIND → 这一条不成立，继续往下走，最终 unsure。
  const stop = decideRound({ open_question_for_us: noul(0.9), kind: pick('closed', { closed: 0.3 }, 0.9) })
  assert.equal(stop.action, 'unsure')
  assert.deepEqual(stop.reasons, ['kind=closed p=0.3 conf=0.9 below threshold'])
})

test('decideRound：GO_KIND 概率≥0.50 且置信度≥0.60 且 filler<0.60 → opening', () => {
  const tech = decideRound({ kind: pick('technical_topic', { technical_topic: 0.55 }, 0.65), filler_only: noul(0.2) })
  assert.equal(tech.action, 'opening')
  assert.deepEqual(tech.reasons, ['kind=technical_topic p=0.55 conf=0.65'])
  assert.equal(tech.guidance, 'Tech talk is on the table. Speak only if you bring a fact or angle that is not already in the chat.')

  const joke = decideRound({ kind: pick('joke_or_tease', { joke_or_tease: 0.9 }, 0.9) })
  assert.equal(joke.action, 'opening')
  assert.equal(joke.guidance, 'Someone threw a line to play with. One short line back is enough.')

  // filler 恰好 0.70（源里硬编码的 0.60 否决线）→ 不开口。
  const fillerVeto = decideRound({
    kind: pick('question', { question: 0.9 }, 0.9),
    filler_only: noul(0.7),
    open_question_for_us: noul(0.1),
  })
  assert.equal(fillerVeto.action, 'unsure')
  assert.deepEqual(fillerVeto.reasons, ['kind=question p=0.9 conf=0.9 below threshold'])

  // 概率 0.45 < 0.50、置信度 0.50 < 0.60：两条都没过。
  assert.equal(decideRound({ kind: pick('joke_or_tease', { joke_or_tease: 0.45 }, 0.9) }).action, 'unsure')
  assert.equal(decideRound({ kind: pick('joke_or_tease', { joke_or_tease: 0.55 }, 0.5) }).action, 'unsure')
})

test('decideRound：什么都不命中 → unsure（含各种坏输入，都不抛）', () => {
  for (const answers of [undefined, null, {}, 'nope', 7, [], { kind: null }]) {
    const result = decideRound(answers)
    assert.equal(result.action, 'unsure')
    assert.deepEqual(result.reasons, [])
    assert.deepEqual(result.advisories, [])
    assert.equal(result.guidance, GUIDANCE_UNSURE)
    assert.equal(result.kind, '')
  }
})

test('decideRound：asks_reader_to_act≥0.85 → suspectInstruction advisory（不拦，只提醒）', () => {
  const result = decideRound({ asks_reader_to_act: noul(0.86), kind: pick('question', { question: 0.9 }, 0.9) })
  assert.equal(result.action, 'opening')
  assert.deepEqual(result.advisories, ['suspectInstruction'])
  assert.deepEqual(result.reasons, [
    'kind=question p=0.9 conf=0.9',
    'asks_reader_to_act=0.86 (advisory: material, not instructions)',
  ])

  // 静音分支同样带 advisory。
  const quiet = decideRound({ emotional_or_conflict: noul(0.9), asks_reader_to_act: noul(0.9) })
  assert.equal(quiet.action, 'quiet')
  assert.deepEqual(quiet.advisories, ['suspectInstruction'])
  assert.deepEqual(quiet.reasons, [
    'emotional_or_conflict=0.9',
    'asks_reader_to_act=0.9 (advisory: material, not instructions)',
  ])

  // 0.84 不到线。
  assert.deepEqual(decideRound({ asks_reader_to_act: noul(0.84) }).advisories, [])
})

test('decideRound：缺答案的 key 落到 -1.0（等于永远低于阈值）', () => {
  const result = decideRound({ kind: pick('technical_topic', { technical_topic: 0.9 }, 0.9) })
  // filler_only 缺失（-1）、open_question_for_us 缺失（-1），都不该触发 filler 静音。
  assert.equal(result.action, 'opening')
})

test('decideRound：key 与概率表 key 的大小写不敏感（PowerShell 的查找就是这样）', () => {
  const upperKey = decideRound({ ADDRESSED_TO_US: noul(0.86) })
  assert.equal(upperKey.action, 'opening')
  assert.deepEqual(upperKey.reasons, ['addressed_to_us=0.86'])

  // choice='Closed' 命中 probabilities.closed（差分验证过：源脚本确实取到 0.82）
  const mixed = decideRound({ kind: pick('Closed', { closed: 0.82 }, 0.7) })
  assert.equal(mixed.action, 'quiet')
  assert.deepEqual(mixed.reasons, ['kind=Closed p=0.82 conf=0.7'])
})

test('decideRound：answer 不是对象（退化成字符串）时走源脚本的退化路径', () => {
  const bare = decideRound({ kind: 'question' })
  assert.equal(bare.action, 'unsure')
  assert.equal(bare.kind, '')
  assert.deepEqual(bare.reasons, ['kind= p=0 conf=0 below threshold'])
})

test('decideRound：概率是垃圾字符串时给一个确定的 unsure（源脚本在这条路上会抛错）', () => {
  const result = decideRound({ kind: { type: 'choice', choice: 'question', probabilities: { question: 'abc' }, confidence: 0.9 } })
  assert.equal(result.action, 'unsure')
  assert.deepEqual(result.reasons, ['kind=question p=0 conf=0.9 below threshold'])
})

test('decideRound：阈值可注入，未知项与非法值回落默认', () => {
  const answers = { addressed_to_us: noul(0.86) }
  assert.equal(decideRound(answers).action, 'opening')
  assert.equal(decideRound(answers, { roundAimedAtUs: 0.95 }).action, 'unsure')
  assert.equal(decideRound(answers, { roundAimedUs: 0.1 }).action, 'opening')
  assert.equal(decideRound(answers, { roundAimedAtUs: 'x' }).action, 'opening')
  assert.equal(decideRound(answers, null).action, 'opening')
  assert.equal(decideRound(answers, 'nope').action, 'opening')
})

test('decideRound：也吃得下 formatAnswers 压过的形状', () => {
  const formatted = formatAnswers({
    addressed_to_us: { type: 'noul', noul: 0.86 },
    kind: { type: 'choice', choice: 'question', probabilities: { question: 0.9 }, confidence: 0.8 },
  })
  assert.deepEqual(formatted, {
    addressed_to_us: 0.86,
    kind: { choice: 'question', p: 0.9, confidence: 0.8 },
  })
  const result = decideRound(formatted)
  assert.equal(result.action, 'opening')
  assert.deepEqual(result.reasons, ['addressed_to_us=0.86'])
})

/* ========================================================================== */
/* formatAnswers                                                               */
/* ========================================================================== */

test('formatAnswers：noul→3 位小数、choice→概率/置信度 3 位小数、其它类型丢弃', () => {
  const formatted = formatAnswers({
    filler_only: { type: 'noul', noul: 0.123456 },
    kind: {
      type: 'choice',
      choice: 'question',
      probabilities: { question: 0.87654, closed: 0.12346 },
      confidence: 0.65432,
    },
    ASKED: { type: 'NOUL', noul: 1 },
    note: { type: 'text', value: 'hi' },
    bare: 'noul',
    empty: null,
  })
  assert.deepEqual(formatted, {
    filler_only: 0.123,
    kind: { choice: 'question', p: 0.877, confidence: 0.654 },
    ASKED: 1,
  })
})

test('formatAnswers：probabilities 的 key 大小写不敏感（源脚本用 PowerShell 成员查找）', () => {
  assert.deepEqual(formatAnswers({ kind: { type: 'choice', choice: 'Closed', probabilities: { closed: 0.4567 }, confidence: 0.6 } }), {
    kind: { choice: 'Closed', p: 0.457, confidence: 0.6 },
  })
})

test('formatAnswers：缺 probabilities / confidence / type 时给 0 或丢弃，不抛', () => {
  assert.deepEqual(formatAnswers({ kind: { type: 'choice', choice: 'question' } }), {
    kind: { choice: 'question', p: 0, confidence: 0 },
  })
  assert.deepEqual(formatAnswers({ a: { type: 'noul' } }), { a: 0 })
  assert.deepEqual(formatAnswers(undefined), {})
  assert.deepEqual(formatAnswers(null), {})
  assert.deepEqual(formatAnswers('nope'), {})
})

/* ========================================================================== */
/* decideDraft                                                                 */
/* ========================================================================== */

test('decideDraft：5 个 block 全命中（阈值边界 >= 即拦），顺序与文案照抄源脚本', () => {
  const result = decideDraft(
    {
      leaks_internal_detail: noul(0.6),
      unfounded_self_claim: noul(0.7),
      escalates_conflict: noul(0.7),
      filler_reply: noul(0.7),
      repeats_existing: noul(0.85),
    },
    'abc',
  )
  assert.deepEqual(result, {
    decision: 'block',
    blocks: [
      {
        question: 'leaks_internal_detail',
        noul: 0.6,
        reason: 'draft looks like it carries a credential, an internal address, or a local path',
      },
      {
        question: 'unfounded_self_claim',
        noul: 0.7,
        reason: 'draft claims personal facts about the account owner that the chat does not support',
      },
      { question: 'escalates_conflict', noul: 0.7, reason: 'draft would make the friction worse' },
      { question: 'filler_reply', noul: 0.7, reason: 'draft is only laughter or agreement, with nothing in it' },
      { question: 'repeats_existing', noul: 0.85, reason: 'draft repeats what is already on the table' },
    ],
    warnings: [],
    chars: 3,
  })
})

test('decideDraft：5 个 warning（阈值 0.50，leak 0.40）→ 只告警不拦', () => {
  const result = decideDraft(
    {
      leaks_internal_detail: noul(0.45),
      unfounded_self_claim: noul(0.55),
      escalates_conflict: noul(0.6),
      filler_reply: noul(0.55),
      repeats_existing: noul(0.6),
    },
    '好的',
  )
  assert.equal(result.decision, 'pass')
  assert.deepEqual(result.blocks, [])
  assert.deepEqual(result.warnings, [
    { question: 'leaks_internal_detail', noul: 0.45 },
    { question: 'unfounded_self_claim', noul: 0.55 },
    { question: 'escalates_conflict', noul: 0.6 },
    { question: 'filler_reply', noul: 0.55 },
    { question: 'repeats_existing', noul: 0.6 },
  ])
  assert.equal(result.chars, 2)
})

test('decideDraft：warning 线以下一律不报（leak 0.39 / 其余 0.49）', () => {
  const result = decideDraft(
    {
      leaks_internal_detail: noul(0.39),
      unfounded_self_claim: noul(0.49),
      escalates_conflict: noul(0.49),
      filler_reply: noul(0.49),
      repeats_existing: noul(0.49),
    },
    'x',
  )
  assert.deepEqual(
    { decision: result.decision, blocks: result.blocks, warnings: result.warnings },
    { decision: 'pass', blocks: [], warnings: [] },
  )
})

test('decideDraft：已经被 block 命中的问题不再进 warning', () => {
  const result = decideDraft(
    {
      leaks_internal_detail: noul(0.8),
      unfounded_self_claim: noul(0.55),
      filler_reply: noul(0.55),
    },
    'x',
  )
  assert.equal(result.decision, 'block')
  assert.deepEqual(result.blocks, [
    {
      question: 'leaks_internal_detail',
      noul: 0.8,
      reason: 'draft looks like it carries a credential, an internal address, or a local path',
    },
  ])
  // leak 0.8 同时高于 block 与 warning 线，但只报 block 那一次。
  assert.deepEqual(result.warnings, [
    { question: 'unfounded_self_claim', noul: 0.55 },
    { question: 'filler_reply', noul: 0.55 },
  ])
})

test('decideDraft：chars 按 UTF-16 码元数（与 PowerShell 的 .Length 一致）', () => {
  assert.equal(decideDraft({}, '哈哈哈').chars, 3)
  assert.equal(decideDraft({}, '你这个说法有问题').chars, 8)
  assert.equal(decideDraft({}, '🙂').chars, 2)
  assert.equal(decideDraft({}, '').chars, 0)
  assert.equal(decideDraft({}, null).chars, 0)
  assert.equal(decideDraft({}, undefined).chars, 0)
  assert.equal(decideDraft({}, 12345).chars, 5)
  assert.equal(decideDraft({}, 'abc').chars, 3)
})

test('decideDraft：阈值可注入、坏答案不抛', () => {
  const answers = { filler_reply: noul(0.6) }
  assert.equal(decideDraft(answers, 'x').decision, 'pass')
  assert.equal(decideDraft(answers, 'x').warnings.length, 1)
  assert.equal(decideDraft(answers, 'x', { draftFiller: 0.5 }).decision, 'block')
  assert.equal(decideDraft(answers, 'x', { nope: 1 }).decision, 'pass')

  for (const bad of [undefined, null, 'x', 3, {}, []]) {
    const result = decideDraft(bad, 'abc')
    assert.deepEqual(
      { decision: result.decision, blocks: result.blocks, warnings: result.warnings, chars: result.chars },
      { decision: 'pass', blocks: [], warnings: [], chars: 3 },
    )
  }
})

/* ========================================================================== */
/* composeRoundView                                                            */
/* ========================================================================== */

test('composeRoundView：判读不可用 → 只加 judgeUnavailable advisory，别的一概不动', () => {
  const view = mechanicalView()
  const result = composeRoundView(view, null)
  assert.equal(result.verdict, 'judge')
  assert.deepEqual(result.blockers, [])
  assert.deepEqual(result.advisories, ['selfIdentityUnknown', 'judgeUnavailable'])
  assert.equal(result.nextStep, view.nextStep)
  assert.equal(result.lastAgeSec, 12)
  assert.equal(result.judgeError, undefined)
  // 不改入参：调用方手里的视图保持原样。
  assert.deepEqual(view.advisories, ['selfIdentityUnknown'])
})

test('composeRoundView：判读 ok:false → advisory + judgeError，机械 blocker 原样保留', () => {
  const view = {
    verdict: 'blocked',
    blockers: ['lastFromSelf'],
    advisories: [],
    nextStep: 'Do not send. Record the blocker in notes.md and end the round.',
  }
  const result = composeRoundView(view, { ok: false, error: 'HTTP 503: boom' })
  assert.equal(result.verdict, 'blocked')
  assert.deepEqual(result.blockers, ['lastFromSelf'])
  assert.deepEqual(result.advisories, ['judgeUnavailable'])
  assert.equal(result.judgeError, 'HTTP 503: boom')
  assert.equal(result.nextStep, view.nextStep)
})

test('composeRoundView：quiet → verdict=blocked + noOpening，机械 blocker 不被清除', () => {
  const view = {
    verdict: 'blocked',
    blockers: ['noNewMessages'],
    advisories: ['selfIdentityUnknown'],
    nextStep: 'mech',
  }
  const guidance = 'No opening in the last messages. Do not send; end the round.'
  const result = composeRoundView(view, {
    ok: true,
    action: 'quiet',
    guidance,
    reasons: ['filler_only=0.9 open_question_for_us=0.5'],
    advisories: [],
  })
  assert.equal(result.verdict, 'blocked')
  assert.deepEqual(result.blockers, ['noNewMessages', 'noOpening'])
  assert.deepEqual(result.advisories, ['selfIdentityUnknown'])
  assert.equal(result.nextStep, guidance)

  // 机械层还没判死时，判读自己就能把 verdict 打成 blocked，并带上判读的 advisory。
  const fresh = composeRoundView(mechanicalView(), {
    ok: true,
    action: 'quiet',
    guidance: 'g-quiet',
    advisories: ['suspectInstruction'],
  })
  assert.equal(fresh.verdict, 'blocked')
  assert.deepEqual(fresh.blockers, ['noOpening'])
  assert.deepEqual(fresh.advisories, ['selfIdentityUnknown', 'suspectInstruction'])
  assert.equal(fresh.nextStep, 'g-quiet')
})

test('composeRoundView：opening → verdict=speak + nextStep 用 guidance', () => {
  const guidance = 'This one is aimed at our account. Answer it, briefly.'
  const result = composeRoundView(mechanicalView(), { ok: true, action: 'opening', guidance })
  assert.equal(result.verdict, 'speak')
  assert.deepEqual(result.blockers, [])
  assert.deepEqual(result.advisories, ['selfIdentityUnknown'])
  assert.equal(result.nextStep, guidance)
})

test('composeRoundView：unsure → judgeUnsure advisory，verdict 不动', () => {
  const result = composeRoundView(mechanicalView(), { ok: true, action: 'unsure', guidance: GUIDANCE_UNSURE })
  assert.equal(result.verdict, 'judge')
  assert.deepEqual(result.blockers, [])
  assert.deepEqual(result.advisories, ['selfIdentityUnknown', 'judgeUnsure'])
  assert.equal(result.nextStep, GUIDANCE_UNSURE)
})

test('composeRoundView：机械层已 blocked 时 opening 不放行（语义层只加不松）', () => {
  const view = {
    verdict: 'blocked',
    blockers: ['lastFromSelf'],
    advisories: [],
    nextStep: 'Do not send. Record the blocker in notes.md and end the round.',
  }
  const result = composeRoundView(view, { ok: true, action: 'opening', guidance: 'g-open' })
  assert.equal(result.verdict, 'blocked')
  assert.deepEqual(result.blockers, ['lastFromSelf'])
  assert.equal(result.nextStep, 'g-open')
})

test('composeRoundView：与 decideRound 串起来是真实调用形状', () => {
  const judgement = { ok: true, ...decideRound({ emotional_or_conflict: noul(0.82) }) }
  const blocked = composeRoundView(mechanicalView(), judgement)
  assert.equal(blocked.verdict, 'blocked')
  assert.deepEqual(blocked.blockers, ['noOpening'])
  assert.equal(blocked.nextStep, 'No opening in the last messages. Do not send; end the round.')

  const spoken = composeRoundView(mechanicalView(), { ok: true, ...decideRound({ addressed_to_us: noul(0.86) }) })
  assert.equal(spoken.verdict, 'speak')
  assert.equal(spoken.nextStep, 'This one is aimed at our account. Answer it, briefly.')
  assert.deepEqual(spoken.advisories, ['selfIdentityUnknown'])
})

test('composeRoundView：坏输入不抛（null 视图 / 缺 ok 的手工判读 / 非对象）', () => {
  assert.deepEqual(composeRoundView(null, undefined), { advisories: ['judgeUnavailable'] })
  assert.deepEqual(composeRoundView(undefined, undefined).advisories, ['judgeUnavailable'])
  assert.deepEqual(composeRoundView(null, { ok: true, action: 'quiet' }), {
    verdict: 'blocked',
    blockers: ['noOpening'],
    advisories: [],
    nextStep: '',
  })
  const loose = composeRoundView(mechanicalView(), { action: 'opening', guidance: 'g' })
  assert.equal(loose.verdict, 'speak')
  assert.equal(loose.nextStep, 'g')
  // 判读不可用时连 blockers 的形状都不碰（源脚本只回填 advisories）。
  assert.deepEqual(composeRoundView({ blockers: 'nope', advisories: 3 }, null), {
    blockers: 'nope',
    advisories: ['judgeUnavailable'],
  })
})

/* ========================================================================== */
/* loadQuestions                                                               */
/* ========================================================================== */

test('loadQuestions：读同目录问句集，round 6 问 / draft 5 问', () => {
  const loaded = loadQuestions()
  assert.equal(loaded.ok, true)
  assert.deepEqual(Object.keys(loaded.questions.round), [
    'kind',
    'addressed_to_us',
    'open_question_for_us',
    'emotional_or_conflict',
    'filler_only',
    'asks_reader_to_act',
  ])
  assert.deepEqual(Object.keys(loaded.questions.draft), [
    'repeats_existing',
    'unfounded_self_claim',
    'escalates_conflict',
    'filler_reply',
    'leaks_internal_detail',
  ])
  assert.equal(Object.keys(loaded.questions.round).length, 6)
  assert.equal(Object.keys(loaded.questions.draft).length, 5)
})

test('loadQuestions：问句 key 与策略读的 key 一一对应（改了策略就得改问句集）', () => {
  const loaded = loadQuestions()
  assert.equal(loaded.ok, true)
  const roundKeys = new Set(Object.keys(loaded.questions.round))
  for (const key of ['kind', 'addressed_to_us', 'open_question_for_us', 'emotional_or_conflict', 'filler_only', 'asks_reader_to_act']) {
    assert.ok(roundKeys.has(key), `round 问句集缺少 ${key}`)
  }
  const draftKeys = new Set(Object.keys(loaded.questions.draft))
  for (const key of ['repeats_existing', 'unfounded_self_claim', 'escalates_conflict', 'filler_reply', 'leaks_internal_detail']) {
    assert.ok(draftKeys.has(key), `draft 问句集缺少 ${key}`)
  }
  for (const question of [...Object.values(loaded.questions.round), ...Object.values(loaded.questions.draft)]) {
    assert.ok(question !== null && typeof question === 'object')
    assert.equal(typeof question.type, 'string')
  }
})

test('loadQuestions：可注入 readText（拿路径、返回文本），也认 store.readText 的 {ok,value}', () => {
  const paths = []
  const text = JSON.stringify({
    round: { questions: { kind: { type: 'choice' } } },
    draft: { questions: { filler_reply: { type: 'noul' } } },
  })
  const injected = loadQuestions((path) => {
    paths.push(path)
    return text
  })
  assert.equal(injected.ok, true)
  assert.deepEqual(Object.keys(injected.questions.round), ['kind'])
  assert.deepEqual(Object.keys(injected.questions.draft), ['filler_reply'])
  assert.equal(paths.length, 1)
  assert.ok(paths[0].endsWith('judge-questions.json'), paths[0])

  const viaStore = loadQuestions(() => ({ ok: true, value: text }))
  assert.equal(viaStore.ok, true)
  assert.deepEqual(Object.keys(viaStore.questions.round), ['kind'])

  // 非函数（含 null）→ 回落默认读盘。
  assert.equal(loadQuestions(null).ok, true)
})

test('loadQuestions：注入的 readText 抛错 → {ok:false}，绝不抛', () => {
  const thrown = loadQuestions(() => {
    throw new Error('boom')
  })
  assert.deepEqual(thrown, { ok: false, error: 'boom' })
})

test('loadQuestions：读不到 / 不是 JSON / 结构不对 → 都是 {ok:false,error}', () => {
  assert.equal(loadQuestions(() => '').ok, false)
  assert.equal(loadQuestions(() => null).ok, false)
  assert.match(loadQuestions(() => 'not json').error, /cannot parse/)
  assert.match(loadQuestions(() => ({ ok: false, error: 'ENOENT' })).error, /ENOENT/)
  assert.equal(loadQuestions(() => ({ ok: false, error: 'ENOENT' })).ok, false)
  assert.equal(loadQuestions(() => '{"round":{"questions":{}}}').ok, false)
  assert.equal(loadQuestions(() => '{}').ok, false)
  assert.equal(loadQuestions(() => '{"round":{"questions":{}},"draft":{"questions":{}}}').ok, true)
})
