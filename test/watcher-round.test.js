import { memoryStore as fakeStore } from './helpers/memory-store.js'
/**
 * watcher 轮次集成测试：开窗 → 开场白 → 采集触发 → 判读 → 文案 → 发送 → 记账。
 *
 * 这里用**真的** sender / guards / poller，只把三处外部世界换成桩：
 * 传输层（popo-cli）、判读（TypeSafe）、文案（宿主 llm）。
 * 目标是把"自动水群"这条链路整条跑通，而不是只测单点。
 *
 * @module dsh-popo-watcher/test/watcher-round
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWatcher } from '../lib/watcher.js'
import { defaultConfig } from '../lib/config.js'
import { createRpcHandler } from '../lib/rpc.js'

const ROOT = 'C:/fake/.dsh/popo-watcher'
const GROUP = '1234567'
const DIR = `${ROOT}/${GROUP}`

/** 内存文件系统桩（json / jsonl / 文本行三种），行为对齐 lib/store.js 的对外形状。 */

/** 判读桩：默认"点名我们、可以接话"。 */
function judgeStub({ available = { ok: true }, answers = null } = {}) {
  const rounds = []
  return {
    rounds,
    available: async () => available,
    runRound: async (state) => {
      rounds.push(state)
      return {
        ok: true,
        mode: 'round',
        model: 'jev-1.13.0',
        answers: answers ?? {
          kind: { type: 'choice', choice: 'question', probabilities: { question: 0.82 }, confidence: 0.79 },
          addressed_to_us: { type: 'noul', noul: 0.86 },
          open_question_for_us: { type: 'noul', noul: 0.9 },
          emotional_or_conflict: { type: 'noul', noul: 0.29 },
          filler_only: { type: 'noul', noul: 0.11 },
          asks_reader_to_act: { type: 'noul', noul: 0.08 },
        },
      }
    },
    runDraft: async () => (available?.ok === true
      ? { ok: true, answers: {}, formatted: {} }
      : { ok: false, error: available?.error ?? 'judge unavailable' }),
  }
}

/** 文案桩。 */
function draftStub(text = '连接池开大点试试？') {
  const calls = []
  return { calls, write: async (params) => { calls.push(params); return { ok: true, text, model: 'stub-model', ms: 5 } } }
}

/** 传输桩：search 默认返回空，send 默认成功（可用 sendResult 覆盖）。 */
function transportStub({ messages = [], uid = 'u-self', sendResult = null } = {}) {
  const sends = []
  return {
    sends,
    describe: () => ({ ok: true, cliPath: 'C:/popo.js', nodePath: 'node' }),
    search: async () => ({ ok: true, value: { uid, messages } }),
    send: async ({ group, text }) => {
      sends.push({ group, text })
      return sendResult ?? { ok: true, value: { msgId: `mid-${sends.length}` } }
    },
  }
}

const messages = (count = 2) => Array.from({ length: count }, (_, index) => ({
  t_msg: 1000 + index * 60_000,
  time: `2026-09-22 09:0${index}:00`,
  from: index === count - 1 ? 'u-b' : 'u-a',
  name: index === count - 1 ? '李四' : '张三',
  msgId: `m${index}`,
  content: index === count - 1 ? '你试过换 OS 吗' : '缓存清了还是慢',
}))

/** 造一个"窗口已开好"的 store。 */
function openWindow(overrides = {}, { sentMessages = [] } = {}) {
  return fakeStore({
    json: {
      [`${DIR}/state.json`]: {
        group: GROUP,
        selfUid: 'u-self',
        startedAt: '2026-09-22 09:00:00',
        endsAt: '2026-09-22 21:00:00',
        sentCount: sentMessages.length,
        sentMessages,
        minGapSec: 20,
        lastSendEpochMs: 0,
        stopped: false,
        ...overrides,
      },
    },
    jsonl: { [`${DIR}/messages.jsonl`]: messages() },
  })
}

/** 造 watcher。 */
function makeWatcher({ store, transport, judge = judgeStub(), draft = draftStub(), config = {}, now = () => new Date('2026-09-22T10:00:00'), schedule = () => () => {} } = {}) {
  const cfg = { ...defaultConfig(), group: GROUP, ...config }
  return createWatcher({
    store,
    config: {
      defaultConfig: () => ({ ...cfg }),
      normalizeConfig: (raw) => (raw === undefined || raw === null ? { config: { ...cfg }, warnings: [] } : { config: { ...cfg, ...raw }, warnings: [] }),
      applyPatch: (current, patch) => ({ config: { ...current, ...patch }, warnings: [] }),
    },
    now,
    getTransport: () => transport ?? null,
    schedule,
    judgeClient: judge,
    draftWriter: draft,
  })
}

/** 让在途的微任务跑完。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

function pollingClock() {
  let time = new Date('2026-09-22T10:00:00').getTime()
  const jobs = []
  return {
    jobs,
    now: () => new Date(time),
    advance: ms => { time += ms },
    schedule: (fn, ms) => {
      const job = { fn, ms, at: time + ms, cancelled: false, fired: false }
      jobs.push(job)
      return () => { job.cancelled = true }
    },
    async next() {
      const job = jobs.find(item => !item.fired && !item.cancelled)
      assert.ok(job, '必须有下一次采集任务')
      job.fired = true
      time = job.at
      job.fn()
      await tick()
      return job
    },
  }
}

const networkFailure = { ok: false, kind: 'upstream', code: 'FABRIC_NETWORK_ERROR', retryable: true, error: 'FABRIC_NETWORK_ERROR: ECONNRESET' }

test('首轮网络故障返回正在重试；超时继续退避，成功清零，不补发开场白', async (t) => {
  const clock = pollingClock()
  const store = openWindow()
  const watermark = { lastSeenMsgTime: 123, updatedAt: '2026-09-22 09:59:00', watchedMsgs: 7, selfUid: 'u-self' }
  store.json.set(`${DIR}/poller.json`, watermark)
  const transport = transportStub()
  const outcomes = [networkFailure, { ok: false, kind: 'timeout', retryable: true, error: '采集超时' }, { ok: true, value: { messages: [], uid: 'u-self' } }, networkFailure]
  transport.search = async () => outcomes.shift()
  const watcher = makeWatcher({ store, transport, now: clock.now, schedule: clock.schedule })
  t.after(() => watcher.dispose())
  const started = await createRpcHandler({ watcher })('start', { hours: 2 })
  assert.equal(started.ok, true)
  assert.equal(started.value.polling, true)
  assert.equal(started.value.recovering, true)
  assert.equal(started.value.opening.ok, false)
  assert.match(started.value.opening.reason, /不补发开场白/)
  assert.deepEqual(store.json.get(`${DIR}/poller.json`), watermark)
  assert.equal(watcher.status().value.window.stopped, false)
  assert.equal(watcher.status().value.poll.nextRetryAt, clock.now().getTime() + 40_000)
  assert.equal((await watcher.runRound(messages())).verdict, 'skipped')
  await clock.next()
  assert.equal(watcher.status().value.poll.consecutiveFailures, 2)
  assert.equal(clock.jobs.at(-1).ms, 80_000)
  assert.deepEqual(store.json.get(`${DIR}/poller.json`), watermark)
  await clock.next()
  const recovered = watcher.status().value
  assert.equal(recovered.poll.running, true)
  assert.equal(recovered.poll.recovering, false)
  assert.equal(recovered.poll.consecutiveFailures, 0)
  assert.equal(recovered.poll.lastError, null)
  assert.equal(recovered.poll.nextRetryAt, null)
  assert.equal(recovered.degraded.active, false)
  assert.equal(recovered.poll.watchedMsgs, 7)
  assert.equal(recovered.poll.lastSeenMsgTime, 123)
  assert.notEqual(recovered.poll.updatedAt, watermark.updatedAt)
  assert.equal(clock.jobs.at(-1).ms, 20_000)
  await clock.next()
  assert.equal(watcher.status().value.poll.consecutiveFailures, 1)
  assert.equal(clock.jobs.at(-1).ms, 40_000)
  assert.equal(transport.sends.length, 0)
})

test('连续第五次网络故障停止并持久化；重建实例不会自动恢复', async (t) => {
  const clock = pollingClock()
  const store = openWindow({ sentCount: 13 })
  const transport = transportStub()
  let searches = 0
  transport.search = async () => { searches += 1; return networkFailure }
  const watcher = makeWatcher({ store, transport, now: clock.now, schedule: clock.schedule })
  t.after(() => watcher.dispose())
  assert.equal((await watcher.startWindow()).recovering, true)
  for (const delay of [40_000, 80_000, 160_000, 300_000]) {
    assert.equal(clock.jobs.at(-1).ms, delay)
    await clock.next()
  }
  const status = watcher.status().value
  assert.equal(searches, 5)
  assert.equal(clock.jobs.length, 4)
  assert.equal(status.poll.consecutiveFailures, 5)
  assert.equal(status.poll.failureLimit, 5)
  assert.equal(status.poll.running, false)
  assert.equal(status.poll.recovering, false)
  assert.equal(status.poll.nextRetryAt, null)
  assert.equal(status.window.stopped, true)
  assert.match(status.window.stoppedReason, /连续失败 5 次，已停止/)
  assert.equal(status.window.collectionError, networkFailure.error)
  assert.equal(status.sends.count, 13)
  assert.equal(transport.sends.length, 0)
  const reloaded = makeWatcher({ store, transport, now: clock.now })
  t.after(() => reloaded.dispose())
  assert.equal((await reloaded.resume()).resumed, false)
  assert.equal(reloaded.status().value.poll.consecutiveFailures, 0, '本次启动还没有新的采集失败')
  assert.equal(reloaded.status().value.window.collectionFailures, 5, '历史失败次数仍保留')
  assert.equal(reloaded.status().value.degraded.active, false)
  assert.equal(reloaded.status().value.phase, 'idle')
  assert.equal(reloaded.status().value.poll.recovering, false)
  assert.equal(searches, 5)
})

test('重试期间的停止、卸载、到期阻止下一次请求；旧定时回调不能复活采集', async (t) => {
  for (const action of ['stop', 'dispose', 'expire']) {
    const clock = pollingClock()
    const store = openWindow()
    const transport = transportStub()
    let searches = 0
    transport.search = async () => { searches += 1; return networkFailure }
    const watcher = makeWatcher({ store, transport, now: clock.now, schedule: clock.schedule })
    t.after(() => watcher.dispose())
    await watcher.startWindow({ hours: 1 })
    const queued = clock.jobs[0]
    if (action === 'stop') await watcher.stop()
    else if (action === 'dispose') watcher.dispose()
    else clock.advance(3_600_000)
    queued.fn()
    await tick()
    assert.equal(searches, 1, action)
    assert.equal(watcher.status().value.poll.running, false, action)
    assert.equal(watcher.status().value.poll.nextRetryAt, null, action)
    assert.equal(transport.sends.length, 0, action)
  }
})

test('停止在途重试后忽略迟到结果，不推进水位、不触发回复', async (t) => {
  const clock = pollingClock()
  const store = openWindow()
  const transport = transportStub()
  transport.search = async () => networkFailure
  const watcher = makeWatcher({ store, transport, now: clock.now, schedule: clock.schedule })
  t.after(() => watcher.dispose())
  await watcher.startWindow()
  let release
  transport.search = () => new Promise(resolve => { release = resolve })
  await clock.next()
  assert.equal(watcher.status().value.poll.nextRetryAt, null)
  await watcher.stop()
  release({ ok: true, value: { messages: messages(), uid: 'u-self' } })
  await tick()
  assert.equal(watcher.status().value.poll.updatedAt, null)
  assert.equal(store.json.has(`${DIR}/poller.json`), false)
  assert.equal(watcher.status().value.window.stopped, true)
  assert.equal(clock.jobs.length, 1)
  assert.equal(transport.sends.length, 0)
})

test('网络恢复后，故障前仍在生成或判读的草稿也不能补发', async (t) => {
  for (const stage of ['draft', 'assessment']) {
    const clock = pollingClock()
    const store = openWindow()
    const transport = transportStub()
    let release
    const pending = new Promise(resolve => { release = resolve })
    const judge = judgeStub()
    if (stage === 'assessment') judge.runDraft = () => pending
    const draft = stage === 'draft' ? { write: () => pending } : draftStub()
    const watcher = makeWatcher({ store, transport, judge, draft, now: clock.now, schedule: clock.schedule, config: { opening: { enabled: false } } })
    t.after(() => watcher.dispose())
    await watcher.startWindow()
    const round = watcher.runRound(messages())
    await tick()
    transport.search = async () => networkFailure
    await clock.next()
    assert.equal(watcher.status().value.poll.recovering, true)
    transport.search = async () => ({ ok: true, value: { messages: [] } })
    await clock.next()
    assert.equal(watcher.status().value.poll.consecutiveFailures, 0)
    release(stage === 'draft' ? { ok: true, text: '迟到草稿' } : { ok: true, answers: {} })
    const result = await round
    assert.equal(result.verdict, 'send-blocked')
    assert.equal(result.send.reason, 'collection stopped')
    assert.equal(transport.sends.length, 0)
    assert.equal(watcher.status().value.window.stopped, false)
  }
})

test('慢草稿期间手动停止会立即停表，排队完成后也不发送旧草稿', async (t) => {
  const clock = pollingClock()
  const store = openWindow()
  const transport = transportStub()
  let release
  const draft = { write: () => new Promise(resolve => { release = resolve }) }
  const watcher = makeWatcher({ store, transport, draft, now: clock.now, schedule: clock.schedule, config: { opening: { enabled: false } } })
  t.after(() => watcher.dispose())
  await watcher.startWindow()
  const round = watcher.runRound(messages())
  await tick()
  const stopping = watcher.stop()
  assert.equal(watcher.status().value.poll.running, false)
  assert.equal(clock.jobs[0].cancelled, true)
  release({ ok: true, text: '不应发出的旧草稿' })
  assert.equal((await round).verdict, 'send-blocked')
  assert.equal((await stopping).ok, true)
  assert.equal(transport.sends.length, 0)
  assert.equal(watcher.status().value.window.stopped, true)
})

test('重试期间收到认证失败立即停止，不耗尽剩余重试次数', async (t) => {
  const clock = pollingClock()
  const store = openWindow()
  const transport = transportStub()
  transport.search = async () => networkFailure
  const watcher = makeWatcher({ store, transport, now: clock.now, schedule: clock.schedule })
  t.after(() => watcher.dispose())
  await watcher.startWindow()
  transport.search = async () => ({ ok: false, kind: 'upstream', code: 'FABRIC_AUTH_LOGIN_REQUIRED', retryable: false, error: '请运行 popo-cli auth login' })
  await clock.next()
  const status = watcher.status().value
  assert.equal(status.poll.consecutiveFailures, 2)
  assert.equal(status.poll.running, false)
  assert.equal(status.window.stopped, true)
  assert.match(status.window.collectionError, /auth login/)
  assert.equal(clock.jobs.length, 1)
})

test('首轮空输出、认证失败或抛错都立即停止；不开场、不重试，显式重开才恢复', async (t) => {
  for (const failure of [
    { ok: false, kind: 'parse', error: 'popo-cli 没有输出（exit=0）' },
    { ok: false, kind: 'auth', error: 'FABRIC_AUTH_LOGIN_REQUIRED' },
    new Error('search exception'),
  ]) {
    const store = openWindow()
    const transport = transportStub()
    let searches = 0
    transport.search = async () => { searches += 1; if (failure instanceof Error) throw failure; return failure }
    const scheduled = []
    const watcher = makeWatcher({ store, transport, schedule: fn => { scheduled.push(fn); return () => {} } })
    t.after(() => watcher.dispose())
    const rpc = createRpcHandler({ watcher })
    assert.equal((await rpc('start', { hours: 2 })).ok, false)
    assert.equal(watcher.status().value.window.stopped, true)
    assert.equal(watcher.status().value.poll.running, false)
    assert.equal(scheduled.length, 0)
    assert.equal(searches, 1)
    assert.equal(transport.sends.length, 0, '首轮失败不能发开场白')
    assert.equal((await watcher.resume()).resumed, false)
    transport.search = async () => { searches += 1; return { ok: true, value: { messages: [] } } }
    assert.equal((await watcher.startWindow({ hours: 2 })).ok, true)
    assert.equal(searches, 2)
    assert.equal(watcher.status().value.window.stopped, false)
    assert.equal(watcher.status().value.window.collectionError, null)
    assert.equal(watcher.status().value.poll.lastError, null)
    assert.equal(watcher.status().value.poll.running, true)
  }
})

test('正常采集后发生故障：立即关闭并拦住仍在生成或判读的回复', async (t) => {
  for (const stage of ['draft', 'assessment']) {
    const store = openWindow()
    const transport = transportStub()
    const scheduled = []
    let release
    const pending = new Promise(resolve => { release = resolve })
    const judge = judgeStub()
    if (stage === 'assessment') judge.runDraft = () => pending
    const draft = stage === 'draft' ? { write: () => pending } : draftStub()
    const watcher = makeWatcher({ store, transport, judge, draft, config: { opening: { enabled: false } }, schedule: fn => { scheduled.push(fn); return () => {} } })
    t.after(() => watcher.dispose())
    await watcher.startWindow({ hours: 2 })
    const round = watcher.runRound(messages())
    await tick()
    transport.search = async () => ({ ok: false, error: 'popo-cli 没有输出（exit=0）' })
    scheduled[0]()
    await tick()
    assert.equal(watcher.status().value.window.stopped, true, '不能等慢判读结束才关闭开关')
    assert.equal(watcher.status().value.poll.running, false)
    assert.equal(scheduled.length, 1, '失败后不排下一轮')
    release(stage === 'draft' ? { ok: true, text: '测试回复' } : { ok: true, answers: {} })
    const result = await round
    assert.equal(result.verdict, 'send-blocked')
    assert.equal(result.send.reason, 'collection stopped')
    assert.equal(transport.sends.length, 0)
    assert.equal((await watcher.runRound(messages())).verdict, 'skipped')
    assert.equal((await watcher.sendNow({ manual: true, text: '手动仍可发' })).ok, true)
    assert.equal(transport.sends.length, 1)
    assert.equal(store.json.get(`${DIR}/state.json`).stopped, true)
  }
})

test('故障发生于发送等待回执期间，成功记账不能清除停止状态', async (t) => {
  const store = openWindow()
  const transport = transportStub()
  const scheduled = []
  const watcher = makeWatcher({ store, transport, config: { opening: { enabled: false } }, schedule: fn => { scheduled.push(fn); return () => {} } })
  t.after(() => watcher.dispose())
  await watcher.startWindow()
  let complete
  transport.send = () => new Promise(resolve => { complete = resolve })
  const sending = watcher.sendNow({ text: '测试在途回执' })
  await tick()
  assert.equal(typeof complete, 'function')
  transport.search = async () => ({ ok: false, error: '采集异常' })
  scheduled[0]()
  await tick()
  complete({ ok: true, value: { msgId: 'already-submitted' } })
  assert.equal((await sending).ok, true)
  const saved = store.json.get(`${DIR}/state.json`)
  assert.equal(saved.sentCount, 1)
  assert.equal(saved.stopped, true)
  assert.equal(saved.collectionError, '采集异常')
})

test('故障停止状态写盘失败仍关闭开关、停止采集和自动发言，并记录持久化错误', async (t) => {
  const store = openWindow()
  const transport = transportStub()
  const scheduled = []
  const watcher = makeWatcher({ store, transport, config: { opening: { enabled: false } }, schedule: fn => { scheduled.push(fn); return () => {} } })
  t.after(() => watcher.dispose())
  await watcher.startWindow()
  store.writeJsonAtomic = () => ({ ok: false, error: 'EACCES' })
  transport.search = async () => ({ ok: false, error: '采集超时' })
  scheduled[0]()
  await tick()
  const status = watcher.status().value
  assert.equal(status.window.stopped, true)
  assert.equal(status.poll.running, false)
  assert.equal(scheduled.length, 1)
  assert.ok(status.errors.some(error => error.message.includes('EACCES')))
  assert.equal((await watcher.sendNow({ text: '不应发送' })).ok, false)
  assert.equal(transport.sends.length, 0)
})

test('开窗自动发开场白（每窗口一条），并如实记账', async () => {
  const store = fakeStore()
  const transport = transportStub()
  // 时钟可推进：开场白之间有 20s 最小间隔守卫，冻住时间会被 'too soon' 先拦住。
  let clock = new Date('2026-09-22T10:00:00')
  const watcher = makeWatcher({ store, transport, now: () => clock })

  const result = await watcher.startWindow({ hours: 3 })
  assert.equal(result.ok, true)
  assert.equal(result.polling, true)
  assert.equal(result.opening.ok, true, '开场白应当发出去')
  assert.equal(transport.sends.length, 1)
  assert.match(transport.sends[0].text, /群聊助手/)

  const state = store.json.get(`${DIR}/state.json`)
  assert.equal(state.sentCount, 1)
  assert.equal(typeof state.openingSentAt, 'string')
  assert.equal(store.jsonl.get(`${DIR}/sends.jsonl`)[0].opening, true)

  // 同一个窗口里再手动发一次"开场白"：守卫要拦住（每窗口一条），不能刷屏。
  clock = new Date('2026-09-22T10:05:00')
  const again = await watcher.sendNow({ text: '再打个招呼', opening: true })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'opening already sent')
  assert.equal(transport.sends.length, 1, '第二句开场白不该发出去')

  // 但**新窗口**是另一回事：重算窗口后重新放开一条（源实现的语义）。
  const reopened = await watcher.startWindow({ hours: 3 })
  assert.equal(reopened.opening.ok, true)
  assert.equal(transport.sends.length, 2)
  assert.equal(store.json.get(`${DIR}/state.json`).sentCount, 2)
})

test('开场白关掉时不发；dryRun 时不发也不记账', async () => {
  const off = makeWatcher({ store: fakeStore(), transport: transportStub(), config: { opening: { enabled: false, text: 'hi' } } })
  const noOpening = await off.startWindow({ hours: 1 })
  assert.equal(noOpening.opening, null)
  assert.equal(noOpening.polling, true)

  const dryStore = fakeStore()
  const dryTransport = transportStub()
  const dry = makeWatcher({
    store: dryStore,
    transport: dryTransport,
    config: { dryRun: true, opening: { enabled: true, text: '大家好' } },
  })
  const dryResult = await dry.startWindow({ hours: 1 })
  assert.equal(dryResult.opening.ok, true)
  assert.equal(dryResult.opening.dryRun, true)
  assert.equal(dryTransport.sends.length, 0, '干跑不碰传输层')
  assert.equal(dryStore.jsonl.get(`${DIR}/sends.jsonl`), undefined, '干跑不写发言流水')
})

test('runRound：判读说有切口 → 写文案并真的发出去，round.jsonl 记 sent', async () => {
  const store = openWindow()
  const transport = transportStub()
  const judge = judgeStub()
  const draft = draftStub('连接池开大点试试？')
  const watcher = makeWatcher({ store, transport, judge, draft })

  const result = await watcher.runRound(messages())
  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'sent')
  assert.equal(result.text, '连接池开大点试试？')
  assert.equal(transport.sends.length, 1)
  assert.equal(transport.sends[0].text, '连接池开大点试试？')

  assert.equal(store.json.get(`${DIR}/state.json`).sentCount, 1, '发言计数要落盘')
  const rows = store.jsonl.get(`${DIR}/round.jsonl`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, 'sent')
  assert.equal(rows[0].newCount, 2)
  assert.equal(rows[0].draft, '连接池开大点试试？')
  assert.equal(judge.rounds.length, 1, '走了一次判读')
  assert.equal(draft.calls.length, 1)

  // 状态快照里能看到最近一轮
  const { value } = await watcher.status()
  assert.equal(value.round.verdict, 'sent')
})

test('runRound：判读说没切口 / 拿不准 → 不发消息，只记 round.jsonl', async () => {
  const quietAnswers = {
    kind: { type: 'choice', choice: 'joke_or_tease', probabilities: { joke_or_tease: 0.3 }, confidence: 0.4 },
    addressed_to_us: { type: 'noul', noul: 0.1 },
    open_question_for_us: { type: 'noul', noul: 0.1 },
    emotional_or_conflict: { type: 'noul', noul: 0.2 },
    filler_only: { type: 'noul', noul: 0.95 },
    asks_reader_to_act: { type: 'noul', noul: 0.05 },
  }
  const store = openWindow()
  const transport = transportStub()
  const watcher = makeWatcher({ store, transport, judge: judgeStub({ answers: quietAnswers }) })

  const result = await watcher.runRound(messages())
  assert.equal(result.verdict, 'quiet')
  assert.equal(transport.sends.length, 0)
  assert.equal(store.jsonl.get(`${DIR}/round.jsonl`)[0].verdict, 'quiet')
  assert.ok(store.jsonl.get(`${DIR}/round.jsonl`)[0].blockers.includes('noOpening'))
})

test('runRound：判读不可用时安静，绝不自动发言', async () => {
  const store = openWindow()
  const transport = transportStub()
  const watcher = makeWatcher({ store, transport, judge: judgeStub({ available: { ok: false, error: '没有 TYPESAFE_API_KEY' } }) })

  const result = await watcher.runRound(messages())
  assert.equal(result.verdict, 'quiet')
  assert.equal(transport.sends.length, 0)
  assert.equal(store.jsonl.get(`${DIR}/round.jsonl`)[0].verdict, 'quiet')
})

test('runRound：窗口停了/过期/从未开窗都不判（连 round.jsonl 都不写）', async () => {
  const cases = [
    { state: { stopped: true }, label: '已静音' },
    { state: { endsAt: '2026-09-22 09:30:00' }, label: '已过期' },
    { state: { startedAt: '', endsAt: '' }, label: '从未开窗' },
  ]
  for (const { state, label } of cases) {
    const store = openWindow(state)
    const transport = transportStub()
    const watcher = makeWatcher({ store, transport })
    const result = await watcher.runRound(messages())
    assert.equal(result.verdict, 'skipped', `${label} 应当跳过`)
    assert.equal(transport.sends.length, 0, `${label} 不该发消息`)
    assert.equal(store.jsonl.get(`${DIR}/round.jsonl`), undefined, `${label} 不该写 round.jsonl`)
  }
})

test('runRound：dryRun 只判不发，流水与状态都不动', async () => {
  const store = openWindow()
  const transport = transportStub()
  const watcher = makeWatcher({ store, transport, config: { dryRun: true, opening: { enabled: false, text: 'hi' } } })

  const result = await watcher.runRound(messages())
  assert.equal(result.verdict, 'dry')
  assert.equal(transport.sends.length, 0)
  assert.equal(store.json.get(`${DIR}/state.json`).sentCount, 0)
  assert.equal(store.jsonl.get(`${DIR}/sends.jsonl`), undefined)
  assert.equal(store.jsonl.get(`${DIR}/round.jsonl`)[0].verdict, 'dry')
})

test('runRound：最小间隔没过时如实报 send-blocked（不假装发成功）', async () => {
  const store = openWindow({ lastSendEpochMs: new Date('2026-09-22T09:59:55').getTime() })
  const transport = transportStub()
  const watcher = makeWatcher({ store, transport })

  const result = await watcher.runRound(messages())
  assert.equal(result.verdict, 'send-blocked')
  assert.equal(result.send.reason, 'too soon')
  assert.equal(transport.sends.length, 0)
  assert.equal(store.jsonl.get(`${DIR}/round.jsonl`)[0].verdict, 'send-blocked')
})

test('采集到新消息会自动触发一轮（端到端：poller → round → 发送）', async () => {
  const store = openWindow({}, { sentMessages: [] })
  store.json.set(`${DIR}/poller.json`, { lastSeenMsgTime: 1000, updatedAt: '2026-09-22 09:59:00', selfUid: 'u-self', watchedMsgs: 1 })
  const transport = transportStub({ messages: messages(2) })
  const judge = judgeStub()
  const draft = draftStub('我看下连接池')
  const watcher = makeWatcher({
    store,
    transport,
    judge,
    draft,
    config: { opening: { enabled: false, text: 'hi' } },
    now: () => new Date('2026-09-22T10:00:00'),
  })

  await watcher.startWindow({ hours: 2 })
  // 采集是异步的（start → loop → tickOnce → onMessages），给它几个 tick。
  for (let index = 0; index < 10 && (store.jsonl.get(`${DIR}/sends.jsonl`) ?? []).length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(transport.sends.length, 1, '采集到新消息后应当自动发一条')
  assert.equal(transport.sends[0].text, '我看下连接池')
  assert.equal(judge.rounds.length, 1)
  const round = store.jsonl.get(`${DIR}/round.jsonl`)[0]
  assert.equal(round.verdict, 'sent')
  assert.equal(round.newCount, 1, '水位停在 1000，只有第二条算新的')
  assert.equal(store.text.get(`${DIR}/poll.log`).some((line) => line.includes('new msg')), true, '采集日志要落盘')
})

test('窗口到期后采集自退，不再空轮询', async () => {
  const store = openWindow()
  const transport = transportStub()
  let clock = new Date('2026-09-22T10:00:00')
  const scheduled = []
  const watcher = makeWatcher({
    store,
    transport,
    config: { opening: { enabled: false, text: 'hi' } },
    now: () => clock,
    schedule: (fn) => {
      scheduled.push(fn)
      return () => {}
    },
  })

  const started = await watcher.startWindow({ hours: 2 })
  assert.equal(started.window.endsAt, '2026-09-22 12:00:00')
  await tick()
  assert.equal((await watcher.status()).value.poll.running, true, '窗口内要继续轮询')
  assert.equal(scheduled.length, 1, '每一轮跑完排下一轮')

  // 越过 endsAt：下一次轮询跑完后应当自己停表（对齐 skill 的 watcher 自退）。
  clock = new Date('2026-09-22T12:30:00')
  scheduled[0]()
  await tick()

  const status = await watcher.status()
  assert.equal(status.value.poll.running, false, '窗口过期后不该继续轮询')
  assert.equal(scheduled.length, 1, '过期后不该再排新的一轮')
  assert.equal(status.value.phase, 'idle')
  assert.equal(store.text.get(`${DIR}/poll.log`).some((line) => line.includes('poller stop') && line.includes('窗口已过期')), true)
})

test('采集落盘跟着 watcher 注入的 env 走（不能各自算一份 home）', async () => {
  // 桩 store 尊重 env：dataRoot(env) 用 env 里的 USERPROFILE，不传参数时才用进程环境。
  const files = new Map()
  const jsonl = new Map()
  const text = new Map()
  const store = {
    files,
    jsonl,
    text,
    dataRoot: (env) => `${(env ?? process.env).USERPROFILE}/.dsh/popo-watcher`,
    groupDir: (root, group) => `${root}/${group}`,
    nowStamp: fakeStore().nowStamp,
    readJson: (file, fallback) => (files.has(file) ? { ok: true, value: files.get(file) } : { ok: false, value: fallback, error: 'ENOENT', code: 'ENOENT' }),
    writeJsonAtomic: (file, value) => {
      files.set(file, JSON.parse(JSON.stringify(value)))
      return { ok: true }
    },
    appendJsonl: (file, value) => {
      jsonl.set(file, [...(jsonl.get(file) ?? []), value])
      return { ok: true }
    },
    appendJsonlCapped: (file, value) => {
      jsonl.set(file, [...(jsonl.get(file) ?? []), value].slice(-500))
      return { ok: true }
    },
    appendLineCapped: (file, line) => {
      text.set(file, [...(text.get(file) ?? []), line].slice(-500))
      return { ok: true }
    },
    readJsonlTail: (file, limit = 20) => ({ ok: true, rows: (jsonl.get(file) ?? []).slice(-limit) }),
    readLineTail: (file, limit = 50) => ({ ok: true, lines: (text.get(file) ?? []).slice(-limit) }),
  }

  const transport = transportStub({ messages: messages(2) })
  const env = { USERPROFILE: 'C:/temp-home' }
  const cfg = { ...defaultConfig(), group: GROUP, opening: { enabled: false, text: 'x' } }
  const watcher = createWatcher({
    store,
    config: {
      defaultConfig: () => ({ ...cfg }),
      normalizeConfig: () => ({ config: { ...cfg }, warnings: [] }),
      applyPatch: (current, patch) => ({ config: { ...current, ...patch }, warnings: [] }),
    },
    env,
    now: () => new Date('2026-09-22T10:00:00'),
    getTransport: () => transport,
    schedule: () => () => {},
    judgeClient: judgeStub(),
    draftWriter: draftStub(),
  })

  await watcher.startWindow({ hours: 2 })
  for (let index = 0; index < 10 && !jsonl.has('C:/temp-home/.dsh/popo-watcher/1234567/messages.jsonl'); index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(
    jsonl.has('C:/temp-home/.dsh/popo-watcher/1234567/messages.jsonl'),
    true,
    '采集流水必须落在注入 env 的数据根下（曾经落到真实 home 去了）',
  )
  assert.equal(jsonl.has(`${DIR}/messages.jsonl`), false, '不该往别的 home 写')
  assert.equal(text.has('C:/temp-home/.dsh/popo-watcher/1234567/poll.log'), true)
})

test('发送成功但传输层没读到 msgId 时：仍算已发送，并把警告记进一轮流水（不重发）', async () => {
  const store = openWindow()
  const transport = transportStub({ sendResult: { ok: true, value: { msgId: '', unrecognized: true } } })
  const watcher = makeWatcher({ store, transport })

  const result = await watcher.runRound(messages())
  assert.equal(result.verdict, 'sent', '认不出 id 也要算发成功（重发比丢 id 危险）')
  assert.equal(transport.sends.length, 1)
  assert.equal(store.json.get(`${DIR}/state.json`).sentCount, 1, '已经发出去了，计数要落盘')

  const entry = store.jsonl.get(`${DIR}/round.jsonl`)[0]
  assert.equal(entry.verdict, 'sent')
  assert.deepEqual(entry.sendWarnings, ['send ack unrecognized: 已发送，但没读到 msgId（形状变了，记得核对 parser）'])
})

test('同一批新消息不会并行判两轮（单飞）', async () => {
  const store = openWindow()
  const transport = transportStub()
  const watcher = makeWatcher({ store, transport })

  // 并发触发：runRound 走内部串行队列，第二轮会因为"最后一条是自己"或时间间隔被挡住，
  // 但关键是不能出现两条都发出去的情况之外的竞态（这里断言不会重复发送同样的文本）。
  await Promise.all([watcher.runRound(messages()), watcher.runRound(messages())])
  const sends = store.jsonl.get(`${DIR}/sends.jsonl`) ?? []
  assert.ok(sends.length <= 1, `最多发一条，实际 ${sends.length} 条`)
})

test('sendNow 未标记 manual 时仍走自动守卫链，并记账', async () => {
  const store = openWindow()
  const transport = transportStub()
  const watcher = makeWatcher({ store, transport })

  const sent = await watcher.sendNow({ text: '手动一句话' })
  assert.equal(sent.ok, true)
  assert.equal(sent.stateWritten, true)
  assert.equal(transport.sends[0].text, '手动一句话')
  assert.equal(store.json.get(`${DIR}/state.json`).sentCount, 1)
  assert.equal(store.jsonl.get(`${DIR}/judge.jsonl`)[0].mode, 'send')

  // 20 秒最小间隔：紧接着再发要被拦住（守卫在 lib/guards.js）。
  const tooSoon = await watcher.sendNow({ text: '马上第二句' })
  assert.equal(tooSoon.ok, false)
  assert.equal(tooSoon.reason, 'too soon')
  assert.equal(transport.sends.length, 1)
})

test('页面手动连续发送无需等待或判读；自动回复仍不能接自己的话', async (t) => {
  const store = openWindow()
  const ownMessage = { ...messages(1)[0], from: 'u-self' }
  store.jsonl.set(`${DIR}/messages.jsonl`, [ownMessage])
  const transport = transportStub()
  const unexpected = () => assert.fail('手动路径不能调用判读')
  const judge = { available: unexpected, runDraft: unexpected, runRound: unexpected }
  const watcher = makeWatcher({ store, transport, judge })
  t.after(() => watcher.dispose())
  const handle = createRpcHandler({ watcher })

  const guarded = await watcher.sendNow({ text: '非手动调用' })
  assert.equal(guarded.reason, 'self spoke last')
  assert.equal(transport.sends.length, 0)

  const first = await handle('send.now', { text: '手动第一句' })
  assert.equal(first.ok, true)
  const early = await handle('send.now', { text: '立即第二句' })
  assert.equal(early.ok, true, '同一时刻也可以再次手动发送')
  assert.equal(transport.sends.length, 2)
  assert.equal(store.json.get(`${DIR}/state.json`).sentCount, 2)
  assert.equal((await watcher.runRound([ownMessage])).verdict, 'quiet')
  assert.equal(transport.sends.length, 2, '自动轮次不能因此接自己的话')
})

test('手动发送跳过窗口、历史、字数、时段、小时上限和演练，并保留原文及监控状态', async (t) => {
  for (const state of [null, { stopped: true, stoppedReason: '仅静音' }, { stopped: true, stoppedReason: '停止监控' }, { endsAt: '2026-09-22 09:30:00' }]) {
    const store = state === null ? fakeStore() : openWindow({ ...state, selfUid: '', openingSentAt: '2026-09-22 09:00:01' })
    const before = structuredClone(store.json.get(`${DIR}/state.json`) ?? {})
    // 即使消息记录不可读，手动发送也不依赖任何聊天上下文。
    let historyReads = 0
    store.readJsonlTail = () => { historyReads += 1; return { ok: false, rows: [] } }
    const transport = transportStub()
    const unexpected = () => assert.fail('手动发送不得调用 TypeSafe')
    const watcher = makeWatcher({ store, transport, judge: { available: unexpected, runDraft: unexpected }, config: {
      dryRun: true, maxChars: 10, hardMaxChars: 20,
      quietHours: { enabled: true, start: '09:00', end: '11:00' },
      hourlyCap: { enabled: true, max: 1 },
    } })
    t.after(() => watcher.dispose())
    const text = `  @${String.fromCharCode(0x6240, 0x6709, 0x4eba)} ${'长正文'.repeat(100)}\n原样保留  `
    const handle = createRpcHandler({ watcher })
    for (let n = 0; n < 2; n += 1) {
      const result = await handle('send.now', { text, opening: true })
      assert.equal(result.ok, true)
      assert.equal(result.value.dryRun, false, '即使演练开启也调用真实传输（此处为桩）')
    }
    assert.deepEqual(transport.sends, [{ group: GROUP, text }, { group: GROUP, text }])
    assert.equal(historyReads, 0, '手动发送不得读取消息历史')
    const after = store.json.get(`${DIR}/state.json`)
    for (const key of ['startedAt', 'endsAt', 'stopped', 'stoppedReason', 'openingSentAt']) assert.equal(after[key], before[key], key)
    assert.equal(after.sentCount, (before.sentCount ?? 0) + 2)
    assert.equal(after.sentMessages.at(-1).content, text)
    assert.equal(after.sentMessages.at(-1).opening, false, '手动消息不记为开场白')
    assert.equal((await watcher.status()).value.poll.running, false)
  }
})

test('手动发送的认证失败或超时只返回一次错误，不重试、不记成功流水', async (t) => {
  for (const [kind, error] of [['upstream', '请运行 popo-cli auth login'], ['timeout', 'popo-cli 超时']]) {
    const store = fakeStore()
    const transport = transportStub({ sendResult: { ok: false, kind, error } })
    const watcher = makeWatcher({ store, transport, config: { dryRun: true } })
    t.after(() => watcher.dispose())
    const result = await createRpcHandler({ watcher })('send.now', { text: '仅供桩验证' })
    assert.equal(result.ok, false)
    assert.ok(result.error.message.includes(error))
    assert.equal(typeof result.error.code, 'string')
    assert.deepEqual(result.error.details, {})
    assert.equal(transport.sends.length, 1)
    assert.equal(store.json.has(`${DIR}/state.json`), false)
    assert.equal(store.jsonl.has(`${DIR}/sends.jsonl`), false)
  }
})

test('手动发送仍要求非空正文和有效目标群', async (t) => {
  for (const [group, text] of [[GROUP, '   '], ['', '有内容'], ['invalid', '有内容']]) {
    const transport = transportStub()
    const watcher = makeWatcher({ store: fakeStore(), transport, config: { group } })
    t.after(() => watcher.dispose())
    assert.equal((await createRpcHandler({ watcher })('send.now', { text })).ok, false)
    assert.equal(transport.sends.length, 0)
  }
})

test('judgeNow：判读可用时给出 draft/round 两种结论，不可用时如实报错', async () => {
  const store = openWindow()
  const transport = transportStub()
  const good = makeWatcher({ store, transport })
  const drafted = await good.judgeNow({ draft: '这句话能发吗' })
  assert.equal(drafted.ok, true)
  assert.equal(drafted.mode, 'draft')
  assert.equal(drafted.draft, '这句话能发吗')

  const round = await good.judgeNow({})
  assert.equal(round.ok, true)
  assert.equal(round.mode, 'round')
  assert.equal(round.view.verdict, 'speak')

  const unavailable = makeWatcher({
    store: openWindow(),
    transport: transportStub(),
    judge: judgeStub({ available: { ok: false, error: '没有 TYPESAFE_API_KEY' } }),
  })
  const judged = await unavailable.judgeNow({ draft: 'x' })
  assert.equal(judged.ok, false)
  assert.match(judged.error, /判读失败|TYPESAFE_API_KEY/)
})
