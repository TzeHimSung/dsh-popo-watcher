/**
 * 轮次编排（round）测试：机械层 → 语义层 → 文案层的编排结论。
 *
 * 全部用桩判读客户端 / 桩文案层，不联网、不碰真实模型；重点验证
 * **判读只能加拒绝**、判读不可用时的两种取向、以及"拿不准就安静"。
 *
 * @module dsh-popo-watcher/test/round
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildDraftPrompt, createRound } from '../lib/round.js'

/** 造一个 `noul` 答案。 */
const noul = (value) => ({ type: 'noul', noul: value })
/** 造一个 `choice` 答案。 */
const pick = (name, probabilities, confidence) => ({ type: 'choice', choice: name, probabilities, confidence })

/** 一套"点名我们、可以接话"的答案。 */
const OPENING_ANSWERS = {
  kind: pick('question', { question: 0.82, technical_topic: 0.1, closed: 0.08 }, 0.79),
  addressed_to_us: noul(0.86),
  open_question_for_us: noul(0.9),
  emotional_or_conflict: noul(0.29),
  filler_only: noul(0.11),
  asks_reader_to_act: noul(0.08),
}

/** 一套"只有笑声、没有切口"的答案。 */
const FILLER_ANSWERS = {
  kind: pick('joke_or_tease', { joke_or_tease: 0.4, other: 0.6 }, 0.5),
  addressed_to_us: noul(0.1),
  open_question_for_us: noul(0.1),
  emotional_or_conflict: noul(0.2),
  filler_only: noul(0.95),
  asks_reader_to_act: noul(0.05),
}

/** 一套"什么都说不准"的答案（阈值全没够）。 */
const UNSURE_ANSWERS = {
  kind: pick('other', { other: 0.6, question: 0.2, technical_topic: 0.2 }, 0.4),
  addressed_to_us: noul(0.2),
  open_question_for_us: noul(0.2),
  emotional_or_conflict: noul(0.3),
  filler_only: noul(0.3),
  asks_reader_to_act: noul(0.1),
}

/** 两条消息（默认：最后一条是别人说的，机械层放行）。 */
function messages() {
  return [
    { t_msg: 1000, time: '2026-09-22 09:00:00', from: 'u-a', name: '张三', msgId: 'm1', content: '缓存清了还是慢' },
    { t_msg: 2000, time: '2026-09-22 09:00:20', from: 'u-b', name: '李四', msgId: 'm2', content: '你试过换 OS 吗' },
  ]
}

/** 桩判读客户端。 */
function judgeClient({ answers = OPENING_ANSWERS, available = { ok: true }, throws = false } = {}) {
  const calls = []
  return {
    calls,
    available: async () => available,
    runRound: async (state, questions) => {
      calls.push({ state, questions })
      if (throws) throw new Error('network down')
      return { ok: true, mode: 'round', model: 'jev-1.13.0', ms: 300, tokens: 3300, answers, formatted: {} }
    },
    runDraft: async () => ({ ok: true, answers: {}, formatted: {} }),
  }
}

/** 桩文案层。 */
function draftWriter({ text = '缓存清了还是慢的话，先看下连接池大小。', available = true } = {}) {
  const calls = []
  return {
    calls,
    available: () => (available ? { ok: true, provider: 'p', model: 'm' } : { ok: false, error: '没有可用的模型档' }),
    write: async (params) => {
      calls.push(params)
      if (text === null) throw new Error('llm exploded')
      return { ok: true, text, model: 'm', ms: 120 }
    },
  }
}

/** 跑一次 plan。 */
function plan(options = {}) {
  const runner = createRound({
    judgeClient: options.judgeClient ?? judgeClient(),
    // 注意：`null` 是"没有文案层"的有效取值，不能被 ?? 兜掉。
    draftWriter: 'draftWriter' in options ? options.draftWriter : draftWriter(),
    logger: options.logger,
    now: () => new Date('2026-09-22T10:00:30'),
  })
  return runner.plan({
    messages: options.messages ?? messages(),
    newCount: options.newCount ?? 2,
    selfUid: options.selfUid ?? 'u-self',
    sentMessages: options.sentMessages ?? [],
    config: options.config ?? { judge: { enabled: true }, maxChars: 50, prompt: { system: 'SYS' }, llm: { maxTokens: 200 } },
    questions: options.questions ?? { kind: {} },
  })
}

test('机械层挡住时不调判读、不写文案，直接安静', async () => {
  const client = judgeClient()
  const writer = draftWriter()
  const result = await plan({ newCount: 0, judgeClient: client, draftWriter: writer })

  assert.equal(result.verdict, 'quiet')
  assert.match(result.reason, /mechanical: noNewMessages/)
  assert.deepEqual(result.view.blockers, ['noNewMessages'])
  assert.equal(client.calls.length, 0, '机械挡住就不该浪费一次判读请求')
  assert.equal(writer.calls.length, 0)
})

test('判读说有切口 → speak，并把引导语写进文案提示词', async () => {
  const client = judgeClient()
  const writer = draftWriter()
  const result = await plan({ judgeClient: client, draftWriter: writer })

  assert.equal(result.verdict, 'speak')
  assert.equal(result.draft, '缓存清了还是慢的话，先看下连接池大小。')
  assert.equal(result.view.verdict, 'speak')
  assert.equal(result.view.action, 'opening')
  assert.equal(result.view.blockers.length, 0)

  assert.equal(client.calls.length, 1)
  const prompt = writer.calls[0].prompt
  assert.match(prompt, /\[新\] 李四：你试过换 OS 吗/)
  assert.match(prompt, /This one is aimed at our account/, '导语应当来自判读的 guidance')
  assert.match(prompt, /SKIP/)
  assert.equal(writer.calls[0].system, 'SYS')
  assert.equal(writer.calls[0].maxTokens, 200)
  assert.equal(writer.calls[0].temperature, undefined, '配置没给温度就不带')
})

test('文案层拿到的是配置里的温度与 maxTokens（不是硬编码）', async () => {
  const writer = draftWriter()
  const result = await plan({
    draftWriter: writer,
    config: { judge: { enabled: true }, maxChars: 30, prompt: { system: 'SYS' }, llm: { maxTokens: 256, temperature: 0.2 } },
  })

  assert.equal(result.verdict, 'speak')
  assert.equal(writer.calls[0].maxTokens, 256)
  assert.equal(writer.calls[0].temperature, 0.2)
  assert.match(writer.calls[0].prompt, /30 字以内/)
})

test('判读说没切口 → quiet，且语义层加出的 noOpening 出现在 blockers 里', async () => {
  const writer = draftWriter()
  const result = await plan({ judgeClient: judgeClient({ answers: FILLER_ANSWERS }), draftWriter: writer })

  assert.equal(result.verdict, 'quiet')
  assert.equal(result.view.verdict, 'blocked')
  assert.ok(result.view.blockers.includes('noOpening'), '语义层的拒绝要体现在 blockers 上')
  assert.match(result.reason, /judge quiet/)
  assert.equal(writer.calls.length, 0, '没切口就不写文案')
})

test('判读拿不准（unsure）→ 安静，不花钱写文案', async () => {
  const writer = draftWriter()
  const result = await plan({ judgeClient: judgeClient({ answers: UNSURE_ANSWERS }), draftWriter: writer })

  assert.equal(result.verdict, 'quiet')
  assert.equal(result.view.verdict, 'judge')
  assert.ok(result.view.advisories.includes('judgeUnsure'))
  assert.equal(writer.calls.length, 0)
})

test('判读不可用 + 默认取向 quiet → 安静', async () => {
  const writer = draftWriter()
  const cases = [
    judgeClient({ available: { ok: false, error: '没有 TYPESAFE_API_KEY' } }),
    judgeClient({ throws: true }),
  ]
  for (const client of cases) {
    const result = await plan({ judgeClient: client, draftWriter: writer })
    assert.equal(result.verdict, 'quiet')
    assert.ok(result.view.advisories.includes('judgeUnavailable'))
    assert.equal(writer.calls.length, 0, '判读不可用就不该自动发言')
  }
  assert.equal(writer.calls.length, 0)
})

test('判读不可用 + unavailablePolicy=llm → 交给模型：SKIP 就安静，给了话就发', async () => {
  const config = { judge: { enabled: true, unavailablePolicy: 'llm' }, maxChars: 50, prompt: { system: 'SYS' }, llm: {} }
  const skipWriter = draftWriter({ text: 'SKIP' })
  const skipped = await plan({
    judgeClient: judgeClient({ available: { ok: false, error: 'no key' } }),
    draftWriter: skipWriter,
    config,
  })
  assert.equal(skipped.verdict, 'quiet')
  assert.equal(skipped.reason, 'model said SKIP')
  assert.equal(skipWriter.calls.length, 1, '这一档就是要问模型')

  const talkWriter = draftWriter({ text: '我看下连接池。' })
  const spoke = await plan({
    judgeClient: judgeClient({ available: { ok: false, error: 'no key' } }),
    draftWriter: talkWriter,
    config,
  })
  assert.equal(spoke.verdict, 'speak')
  assert.equal(spoke.draft, '我看下连接池。')
  assert.ok(spoke.view.advisories.includes('judgeUnavailable'))
})

test('判读被整轮关掉（judge.enabled=false）时也不自动发言', async () => {
  const writer = draftWriter()
  const result = await plan({
    judgeClient: judgeClient(),
    draftWriter: writer,
    config: { judge: { enabled: false }, prompt: {}, llm: {} },
  })
  assert.equal(result.verdict, 'quiet')
  assert.equal(writer.calls.length, 0)
})

test('没有文案层 / 文案层抛错 / 文案层返回空 → 一律安静，绝不抛', async () => {
  const noWriter = await plan({ draftWriter: null })
  assert.equal(noWriter.verdict, 'quiet')
  assert.match(noWriter.reason, /文案层/)

  const broken = draftWriter({ text: null })
  const brokenResult = await plan({ draftWriter: broken })
  assert.equal(brokenResult.verdict, 'quiet')
  assert.match(brokenResult.reason, /draft unavailable/)

  const empty = draftWriter({ text: '' })
  const emptyResult = await plan({ draftWriter: empty })
  assert.equal(emptyResult.verdict, 'quiet')
  assert.equal(emptyResult.draft, '')
})

test('机械层挡住"最后一条是自己"时，不接自己的话', async () => {
  const own = [
    { t_msg: 1000, from: 'u-b', name: '李四', content: '在吗' },
    { t_msg: 2000, from: 'u-self', name: '群聊助手', content: '我在' },
  ]
  const result = await plan({ messages: own })
  assert.equal(result.verdict, 'quiet')
  assert.deepEqual(result.view.blockers, ['lastFromSelf'])
})

test('没有 selfUid 时给 advisory（不静默通过）', async () => {
  const result = await plan({ selfUid: '' })
  assert.equal(result.verdict, 'speak')
  assert.ok(result.view.advisories.includes('selfIdentityUnknown'))
})

test('buildDraftPrompt：带 [新] 标记、我们说过的话、引导语与 SKIP 约定', () => {
  const prompt = buildDraftPrompt({
    conversation: [
      { n: 1, speaker: '张三', text: '缓存清了还是慢', is_new: false },
      { n: 2, speaker: '李四', text: '你试过换 OS 吗', is_new: true },
    ],
    ourRecent: ['我先看下日志', '这个我踩过'],
    guidance: 'This one is aimed at our account. Answer it, briefly.',
    maxChars: 42,
  })
  assert.match(prompt, /1\. 张三：缓存清了还是慢/)
  assert.match(prompt, /2\. \[新\] 李四：你试过换 OS 吗/)
  assert.match(prompt, /我先看下日志 \/ 这个我踩过/)
  assert.match(prompt, /This one is aimed at our account/)
  assert.match(prompt, /42 字以内/)
  assert.match(prompt, /只回 SKIP/)
})

test('plan 对坏输入（messages 非数组 / config 为空）也不抛', async () => {
  const runner = createRound({ judgeClient: judgeClient(), draftWriter: draftWriter() })
  for (const input of [undefined, {}, { messages: 'nope', config: null }, { messages: [null, undefined], newCount: 1 }]) {
    const result = await runner.plan(input)
    assert.equal(typeof result, 'object')
    assert.ok(['quiet', 'speak'].includes(result.verdict), `verdict 应当是结论之一，实际 ${String(result.verdict)}`)
  }
})
