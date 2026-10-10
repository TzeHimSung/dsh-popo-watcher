/**
 * `importLegacy` 测试：从 skill（popo-watcher）的数据目录导入历史。
 *
 * 契约（也是这个功能的安全边界）：
 * - **只补缺，绝不覆盖**：目标文件已存在就跳过并如实说明；
 * - **不导入窗口**：导入完是"已停止"状态，不点开窗就不会采集、不会发言；
 * - 字段名对齐（skill 的 `msg_id` → 插件的 `msgId`），坏行/坏条目跳过而不是整体失败。
 *
 * 桩 store 是**统一文本表**（对齐 lib/store.js 的真实语义：json 与文本读的是同一批文件），
 * 不碰真实数据目录。
 *
 * @module dsh-popo-watcher/test/import-legacy
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { defaultConfig } from '../lib/config.js'
import { createWatcher, LEGACY_DEFAULT_DIR } from '../lib/watcher.js'

const ROOT = 'C:/fake/.dsh/popo-watcher'
const DIR = `${ROOT}/1234567`
const FROM = 'D:/legacy'

/** 桩 store：一张文本表，json 走解析（与真实 store 同语义）。 */
function fakeStore(seed = {}) {
  const texts = new Map(Object.entries(seed))
  const writes = []
  return {
    texts,
    writes,
    dataRoot: () => ROOT,
    groupDir: (root, group) => `${root}/${group}`,
    nowStamp: () => '2026-09-22 10:00:00',
    readText: (file) => (texts.has(file) ? { ok: true, value: texts.get(file) } : { ok: false, error: 'ENOENT' }),
    writeText: (file, value) => {
      texts.set(file, String(value))
      return { ok: true }
    },
    readJson: (file, fallback) => {
      if (!texts.has(file)) return { ok: false, value: fallback, error: 'ENOENT', code: 'ENOENT' }
      try {
        return { ok: true, value: JSON.parse(texts.get(file)) }
      } catch (error) {
        return { ok: false, value: fallback, error: `JSON 解析失败: ${error.message}` }
      }
    },
    writeJsonAtomic: (file, value) => {
      writes.push({ file, value })
      texts.set(file, JSON.stringify(value, null, 2))
      return { ok: true }
    },
    json: (file) => JSON.parse(texts.get(file)),
  }
}

/** skill 侧的真实形状（字段名与 popo-watcher 一致）。 */
const LEGACY_STATE = {
  group: '1234567',
  groupName: '示例讨论组',
  selfUid: 'demo-user@example.com',
  minGapSec: 20,
  startedAt: '2026-09-21 19:32:15',
  endsAt: '2026-10-01 19:32:15',
  stopped: false,
  openingSentAt: '2026-09-21 19:32:24',
  sentCount: 16,
  lastSendTimeLocal: '2026-09-21 19:37:45',
  lastSendEpochMs: 1789990665983,
  sentMessages: [
    { msgId: 'm1', at: '2026-09-20 20:06:28', content: '大家好', opening: true },
    { msgId: 'm2', at: '2026-09-20 20:08:11', content: '可以先用示例数据验证效果', opening: false },
    { broken: true },
  ],
}

const LEGACY_SEED = {
  [`${FROM}/state.json`]: JSON.stringify(LEGACY_STATE),
  [`${FROM}/poller-state.json`]: JSON.stringify({ lastSeenMsgTime: 1789991459992, updatedAt: '2026-09-21 19:57:32' }),
  [`${FROM}/messages.jsonl`]: [
    JSON.stringify({ t_msg: 1789896868441, time: '2026-09-20 17:34:28', from: 'u-a', name: '张三', msg_id: 'x1', content: '示例模型应该选哪一个' }),
    '{ 坏行',
    JSON.stringify({ t_msg: 1789896887482, time: '2026-09-20 17:34:47', from: 'u-b', name: '李四', msg_id: 'x2', content: '怎么上下文窗口这么小' }),
  ].join('\n'),
  [`${FROM}/sends.jsonl`]: [
    JSON.stringify({ at: '2026-09-20 20:06:28', msgId: 'm1', group: '1234567', opening: true, content: '大家好' }),
    JSON.stringify({ at: '2026-09-20 20:08:11', msgId: 'm2', group: '1234567', opening: false, content: '可以先用示例数据验证效果' }),
  ].join('\n'),
}

/** 造 watcher。 */
function makeWatcher(storeStub) {
  const cfg = { ...defaultConfig(), group: '1234567' }
  return createWatcher({
    store: storeStub,
    config: {
      defaultConfig: () => ({ ...cfg }),
      normalizeConfig: () => ({ config: { ...cfg }, warnings: [] }),
      applyPatch: (current, patch) => ({ config: { ...current, ...patch }, warnings: [] }),
    },
    now: () => new Date('2026-09-22T10:00:00'),
    keyResolver: async () => ({ key: '', source: 'none' }),
  })
}

test('导入：身份/发言/水位/两份流水都进来，窗口不进来，坏行跳过', async () => {
  const storeStub = fakeStore({ ...LEGACY_SEED })
  const watcher = makeWatcher(storeStub)

  const report = await watcher.importLegacy({ from: FROM })
  assert.equal(report.ok, true)
  assert.equal(report.group, '1234567')
  assert.equal(report.from, FROM)

  assert.equal(report.imported.state.selfUid, 'demo-user@example.com')
  assert.equal(report.imported.state.sentMessages, 2, '坏条目丢掉')
  assert.equal(report.imported.poller.lastSeenMsgTime, 1789991459992)
  assert.equal(report.imported.messages.rows, 2, '坏行跳过')
  assert.equal(report.imported.sends.rows, 2)
  assert.deepEqual(report.skipped, {})

  const state = storeStub.json(`${DIR}/state.json`)
  assert.equal(state.stopped, true, '导入完必须是"已停止"，不点开窗就不会发言')
  assert.equal(state.stoppedReason, '导入完成，等开窗')
  assert.equal(state.openingSentAt, null, '开场白不跟着旧窗口过来')
  assert.equal(Object.hasOwn(state, 'endsAt'), false, '不导入窗口（endsAt/startedAt 都不带）')
  assert.equal(Object.hasOwn(state, 'startedAt'), false)
  assert.equal(state.sentMessages[0].atMs > 0, true, '缺 atMs 时从 at 反推')

  const messages = storeStub.texts.get(`${DIR}/messages.jsonl`)
  assert.match(messages, /"msgId":"x2"/, 'skill 的 msg_id 统一成 msgId')
  assert.equal(messages.includes('坏行'), false)
  assert.equal(storeStub.texts.get(`${DIR}/sends.jsonl`).split('\n').filter(Boolean).length, 2)

  // 导入完的状态：未开窗（窗口没进来），且是"已停止"。
  const snapshot = await watcher.status()
  assert.equal(snapshot.value.phase, 'idle')
  assert.equal(snapshot.value.window.stopped, true)
  assert.equal(snapshot.value.selfUid, 'demo-user@example.com')
})

test('导入：目标已有文件时逐个跳过，且不覆盖一个字', async () => {
  const existing = {
    [`${DIR}/state.json`]: JSON.stringify({ group: '1234567', stopped: false, sentCount: 1 }),
    [`${DIR}/poller.json`]: JSON.stringify({ lastSeenMsgTime: 111, updatedAt: '2026-09-22 09:00:00' }),
    [`${DIR}/messages.jsonl`]: `${JSON.stringify({ t_msg: 5, content: '已有的' })}\n`,
    [`${DIR}/sends.jsonl`]: `${JSON.stringify({ at: '2026-09-22 09:00:00', content: '已有的发言' })}\n`,
  }
  const storeStub = fakeStore({ ...LEGACY_SEED, ...existing })
  const watcher = makeWatcher(storeStub)

  const report = await watcher.importLegacy({ from: FROM })
  assert.equal(report.ok, true)
  assert.deepEqual(report.imported, {}, '目标文件都在，就什么都不导')
  assert.match(report.skipped.state, /未覆盖/)
  assert.match(report.skipped.poller, /未覆盖/)
  assert.match(report.skipped.messages, /未覆盖/)
  assert.match(report.skipped.sends, /未覆盖/)

  for (const [file, content] of Object.entries(existing)) {
    assert.equal(storeStub.texts.get(file), content, `${file} 必须原样不动`)
  }

  // 只缺一半时才补一半：把消息流水删掉，只补它，别的仍然跳过。
  storeStub.texts.delete(`${DIR}/messages.jsonl`)
  const partial = await watcher.importLegacy({ from: FROM })
  assert.equal(partial.ok, true)
  assert.deepEqual(Object.keys(partial.imported), ['messages'])
  assert.match(storeStub.texts.get(`${DIR}/messages.jsonl`), /"msgId":"x2"/)
  assert.equal(storeStub.texts.get(`${DIR}/state.json`), existing[`${DIR}/state.json`])
})

test('导入：源目录不可读时如实失败，不写任何东西', async () => {
  const storeStub = fakeStore()
  const watcher = makeWatcher(storeStub)

  const missing = await watcher.importLegacy({ from: 'D:/nope' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /state\.json/)
  assert.equal(storeStub.texts.size, 0)

  // 有 state.json 但没有水位与流水：只导身份，其余如实标成"跳过"
  const partial = fakeStore({ [`${FROM}/state.json`]: JSON.stringify({ selfUid: 'u', sentMessages: [] }) })
  const partialReport = await makeWatcher(partial).importLegacy({ from: FROM })
  assert.equal(partialReport.ok, true)
  assert.equal(partialReport.imported.state.selfUid, 'u')
  assert.match(partialReport.skipped.poller, /没有可用/)
  assert.match(partialReport.skipped.messages, /不可读/)
})

test('导入：既认 <run>/<group>/ 也认直接把源指到群目录', async () => {
  // skill 的真实布局：<run>/1234567/state.json
  const nested = {}
  for (const [file, content] of Object.entries(LEGACY_SEED)) nested[file.replace(`${FROM}/`, `${FROM}/1234567/`)] = content

  const fromRoot = await makeWatcher(fakeStore({ ...nested })).importLegacy({ from: FROM })
  assert.equal(fromRoot.ok, true)
  assert.equal(fromRoot.from, `${FROM}/1234567`, '自动认到群子目录')
  assert.equal(fromRoot.imported.messages.rows, 2)

  const fromGroupDir = await makeWatcher(fakeStore({ ...nested })).importLegacy({ from: `${FROM}/1234567` })
  assert.equal(fromGroupDir.ok, true)
  assert.equal(fromGroupDir.from, `${FROM}/1234567`)

  // 路径末尾的斜杠不该影响判定
  const withSlash = await makeWatcher(fakeStore({ ...nested })).importLegacy({ from: `${FROM}/` })
  assert.equal(withSlash.ok, true)
})

test('导入：未指定来源时拒绝读取历史目录', async () => {
  assert.equal(LEGACY_DEFAULT_DIR, '')
  const result = await makeWatcher(fakeStore({})).importLegacy({})
  assert.equal(result.ok, false)
  assert.match(result.error, /请指定历史数据源目录/)
})

test('导入：store 全坏也不抛（never-throw）', async () => {
  const hostile = {
    dataRoot: () => { throw new Error('boom') },
    groupDir: () => { throw new Error('boom') },
    readJson: () => { throw new Error('boom') },
    writeJsonAtomic: () => { throw new Error('boom') },
    readText: () => { throw new Error('boom') },
    writeText: () => { throw new Error('boom') },
    nowStamp: () => { throw new Error('boom') },
  }
  const watcher = makeWatcher(hostile)
  const result = await watcher.importLegacy({ from: FROM })
  assert.equal(typeof result, 'object')
  assert.equal(result.ok, false)
})
