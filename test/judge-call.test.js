/**
 * 判读调用层测试：`buildState`（会话切片 → System One state）与 `createJudge`（注入 fetch 的 HTTP 调用器）。
 *
 * 纪律：零网络（fetch 全部注入桩）、零真实 key、零写盘。唯一真的会等的用例是超时那条：
 * 实现把 `timeoutMs` 夹到不小于 1000ms，只能等到那时才 abort（桩在 abort 瞬间 reject，不多等）。
 *
 * 跑法：`node --test test/judge-call.test.js`
 *
 * @module dsh-popo-watcher/test/judge-call
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildState, createJudge } from '../lib/judge.js'

/** Typesafe System One 端点（契约里写死的那个）。 */
const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone'

/** 固定"当前时间"（2023-11 附近的毫秒值）：缺 `t_msg` 的条目若被当成 0，会算出 ~2820 万分钟。 */
const FIXED_NOW = 1_700_000_000_000

/** state 里 conversation 的字段集合（多一个字段都算泄漏，比如 msgId）。 */
const CONVERSATION_KEYS = ['is_new', 'is_our_account', 'minutes_ago', 'n', 'speaker', 'text']

/** 造一条 POPO 消息（带上 state 用不到的字段，顺便验证不会透传出去）。 */
const msg = (tMsg, content, name = 'someone', from = 'u-someone') => ({
  t_msg: tMsg,
  time: '2026-09-22 10:00:00',
  from,
  name,
  msgId: `m-${String(tMsg)}`,
  content,
})

/** 造一个 Typesafe 应答桩（只实现 `ask` 会用到的那几样）。 */
const reply = ({ ok = true, status = 200, body = '{}' } = {}) => ({ ok, status, text: async () => body })

/** 造一个记录入参的 fetch 桩：handler 可以返回应答、同步抛错，或返回 rejected promise。 */
function fakeFetch(handler = () => reply()) {
  const calls = []
  const fetchImpl = (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  return { calls, fetchImpl }
}

/** 造一个 judge：fetch 桩 + 显式 options（key 由调用方给，方便测"没有 key"）。 */
function judgeWith(handler, options = {}) {
  const { calls, fetchImpl } = fakeFetch(handler)
  return { calls, judge: createJudge({ fetchImpl, ...options }) }
}

test('判读目录：GET 账户模型，凭证只进请求头，两种判读使用选择的同一个模型', async () => {
  const { judge, calls } = judgeWith((url) => reply({ body: JSON.stringify(url.endsWith('/models')
    ? { models: [{ name: 'jev-preview', description: 'preview', release_date: '2026-09-10' }] }
    : { answers: {}, model: 'jev-preview' }) }), { getKey: () => 'fake-key', model: 'jev-preview' })
  assert.deepEqual(await judge.listModels(), { ok: true, models: [{ id: 'jev-preview', name: 'jev-preview', description: 'preview' }] })
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/models')
  assert.equal(calls[0].init.method, 'GET')
  assert.deepEqual(calls[0].init.headers, { authorization: 'Bearer fake-key' })
  assert.equal(calls[0].init.body, undefined)
  await judge.runRound({}, {})
  await judge.runDraft({}, {})
  assert.deepEqual(calls.slice(1).map(call => JSON.parse(call.init.body).model), ['jev-preview', 'jev-preview'])
})

test('判读目录：缺 key 不联网，认证失败不回显响应，空目录和坏响应可区分', async () => {
  const missing = judgeWith(() => assert.fail('缺 key 不能联网'))
  assert.match((await missing.judge.listModels()).error, /未配置/)
  assert.equal(missing.calls.length, 0)
  for (const status of [401, 403, 429, 500]) {
    const { judge } = judgeWith(() => reply({ ok: false, status, body: 'private server response' }), { getKey: () => 'key' })
    const result = await judge.listModels()
    assert.equal(result.ok, false)
    assert.match(result.error, new RegExp(`HTTP ${status}`))
    assert.equal(result.error.includes('private'), false)
  }
  for (const body of ['not json', '{}', '{"models":[null]}', '{"models":[{"name":" "}]}']) {
    const { judge } = judgeWith(() => reply({ body }), { getKey: () => 'key' })
    assert.equal((await judge.listModels()).ok, false, body)
  }
  const { judge } = judgeWith(() => reply({ body: '{"models":[]}' }), { getKey: () => 'key' })
  assert.deepEqual(await judge.listModels(), { ok: true, models: [] })
})

test('判读目录：超时覆盖读取响应体，网络错误不会回显 key', async () => {
  const { judge } = judgeWith((_url, init) => ({ ok: true, status: 200, text: () => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }) }), { getKey: () => 'key', timeoutMs: 1 })
  assert.match((await judge.listModels()).error, /超时/)
  const network = judgeWith(() => { throw new Error('failed with private-test-key') }, { getKey: () => 'private-test-key' })
  const result = await network.judge.listModels()
  assert.match(result.error, /读取失败/)
  assert.equal(result.error.includes('private-test-key'), false)
})

/* ========================================================================== */
/* buildState                                                                 */
/* ========================================================================== */

test('buildState: chat 默认三件套在，调用方给的 chat 覆盖同名项', () => {
  const bare = buildState()
  assert.deepEqual(Object.keys(bare.chat).sort(), ['language', 'our_account_display_name', 'setting'])
  assert.match(bare.chat.setting, /group chat/)
  assert.equal(bare.chat.language, 'Simplified Chinese')
  assert.match(bare.chat.our_account_display_name, /blue big fat fish/)
  assert.deepEqual(bare.conversation, [])
  assert.deepEqual(bare.our_recent_messages, [])

  const custom = buildState({ chat: { setting: 'custom setting', language: 'English', group: 'g1' } })
  assert.equal(custom.chat.setting, 'custom setting')
  assert.equal(custom.chat.language, 'English')
  assert.equal(custom.chat.group, 'g1')
  assert.match(custom.chat.our_account_display_name, /blue big fat fish/, '没覆盖的默认项要留着')
})

test('buildState: conversation 逐条映射 n / minutes_ago / speaker / is_our_account / text', () => {
  const state = buildState({
    messages: [
      msg(FIXED_NOW - 5 * 60_000, '在吗', 'alice', 'u-alice'),
      msg(FIXED_NOW - 60_000, '在', 'blue big fat fish', 'u-self'),
    ],
    selfUid: 'u-self',
    newMark: 1,
    now: () => FIXED_NOW,
  })

  assert.deepEqual(state.conversation, [
    { n: 1, minutes_ago: 5, speaker: 'alice', is_our_account: false, is_new: false, text: '在吗' },
    { n: 2, minutes_ago: 1, speaker: 'blue big fat fish', is_our_account: true, is_new: true, text: '在' },
  ])
  for (const entry of state.conversation) {
    assert.deepEqual(Object.keys(entry).sort(), CONVERSATION_KEYS, '消息原始字段（msgId 等）不该进 state')
  }
})

test('buildState: sinceMs > 0 时 is_new 严格等价 t_msg > sinceMs（水位压过 newMark）', () => {
  const state = buildState({
    messages: [msg(1000, 'old'), msg(5000, 'edge'), msg(5001, 'new')],
    sinceMs: 5000,
    newMark: 99, // 水位生效时它不该起作用
    now: () => 600_000,
  })

  assert.deepEqual(state.conversation.map((entry) => entry.n), [1, 2, 3])
  assert.deepEqual(state.conversation.map((entry) => entry.is_new), [false, false, true], '等于水位的不算新')
  assert.deepEqual(state.conversation.map((entry) => entry.text), ['old', 'edge', 'new'])
})

test('buildState: sinceMs = 0 时 is_new 取"最后 newMark 条"（默认 3）', () => {
  const messages = [1, 2, 3, 4, 5].map((i) => msg(i * 1000, `m${i}`))
  const flags = (input) => buildState({ messages, now: () => 60_000, ...input }).conversation.map((entry) => entry.is_new)

  assert.deepEqual(flags({}), [false, false, true, true, true], '默认 newMark = 3')
  assert.deepEqual(flags({ newMark: 1 }), [false, false, false, false, true])
  assert.deepEqual(flags({ newMark: 0 }), [false, false, false, false, false])
  assert.deepEqual(flags({ newMark: 99 }), [true, true, true, true, true], 'newMark 超过条数时全是新消息')
  assert.deepEqual(buildState({ messages: [], now: () => 60_000 }).conversation, [])
})

test('buildState: is_our_account 只在 from 严格等于非空 selfUid 时为 true', () => {
  const messages = [
    msg(1, 'a', 'alice', 'u-alice'),
    msg(2, 'b', 'self', 'u-self'),
    { t_msg: 3, name: 'anon', content: 'c' },
  ]
  const flags = (input) => buildState({ messages, now: () => 3, ...input }).conversation.map((entry) => entry.is_our_account)

  assert.deepEqual(flags({ selfUid: 'u-self' }), [false, true, false])
  assert.deepEqual(flags({ selfUid: '' }), [false, false, false], '没给 selfUid 时谁也不认领')
  assert.deepEqual(flags({}), [false, false, false])
  assert.deepEqual(flags({ selfUid: 'U-SELF' }), [false, false, false], '严格比较，大小写不敏感不是契约')
})

test('buildState: speaker / text 缺字段时回落空串（不写 undefined）', () => {
  const state = buildState({ messages: [{ t_msg: 4, from: 'u1' }], now: () => 4 })
  assert.deepEqual(state.conversation, [
    { n: 1, minutes_ago: 0, speaker: '', is_our_account: false, is_new: true, text: '' },
  ])
})

test('buildState: our_recent_messages 认字符串与 {content}，滤掉空串与非字符串项，只留最后 4 条', () => {
  const state = buildState({
    sentMessages: ['m1', { content: 'm2' }, '', { content: '' }, null, undefined, 42, true, { content: 'm3' }, 'm4', { content: 'm5' }, 'm6'],
  })
  assert.deepEqual(state.our_recent_messages, ['m3', 'm4', 'm5', 'm6'])
})

test('buildState: sentMessages 不是数组时 our_recent_messages 为空数组（含空串时也空）', () => {
  assert.deepEqual(buildState({ sentMessages: null }).our_recent_messages, [])
  assert.deepEqual(buildState({ sentMessages: 'm1' }).our_recent_messages, [])
  assert.deepEqual(buildState({ sentMessages: 42 }).our_recent_messages, [])
  assert.deepEqual(buildState({ sentMessages: [{ content: '' }, ''] }).our_recent_messages, [])
})

test('buildState: 缺 t_msg / t_msg = 0 / t_msg 为 null 都不伪造 1970（minutes_ago = 0）', () => {
  const state = buildState({
    messages: [
      { name: 'a', from: 'u1', content: '没有 t_msg' },
      { t_msg: 0, name: 'b', from: 'u2', content: 't_msg = 0' },
      { t_msg: null, name: 'c', from: 'u3', content: 't_msg = null' },
    ],
    now: () => FIXED_NOW,
  })

  assert.deepEqual(state.conversation.map((entry) => entry.minutes_ago), [0, 0, 0])
  assert.deepEqual(state.conversation.map((entry) => entry.n), [1, 2, 3])
  assert.deepEqual(state.conversation.map((entry) => entry.text), ['没有 t_msg', 't_msg = 0', 't_msg = null'])
})

test('buildState: t_msg 只认 number——数字字符串按缺失处理（当前实现的宽容读法）', () => {
  const state = buildState({
    messages: [{ t_msg: String(FIXED_NOW - 60_000), name: 'a', from: 'u1', content: 'x' }],
    now: () => FIXED_NOW,
  })

  assert.equal(state.conversation[0].minutes_ago, 0, '若上游给字符串时间戳，这里会静默退回"没时间"')
  assert.equal(state.conversation[0].is_new, true, 'newMark 兜底下它算新消息')
})

test('buildState: 畸形入参一律不抛，且始终返回三件套形状', () => {
  const inputs = [
    undefined, null, 42, 'nope', [], {},
    { messages: null }, { messages: 'nope' }, { messages: 42 }, { messages: {} },
    { messages: [null, undefined, 0, false, ''] },
    { sentMessages: null }, { sentMessages: 42 }, { sentMessages: 'x' },
    { chat: null }, { chat: undefined }, { chat: 42 },
    { selfUid: null }, { sinceMs: null }, { newMark: null },
    { now: null }, { now: 42 }, { now: () => { throw new Error('clock broke') } },
  ]

  inputs.forEach((input, index) => {
    let state
    assert.doesNotThrow(() => { state = buildState(input) }, `第 ${index} 个入参不该抛`)
    assert.ok(Array.isArray(state.conversation), 'conversation 必须是数组')
    assert.ok(Array.isArray(state.our_recent_messages), 'our_recent_messages 必须是数组')
    assert.ok(state.chat !== null && typeof state.chat === 'object', 'chat 必须是对象')
  })

  const mixed = buildState({
    messages: [null, msg(2 * 60_000, '唯一活着的消息', 'alice', 'u-alice'), undefined],
    now: () => FIXED_NOW,
  })
  assert.equal(mixed.conversation.length, 1, 'null 元素被丢掉，不占 n')
  assert.deepEqual(mixed.conversation[0], {
    n: 1,
    minutes_ago: Math.trunc((FIXED_NOW - 2 * 60_000) / 60_000),
    speaker: 'alice',
    is_our_account: false,
    is_new: true,
    text: '唯一活着的消息',
  })
})

test('buildState: input 为 null 时回落空壳（never-throw 的兜底分支）', () => {
  assert.deepEqual(buildState(null), { chat: {}, conversation: [], our_recent_messages: [] })
})

/* ========================================================================== */
/* createJudge                                                                */
/* ========================================================================== */

test('createJudge: available() 没有可用 fetch 时 {ok:false} 且不抛', async () => {
  // 传非函数值才算"没有 fetch"：`fetchImpl: null/undefined` 会被 `??` 换成 globalThis.fetch（见回报里的疑点）
  for (const fetchImpl of [0, false, 'not-a-function', {}]) {
    const judge = createJudge({ fetchImpl, getKey: () => 'k' })
    const result = await judge.available()
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0)
  }
})

test('createJudge: available() 没有 key / key 只有空白时 {ok:false}，提示里含 TYPESAFE_API_KEY，且不发请求', async () => {
  const getKeys = [undefined, () => '', () => '   ', () => null, () => 42, async () => '']

  for (const getKey of getKeys) {
    const { calls, judge } = judgeWith(undefined, { getKey })
    const result = await judge.available()
    assert.equal(result.ok, false)
    assert.match(result.error, /TYPESAFE_API_KEY/)
    assert.equal(calls.length, 0)
  }
})

test('createJudge: getKey 抛错不冒泡，走 logger 后回落 {ok:false}', async () => {
  const logs = []
  const { calls, judge } = judgeWith(undefined, {
    getKey: () => { throw new Error('keyring locked') },
    logger: (line) => logs.push(line),
  })

  const available = await judge.available()
  assert.equal(available.ok, false)
  assert.match(available.error, /TYPESAFE_API_KEY/)

  const round = await judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(round.ok, false)
  assert.match(round.error, /TYPESAFE_API_KEY/)
  assert.ok(
    logs.some((line) => String(line).includes('keyring locked')),
    `取 key 失败要落进 logger：${JSON.stringify(logs)}`,
  )
  assert.equal(calls.length, 0)
})

test('createJudge: available() 有 key 时 {ok:true}（key 两端空白会被去掉）', async () => {
  const { judge } = judgeWith(undefined, { getKey: () => '  k-test  ' })
  assert.deepEqual(await judge.available(), { ok: true })
})

test('createJudge: runRound 成功 → POST systemone，method/头/体三件套齐，返回完整结果对象', async () => {
  const answers = {
    kind: { type: 'choice', choice: 'question', probabilities: { question: 0.9, closed: 0.1 }, confidence: 0.8 },
    open_question_for_us: { type: 'noul', noul: 0.75 },
  }
  let clock = 10_000
  const { calls, judge } = judgeWith(
    () => {
      clock = 10_250
      return reply({ body: JSON.stringify({ model: 'jev-from-response', answers, usage: { input_tokens: 137, output_tokens: 9 } }) })
    },
    { getKey: () => '  secret-key  ', model: 'jev-requested', now: () => clock },
  )
  const state = buildState({ messages: [msg(FIXED_NOW - 60_000, '在吗', 'alice', 'u-alice')], now: () => FIXED_NOW })
  const questions = { kind: { type: 'choice', instructions: 'what are the new messages doing' } }

  const result = await judge.runRound(state, questions)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, SYSTEMONE_URL)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key', 'key 要 trim 后进 Bearer')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.ok(calls[0].init.signal instanceof AbortSignal, '请求要带 AbortSignal')
  assert.equal(calls[0].init.signal.aborted, false, '正常返回后不该被 abort')
  assert.deepEqual(JSON.parse(calls[0].init.body), { state, model: 'jev-requested', questions })

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'round')
  assert.equal(result.model, 'jev-from-response', '应答带 model 时以应答为准')
  assert.equal(result.tokens, 137, 'tokens 取 usage.input_tokens')
  assert.equal(result.ms, 250, 'ms 用注入的 now 差')
  assert.deepEqual(result.answers, answers)
  assert.deepEqual(result.formatted, {
    kind: { choice: 'question', p: 0.9, confidence: 0.8 },
    open_question_for_us: 0.75,
  })
})

test('createJudge: 应答没有 model 时回落请求里的 model（默认 jev-latest），usage 缺失时 tokens = 0', async () => {
  const plain = judgeWith(() => reply({ body: JSON.stringify({ answers: {} }) }), { getKey: () => 'k' })
  const fallback = await plain.judge.runRound({ s: 1 }, { q: 1 })

  assert.equal(fallback.ok, true)
  assert.equal(fallback.model, 'jev-latest')
  assert.equal(fallback.tokens, 0)
  assert.ok(fallback.ms >= 0)
  assert.equal(JSON.parse(plain.calls[0].init.body).model, 'jev-latest')

  const custom = judgeWith(() => reply({ body: '{"answers":{}}' }), { getKey: () => 'k', model: 'jev-custom' })
  const customResult = await custom.judge.runDraft({ s: 1 }, { q: 1 })

  assert.equal(customResult.ok, true)
  assert.equal(customResult.mode, 'draft')
  assert.equal(customResult.model, 'jev-custom')
  assert.equal(JSON.parse(custom.calls[0].init.body).model, 'jev-custom')
})

test('createJudge: runRound / runDraft 各自送对应 questions，mode 不串', async () => {
  const { calls, judge } = judgeWith(() => reply({ body: '{"answers":{}}' }), { getKey: () => 'k' })
  const roundQuestions = { kind: { type: 'choice', instructions: 'round question set' } }
  const draftQuestions = { self_claim: { type: 'noul', instructions: 'draft question set' } }

  const round = await judge.runRound({ marker: 'round' }, roundQuestions)
  const draft = await judge.runDraft({ marker: 'draft' }, draftQuestions)

  assert.equal(calls.length, 2)
  assert.equal(round.mode, 'round')
  assert.equal(draft.mode, 'draft')
  assert.deepEqual(JSON.parse(calls[0].init.body).questions, roundQuestions)
  assert.deepEqual(JSON.parse(calls[1].init.body).questions, draftQuestions)
  assert.deepEqual(JSON.parse(calls[0].init.body).state, { marker: 'round' })
  assert.deepEqual(JSON.parse(calls[1].init.body).state, { marker: 'draft' })
})

test('createJudge: HTTP 401 / 407 / 503 都回落 {ok:false}，错误带状态码与正文片段（正文最多 200 字）', async () => {
  const unauthorized = judgeWith(() => reply({ ok: false, status: 401, body: '{"error":"invalid api key"}' }), { getKey: () => 'bad' })
  const result401 = await unauthorized.judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(result401.ok, false)
  assert.match(result401.error, /HTTP 401/)
  assert.match(result401.error, /invalid api key/, '要带上正文片段便于排查')

  const proxy = judgeWith(() => reply({ ok: false, status: 407, body: 'proxy authentication required' }), { getKey: () => 'k' })
  const result407 = await proxy.judge.runDraft({ s: 1 }, { q: 1 })
  assert.equal(result407.ok, false)
  assert.match(result407.error, /HTTP 407/)
  assert.match(result407.error, /proxy authentication required/)

  const noBody = judgeWith(() => ({ ok: false, status: 503, text: async () => { throw new Error('body gone') } }), { getKey: () => 'k' })
  const result503 = await noBody.judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(result503.ok, false)
  assert.equal(result503.error, 'HTTP 503', '读不到正文也要给出状态码')

  const long = judgeWith(() => reply({ ok: false, status: 500, body: 'x'.repeat(500) }), { getKey: () => 'k' })
  const result500 = await long.judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(result500.ok, false)
  assert.equal(result500.error.length, 'HTTP 500 '.length + 200, '正文片段要截到 200 字')
})

test('createJudge: fetchImpl 抛错（同步 / reject / 带 cause）都回落 {ok:false} 且不抛', async () => {
  const sync = judgeWith(() => { throw new TypeError('network down') }, { getKey: () => 'k' })
  const r1 = await sync.judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /请求失败/)
  assert.match(r1.error, /network down/)

  const rejected = judgeWith(() => Promise.reject(new TypeError('dns fail')), { getKey: () => 'k' })
  const r2 = await rejected.judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /dns fail/)

  const cause = new TypeError('fetch failed')
  cause.cause = new Error('ECONNREFUSED 10.0.0.1:443')
  const withCause = judgeWith(() => { throw cause }, { getKey: () => 'k' })
  const r3 = await withCause.judge.runDraft({ s: 1 }, { q: 1 })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /fetch failed/)
  assert.match(r3.error, /ECONNREFUSED/, '要带上 cause 里的底层原因')
})

test('createJudge: 应答不是 JSON / 不是对象 / 没有 answers 都回落 {ok:false}', async () => {
  const notJson = judgeWith(() => reply({ body: '<html>502 Bad Gateway</html>' }), { getKey: () => 'k' })
  const r1 = await notJson.judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /响应不是 JSON/)

  const throwingBody = judgeWith(() => ({ ok: true, status: 200, text: async () => { throw new Error('stream reset') } }), { getKey: () => 'k' })
  const r2 = await throwingBody.judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /响应不是 JSON/)
  assert.match(r2.error, /stream reset/)

  for (const body of ['{}', '{"answers":null}', '{"answers":"nope"}', '{"answers":42}', '{"answers":false}', 'null', '[]']) {
    const { judge } = judgeWith(() => reply({ body }), { getKey: () => 'k' })
    const result = await judge.runDraft({ s: 1 }, { q: 1 })
    assert.equal(result.ok, false, `应答 ${body} 不该当作成功`)
    assert.match(result.error, /没有 answers/)
  }

  for (const value of [null, 42, 'text']) {
    const { judge } = judgeWith(() => value, { getKey: () => 'k' })
    const result = await judge.runRound({ s: 1 }, { q: 1 })
    assert.equal(result.ok, false, '应答桩给了个非对象也不该抛')
    assert.match(result.error, /响应不可用/)
  }
})

test('createJudge: state / questions 为 null 或非对象时先回落 {ok:false}，且一个请求都不发', async () => {
  const { calls, judge } = judgeWith(undefined, { getKey: () => 'k' })

  const noState = await judge.runRound(null, { q: 1 })
  assert.equal(noState.ok, false)
  assert.match(noState.error, /state/)

  const noQuestions = await judge.runDraft({ s: 1 }, null)
  assert.equal(noQuestions.ok, false)
  assert.match(noQuestions.error, /question set/i)

  for (const bad of [undefined, 42, 'text', false]) {
    const asState = await judge.runRound(bad, { q: 1 })
    assert.equal(asState.ok, false)
    const asQuestions = await judge.runRound({ s: 1 }, bad)
    assert.equal(asQuestions.ok, false)
  }

  assert.equal(calls.length, 0, '入参不合法就不该发请求')
})

test('createJudge: 超时（永不 settle 的 fetch）在 AbortSignal abort 后回落 {ok:false}', async () => {
  let aborted = false
  let signal = null
  const fetchImpl = (url, init) => {
    signal = init.signal
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      }, { once: true })
    })
  }
  const judge = createJudge({ fetchImpl, getKey: () => 'k', timeoutMs: 1000 })

  const started = Date.now()
  const pending = judge.runRound({ s: 1 }, { q: 1 })
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.ok(signal instanceof AbortSignal, 'fetch 要拿到 signal')
  assert.equal(signal.aborted, false, 'timeoutMs 被夹到不小于 1000ms，50ms 时还不该 abort')

  // 兜底：实现若永远不 settle，这里给出明确失败而不是把 runner 挂死
  let guard
  const bail = new Promise((resolve) => {
    guard = setTimeout(() => resolve({ ok: false, error: 'TEST-GUARD: runRound 没有在 3s 内返回' }), 3000)
  })
  const result = await Promise.race([pending, bail])
  clearTimeout(guard)

  assert.doesNotMatch(String(result.error), /^TEST-GUARD/, String(result.error))
  assert.equal(result.ok, false)
  assert.equal(aborted, true, 'abort 之后桩 reject，ask 才能降级')
  assert.equal(signal.aborted, true)
  assert.match(String(result.error), /abort/i)
  assert.ok(Date.now() - started < 3000, '超时用例应在 ~1s 内结束')
})

test('createJudge: 什么都没注入时 available / runRound / runDraft 全部降级、不抛（且不发请求）', async () => {
  const judge = createJudge()

  const available = await judge.available()
  assert.equal(typeof available, 'object')
  assert.equal(available.ok, false)
  assert.match(available.error, /TYPESAFE_API_KEY/)

  // 注：默认 fetchImpl 是 globalThis.fetch（Node 18+ 总有），所以这条走的是"没有 key"的降级，零网络
  await assert.doesNotReject(() => judge.runRound({ s: 1 }, { q: 1 }))
  const round = await judge.runRound({ s: 1 }, { q: 1 })
  assert.equal(round.ok, false)
  assert.match(round.error, /TYPESAFE_API_KEY/)

  const draft = await judge.runDraft(null, null)
  assert.equal(draft.ok, false)
})
