import { memoryStore as fakeStore } from './helpers/memory-store.js'
/**
 * 长时间尺度测试（soak）：把 2000+ 轮塞进几秒钟，验证"守卫在几分钟之后还成立"。
 *
 * 为什么需要它：单测只跑一两轮，看不到"跑到第 1000 轮时条目上限/每小时上限/最小间隔还灵不灵"。
 * 这里用**假时钟 + 真 sender/guards**，每轮前进一步 20 秒、每轮都有新消息（最激进的开口场景）：
 * - 每小时上限（6/小时）必须按滑动一小时真的在拦；
 * - 最小间隔（20 秒）不能被绕过；
 * - `round.jsonl` 与 `state.json.sentMessages` 必须落在上限内（长期开窗不会无限涨）。
 *
 * 仍然零依赖、不联网、不碰真实数据目录。
 *
 * @module dsh-popo-watcher/test/soak
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { defaultConfig } from '../lib/config.js'
import { createWatcher } from '../lib/watcher.js'

const ROOT = 'C:/fake/.dsh/popo-watcher'
const DIR = `${ROOT}/1234567`

/** 桩 store：json 与 jsonl 两张内存表（jsonl 的 capped 写入同样裁行）。 */

/** 判读桩：永远说"点名我们、可以接话"。 */
const judgeClient = {
  available: async () => ({ ok: true }),
  runRound: async () => ({
    ok: true,
    answers: {
      kind: { type: 'choice', choice: 'question', probabilities: { question: 0.9 }, confidence: 0.8 },
      addressed_to_us: { type: 'noul', noul: 0.9 },
      open_question_for_us: { type: 'noul', noul: 0.9 },
      emotional_or_conflict: { type: 'noul', noul: 0.1 },
      filler_only: { type: 'noul', noul: 0.1 },
      asks_reader_to_act: { type: 'noul', noul: 0.05 },
    },
  }),
  runDraft: async () => ({ ok: true, answers: {} }),
}

/** 造一台"一直在水群"的 watcher（假时钟 + 桩传输 + 桩判读 + 桩文案）。 */
function makeSoakWatcher(overrides = {}) {
  const store = fakeStore()
  const state = { clock: new Date('2026-09-22T10:00:00'), sends: [], store }
  const transport = {
    describe: () => ({ ok: true, cliPath: 'x', nodePath: 'y' }),
    search: async () => ({ ok: true, value: { uid: 'u-self', messages: [] } }),
    send: async ({ text }) => {
      state.sends.push({ at: new Date(state.clock.getTime()), text })
      return { ok: true, value: { msgId: `mid-${state.sends.length}` } }
    },
  }
  const cfg = {
    ...defaultConfig(),
    group: '1234567',
    opening: { enabled: false, text: 'hi' },
    minGapSec: 20,
    ...overrides,
  }
  const watcher = createWatcher({
    store,
    config: {
      defaultConfig: () => ({ ...cfg }),
      normalizeConfig: () => ({ config: { ...cfg }, warnings: [] }),
      applyPatch: (current, patch) => ({ config: { ...current, ...patch }, warnings: [] }),
    },
    now: () => state.clock,
    getTransport: () => transport,
    // 不进真定时器：这个测试自己一步一步推进时钟（否则 20 秒一轮的定时器会拖着测试进程不放）。
    schedule: () => () => {},
    keyResolver: async () => ({ key: '', source: 'none' }),
    judgeClient,
    draftWriter: { write: async () => ({ ok: true, text: '我看下连接池', model: 'stub' }) },
  })
  return { watcher, state, store }
}

/** 跑 rounds 轮：每轮时钟前进 20 秒、写进一条新消息、触发一轮判读。 */
async function runRounds(harness, rounds) {
  const { watcher, state, store } = harness
  for (let index = 0; index < rounds; index += 1) {
    state.clock = new Date(state.clock.getTime() + 20_000)
    const message = {
      t_msg: state.clock.getTime(),
      time: store.nowStamp(state.clock),
      from: 'u-b',
      name: '李四',
      msgId: `m${index}`,
      content: `第 ${index} 条`,
    }
    store.jsonl.set(`${DIR}/messages.jsonl`, [...(store.jsonl.get(`${DIR}/messages.jsonl`) ?? []), message].slice(-5000))
    await watcher.runRound([message])
  }
}

test('soak A：2100 轮（≈11.7 小时）之后，每小时上限与最小间隔仍然成立', async () => {
  const harness = makeSoakWatcher({ hourlyCap: { enabled: true, max: 6 } })
  const { watcher, state, store } = harness
  const started = await watcher.startWindow({ hours: 24 })
  assert.equal(started.ok, true)

  const ROUNDS = 2100
  await runRounds(harness, ROUNDS)

  const roundRows = store.jsonl.get(`${DIR}/round.jsonl`) ?? []
  const sendRows = store.jsonl.get(`${DIR}/sends.jsonl`) ?? []
  const saved = store.json.get(`${DIR}/state.json`)

  // round.jsonl 有条目上限（2000），但每轮都判过。
  assert.equal(roundRows.length, 2000, `round.jsonl 应当被压到 2000 行，实际 ${roundRows.length}`)
  assert.equal(roundRows.at(-1).newCount, 1)

  // 真的发出去了，但被每小时上限压住：≈11.7 小时 × 6 条/小时 → 最多 72 条。
  assert.ok(state.sends.length > 0, '这么多次开口机会，不该一条都没发')
  assert.ok(state.sends.length <= 72, `每小时上限 6 条，最多 72 条，实际 ${state.sends.length}`)
  assert.equal(sendRows.length, state.sends.length, '发言流水与真实发送次数一致')

  // 任意滑动一小时不超过 6 条（用真实发送时刻重算，不信内部计数）。
  for (const send of state.sends) {
    const windowStart = send.at.getTime() - 3600_000
    const inWindow = state.sends.filter((other) => other.at.getTime() > windowStart && other.at.getTime() <= send.at.getTime()).length
    assert.ok(inWindow <= 6, `${send.at.toISOString()} 前一小时内有 ${inWindow} 条，超过上限 6`)
  }

  // 最小间隔 20 秒：相邻两条至少差 20 秒。
  for (let index = 1; index < state.sends.length; index += 1) {
    const gap = (state.sends[index].at.getTime() - state.sends[index - 1].at.getTime()) / 1000
    assert.ok(gap >= 20, `第 ${index} 条与上一条只差 ${gap}s，低于 minGapSec=20`)
  }

  // 状态快照仍然自洽（长时间跑完不崩、字段还在）。
  const status = await watcher.status()
  assert.equal(status.ok, true)
  assert.equal(status.value.sends.count, saved.sentCount)
})

test('soak B：2500 轮满速发言之后，state.json / sends.jsonl / round.jsonl 都落在上限内', async () => {
  // 关掉每小时上限：每一轮都会真的发（最快速度压测条目上限）。
  const harness = makeSoakWatcher({ hourlyCap: { enabled: false, max: 6 } })
  const { watcher, state, store } = harness
  await watcher.startWindow({ hours: 24 })

  const ROUNDS = 2500
  await runRounds(harness, ROUNDS)

  const saved = store.json.get(`${DIR}/state.json`)
  assert.equal(state.sends.length, ROUNDS, '没有每小时上限时每轮都该发出去')
  assert.equal(saved.sentCount, ROUNDS, 'sentCount 是累计值，不设上限')
  assert.equal(saved.sentMessages.length, 1000, `sentMessages 应当被压到 1000 条，实际 ${saved.sentMessages.length}`)
  assert.equal(saved.sentMessages.at(-1).content, '我看下连接池', '保留的是最新的那批')
  assert.equal((store.jsonl.get(`${DIR}/sends.jsonl`) ?? []).length, 2000, 'sends.jsonl 也应当被压到 2000 行')
  assert.equal((store.jsonl.get(`${DIR}/round.jsonl`) ?? []).length, 2000)
})
