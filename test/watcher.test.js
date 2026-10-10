/**
 * watcher 状态服务测试：字段快照、配置读写、降级、释放，以及"绝不抛错 / 绝不 reject"。
 *
 * 全部用桩依赖（不碰真实文件系统），因为 watcher 的契约是依赖注入。
 *
 * @module dsh-popo-watcher/test/watcher
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWatcher } from '../lib/watcher.js'
import * as configModule from '../lib/config.js'

/** 桩 store：记录写入（并同步进内存文件表，模拟真实持久化），读返回预设值。 */
function fakeStore({ files = {}, write = () => ({ ok: true }) } = {}) {
  const writes = []
  const table = { ...files }
  return {
    writes,
    files: table,
    dataRoot: () => 'C:/fake/.dsh/popo-watcher',
    groupDir: (root, group) => `${root}/${group}`,
    // 与真实 store.nowStamp 一致：用本地时间字段，不要用 toISOString（那是 UTC）。
    nowStamp: (date = new Date()) => {
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    },
    readJson: (file) => (Object.hasOwn(table, file) ? { ok: true, value: table[file] } : { ok: false, value: undefined, error: 'ENOENT', code: 'ENOENT' }),
    writeJsonAtomic: (file, value) => {
      writes.push({ file, value })
      const result = write(file, value)
      if (result?.ok !== false) table[file] = value
      return result
    },
  }
}

/** 桩 config 模块（纯函数，行为与真实实现同形）。 */
const fakeConfig = {
  defaultConfig: () => ({
    group: '1234567',
    intervalSec: 20,
    windowHours: 24,
    minGapSec: 20,
    autoResume: true,
    dryRun: false,
    judge: { enabled: true, model: 'jev-latest', unavailablePolicy: 'quiet' },
    llm: { provider: '', model: '' },
  }),
  normalizeConfig: (raw) => (raw === undefined || raw === null
    ? { config: fakeConfig.defaultConfig(), warnings: [] }
    : { config: { ...fakeConfig.defaultConfig(), ...raw }, warnings: [] }),
  applyPatch: (current, patch) => ({ config: { ...current, ...patch }, warnings: [] }),
}

const FIXED_NOW = () => new Date('2026-09-22T10:00:00')
const healthyTransport = { search: async () => ({ ok: true, value: { messages: [] } }) }

test('fresh install has no target and cannot query or send until configured', async (t) => {
  let calls = 0
  const watcher = createWatcher({
    store: fakeStore(), config: configModule, now: FIXED_NOW,
    keyResolver: async () => ({ key: '', source: 'none' }),
    transport: {
      search: async () => { calls++; return { ok: true, value: { messages: [] } } },
      send: async () => { calls++; return { ok: true } },
    },
  })
  t.after(() => watcher.dispose())
  assert.equal(watcher.getConfig().config.group, '')
  assert.deepEqual(configModule.normalizeConfig(configModule.defaultConfig()).warnings, [])
  assert.equal((await watcher.startWindow({ hours: 1 })).ok, false)
  assert.equal((await watcher.messages()).ok, false)
  assert.equal((await watcher.sendNow({ text: 'Synthetic test message' })).ok, false)
  assert.equal(calls, 0)
})

test('群消息直接返回服务端最近 30 条，补齐本地缺少的 10 条且不触发监控副作用', async (t) => {
  const remote = Array.from({ length: 30 }, (_, i) => ({ t_msg: 1000 + i, msgId: `remote-${i}`, content: `消息 ${i}` }))
  const cached = [...Array.from({ length: 10 }, (_, i) => ({ t_msg: i + 1, msgId: `old-${i}` })), ...remote.slice(10)]
  const store = fakeStore()
  store.readJsonlTail = () => ({ ok: true, rows: cached })
  let queries = 0
  const watcher = createWatcher({ store, config: fakeConfig, now: FIXED_NOW,
    schedule: () => assert.fail('查看消息不能启动定时采集'),
    judgeClient: { runRound: () => assert.fail('不能判读') },
    draftWriter: { write: () => assert.fail('不能生成回复') },
    transport: {
      search: async params => { queries++; assert.deepEqual(params, { group: '1234567', pageSize: 30 }); return { ok: true, value: { messages: remote } } },
      send: () => assert.fail('不能发送'),
    },
  })
  t.after(() => watcher.dispose())
  const before = (await watcher.status()).value.poll
  const result = await watcher.messages()
  assert.equal(result.ok, true)
  assert.equal(result.group, '1234567')
  assert.equal(result.fetchedAt, '2026-09-22 10:00:00')
  assert.deepEqual(result.rows.map(row => row.msgId), remote.map(row => row.msgId).reverse())
  assert.equal(result.rows.filter(row => !cached.some(old => old.msgId === row.msgId)).length, 10)
  assert.equal(remote[0].msgId, 'remote-0', '不原地修改传输层返回值')
  assert.equal(queries, 1)
  assert.deepEqual((await watcher.status()).value.poll, before)
  assert.equal(store.writes.length, 0)
})

test('群消息失败不退回本地记录，成功空列表与失败分开，异常永不 reject', async (t) => {
  const store = fakeStore()
  store.readJsonlTail = () => assert.fail('实时读取不得回退本地采集记录')
  let reply
  const watcher = createWatcher({ store, config: fakeConfig, transport: { search: async () => {
    if (reply instanceof Error) throw reply
    return reply
  } } })
  t.after(() => watcher.dispose())
  for (reply of [
    { ok: false, kind: 'timeout', error: '采集超时' },
    { ok: false, kind: 'auth', error: '请重新登录' },
    { ok: true, value: {} },
    { ok: true, value: { messages: [null] } },
    new Error('transport unavailable'),
  ]) {
    const result = await watcher.messages()
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    if (reply.error) assert.equal(result.error, reply.error)
  }
  reply = { ok: true, value: { messages: [] } }
  assert.deepEqual((await watcher.messages()).rows, [])
  assert.equal(store.writes.length, 0)
  assert.equal((await watcher.status()).value.poll.consecutiveFailures, 0)
})

test('慢消息读取不阻塞停止，换群或卸载后作废结果', async (t) => {
  const store = fakeStore()
  let complete
  const watcher = createWatcher({ store, config: fakeConfig,
    transport: { search: () => new Promise(resolve => { complete = resolve }) },
  })
  t.after(() => watcher.dispose())
  const first = watcher.messages()
  assert.equal((await watcher.stop()).ok, true)
  const writes = store.writes.length
  complete({ ok: true, value: { messages: [] } })
  assert.equal((await first).ok, true)
  assert.equal(store.writes.length, writes, '读取完成不能覆盖停止状态')
  const second = watcher.messages()
  await watcher.updateConfig({ group: '1234568' })
  complete({ ok: true, value: { messages: [] } })
  assert.equal((await second).ok, false)
  const third = watcher.messages()
  watcher.dispose()
  complete({ ok: true, value: { messages: [] } })
  assert.equal((await third).ok, false)
  assert.equal((await watcher.messages()).ok, false)
})

test('CLI 检查按需获取传输层，不开窗、不采集、不写状态，慢检查不阻塞停止', async (t) => {
  const store = fakeStore()
  let complete
  let checked = 0
  const watcher = createWatcher({ store, config: fakeConfig, getTransport: () => ({
    checkAuth: () => { checked += 1; return new Promise(resolve => { complete = resolve }) },
    search: () => assert.fail('检查不应采集'),
    send: () => assert.fail('检查不应发言'),
  }) })
  t.after(() => watcher.dispose())
  assert.equal(checked, 0)
  const checking = watcher.checkCli()
  assert.equal(checked, 1)
  assert.equal(store.writes.length, 0)
  assert.equal((await watcher.status()).value.poll.running, false)
  const stopped = await watcher.stop()
  assert.equal(stopped.ok, true)
  const writes = store.writes.length
  complete({ ok: true, value: { uid: 'demo' } })
  assert.deepEqual(await checking, { ok: true, value: { uid: 'demo' } })
  assert.equal(store.writes.length, writes)
  watcher.dispose()
  assert.equal((await watcher.checkCli()).ok, false)
})

test('CLI 检查的缺失和异常都返回失败结果', async (t) => {
  for (const getTransport of [() => null, () => { throw new Error('service unavailable') }, () => ({ checkAuth: async () => { throw new Error('check failed') } })]) {
    const watcher = createWatcher({ getTransport })
    t.after(() => watcher.dispose())
    const result = await watcher.checkCli()
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  }
})

test('配置状态：默认值 → 写盘失败但内存生效 → 重试保存成功', async (t) => {
  let writable = false
  const store = fakeStore({ write: () => writable ? { ok: true } : { ok: false, error: 'EACCES' } })
  const watcher = createWatcher({ store, config: configModule, now: FIXED_NOW })
  t.after(() => watcher.dispose())
  assert.equal(watcher.getConfig().configState, 'default')
  const failed = await watcher.updateConfig({ windowHours: 6 })
  assert.equal(failed.written, false)
  assert.equal(failed.configState, 'unsaved')
  assert.equal(watcher.getConfig().config.windowHours, 6)
  assert.equal((await watcher.status()).value.configState, 'unsaved')
  assert.equal(watcher.getConfig({ reload: true }).ok, false, 'reload 不得丢弃临时生效的配置')
  writable = true
  const retried = await watcher.updateConfig({})
  assert.equal(retried.configState, 'saved')
  assert.equal(retried.config.windowHours, 6)
  assert.deepEqual(retried.warnings, [])
})

test('配置读取失败禁止覆盖；显式重读后恢复，普通 get 不重复读盘', async (t) => {
  for (const code of ['EACCES', 'JSON_PARSE_ERROR']) {
    const store = fakeStore()
    const read = store.readJson
    let repaired = false
    let reads = 0
    store.readJson = (file) => {
      if (file.endsWith('/config.json')) {
        reads += 1
        return repaired ? { ok: true, value: { windowHours: 8 } } : { ok: false, code, error: `test ${code}` }
      }
      return read(file)
    }
    const watcher = createWatcher({ store, config: configModule, now: FIXED_NOW })
    t.after(() => watcher.dispose())
    assert.equal(watcher.getConfig().configState, 'error')
    assert.equal((await watcher.updateConfig({ dryRun: true })).ok, false)
    assert.equal(store.writes.length, 0)
    repaired = true
    assert.equal(watcher.getConfig().configState, 'error')
    assert.equal(reads, 1)
    const loaded = watcher.getConfig({ reload: true })
    assert.equal(loaded.configState, 'saved')
    assert.equal(loaded.config.windowHours, 8)
    assert.deepEqual(loaded.warnings, [])
    assert.equal(reads, 2)
  }
})

test('文件中的非法配置已在内存规范化时，不标记为已保存；保存后完成修正', async (t) => {
  const store = fakeStore({ files: { 'C:/fake/.dsh/popo-watcher/config.json': { intervalSec: 0 } } })
  const watcher = createWatcher({ store, config: configModule, now: FIXED_NOW })
  t.after(() => watcher.dispose())
  assert.equal(watcher.getConfig().configState, 'unsaved')
  assert.equal(watcher.getConfig().config.intervalSec, 20)
  const result = await watcher.updateConfig({})
  assert.equal(result.configState, 'saved')
  assert.equal(store.files['C:/fake/.dsh/popo-watcher/config.json'].intervalSec, 20)
})

test('getConfig 的可选入参保持 never-throw 契约', (t) => {
  const watcher = createWatcher({ store: fakeStore(), config: configModule, now: FIXED_NOW })
  t.after(() => watcher.dispose())
  assert.equal(watcher.getConfig(null).ok, true)
  const hostile = { get reload() { throw new Error('bad getter') } }
  assert.doesNotThrow(() => watcher.getConfig(hostile))
  assert.equal(watcher.getConfig(hostile).ok, false)
})

test('群与间隔：有效窗口和静音采集期间锁定，停止后可改，拒绝时不部分保存', async (t) => {
  const store = fakeStore({ files: {
    'C:/fake/.dsh/popo-watcher/config.json': { group: '1234567', opening: { enabled: false, text: '测试' } },
    'C:/fake/.dsh/popo-watcher/1234567/state.json': { startedAt: '2026-09-22 09:00:00', endsAt: '2026-09-22 11:00:00', stopped: false },
  } })
  const watcher = createWatcher({ store, config: configModule, now: FIXED_NOW, transport: healthyTransport, schedule: () => () => {}, autoRound: false })
  t.after(() => watcher.dispose())
  const blocked = await watcher.updateConfig({ group: '1234568', dryRun: true })
  assert.equal(blocked.ok, false)
  assert.equal(watcher.getConfig().config.dryRun, false)
  assert.equal(store.writes.length, 0)
  assert.equal(watcher.getConfig({ reload: true }).ok, false)
  assert.equal((await watcher.updateConfig({ group: '1234567', intervalSec: 20, dryRun: true })).ok, true, '相同值不算修改')
  await watcher.startWindow({ hours: 1 })
  await watcher.stop({ mode: 'mute' })
  assert.equal((await watcher.status()).value.poll.running, true)
  assert.equal((await watcher.updateConfig({ intervalSec: 30 })).ok, false)
  await watcher.stop({ mode: 'stop' })
  const saved = await watcher.updateConfig({ group: '1234568', intervalSec: 30 })
  assert.equal(saved.ok, true)
  assert.equal(saved.config.group, '1234568')
  assert.equal(saved.config.intervalSec, 30)
})

test('status 在没有任何状态文件时返回 idle 形状且 ok:true', async () => {
  const watcher = createWatcher({ store: fakeStore(), config: fakeConfig, now: FIXED_NOW })
  const result = await watcher.status()

  assert.equal(result.ok, true)
  assert.equal(result.value.phase, 'idle')
  assert.equal(result.value.group, '1234567')
  assert.equal(result.value.window.active, false)
  assert.equal(result.value.sends.count, 0)
  assert.equal(result.value.poll.lagSec, null)
  assert.equal(result.value.transport.ok, false, 'P0 没有接传输层，应如实报告')
  assert.deepEqual(result.value.errors, [])
  assert.equal(result.value.degraded.active, false)
})

test('status 读取 state.json / poller.json 并换算剩余时间与滞后', async () => {
  const files = {
    'C:/fake/.dsh/popo-watcher/1234567/state.json': {
      startedAt: '2026-09-22 09:00:00',
      endsAt: '2026-09-22 11:00:00',
      stopped: false,
      sentCount: 3,
      lastSendTimeLocal: '2026-09-22 09:30:00',
      sentMessages: [{ content: '最新一条' }],
      selfUid: 'u@example.com',
    },
    'C:/fake/.dsh/popo-watcher/1234567/poller.json': {
      lastSeenMsgTime: 1789000000000,
      updatedAt: '2026-09-22 09:59:30',
      watchedMsgs: 42,
      selfUid: 'u@example.com',
    },
  }
  const watcher = createWatcher({ store: fakeStore({ files }), config: fakeConfig, now: FIXED_NOW })
  const { value } = await watcher.status()

  assert.equal(value.phase, 'running')
  assert.equal(value.window.active, true)
  assert.equal(value.window.remainingSec, 3600)
  assert.equal(value.sends.count, 3)
  assert.equal(value.sends.lastSendContent, '最新一条')
  assert.equal(value.poll.lagSec, 30)
  assert.equal(value.poll.watchedMsgs, 42)
  assert.equal(value.selfUid, 'u@example.com')
})

test('窗口已过期 / 已静音时 phase 不是 running', async () => {
  const expired = {
    'C:/fake/.dsh/popo-watcher/1234567/state.json': { startedAt: '2026-09-21 09:00:00', endsAt: '2026-09-21 11:00:00', sentCount: 1 },
  }
  const a = createWatcher({ store: fakeStore({ files: expired }), config: fakeConfig, now: FIXED_NOW })
  assert.equal((await a.status()).value.phase, 'idle')

  const muted = {
    'C:/fake/.dsh/popo-watcher/1234567/state.json': { startedAt: '2026-09-22 09:00:00', endsAt: '2026-09-22 11:00:00', stopped: true },
  }
  const b = createWatcher({ store: fakeStore({ files: muted }), config: fakeConfig, now: FIXED_NOW })
  assert.equal((await b.status()).value.phase, 'idle')
  assert.equal((await b.status()).value.window.stopped, true)
})

test('config.get 缺文件时采用默认配置，不误报读取失败', async () => {
  const watcher = createWatcher({ store: fakeStore(), config: fakeConfig, now: FIXED_NOW })
  const result = watcher.getConfig()

  assert.equal(result.ok, true)
  assert.equal(result.config.group, '1234567')
  assert.equal(result.configState, 'default')
  assert.deepEqual(result.warnings, [], '缺配置采用默认值，不当成读取异常')
})

test('config.set 规范化 + 落盘，并且只改指定字段', async () => {
  const store = fakeStore()
  const watcher = createWatcher({ store, config: fakeConfig, now: FIXED_NOW })
  const result = await watcher.updateConfig({ dryRun: true })

  assert.equal(result.ok, true)
  assert.equal(result.config.dryRun, true)
  assert.equal(result.config.group, '1234567')
  assert.equal(result.written, true)
  assert.equal(result.configState, 'saved')
  assert.equal(store.writes.length, 1)
  assert.equal(store.writes[0].file, 'C:/fake/.dsh/popo-watcher/config.json')
})

test('写盘失败只记录告警，不抛错', async () => {
  const store = fakeStore({ write: () => ({ ok: false, error: 'EACCES' }) })
  const watcher = createWatcher({ store, config: fakeConfig, now: FIXED_NOW })
  const result = await watcher.updateConfig({ dryRun: true })

  assert.equal(result.ok, true)
  assert.equal(result.written, false)
  assert.equal(result.configState, 'unsaved')
  assert.ok(result.warnings.some((line) => line.includes('EACCES')))
})

test('startWindow 重算窗口、清 stopped、保留发言记录，并启动采集', async () => {
  const files = {
    'C:/fake/.dsh/popo-watcher/1234567/state.json': {
      startedAt: '2026-09-21 09:00:00',
      endsAt: '2026-09-21 11:00:00',
      stopped: true,
      stoppedAt: '2026-09-21 10:00:00',
      sentCount: 2,
      sentMessages: [{ content: '旧发言' }],
      openingSentAt: '2026-09-21 09:05:00',
      selfUid: 'u@example.com',
    },
  }
  const store = fakeStore({ files })
  const transport = { describe: () => ({ ok: true, cliPath: 'x', nodePath: 'y' }), search: async () => ({ ok: true, value: { uid: 'u@example.com', messages: [] } }) }
  const watcher = createWatcher({ store, config: fakeConfig, now: FIXED_NOW, getTransport: () => transport, schedule: () => () => {} })

  const result = await watcher.startWindow({ hours: 4 })
  assert.equal(result.ok, true)
  assert.equal(result.window.hours, 4)
  assert.equal(result.window.endsAt, '2026-09-22 14:00:00', 'endsAt 从当前时刻重算')

  // 采集启动后还会写 poller.json，所以这里按文件定位那次 state.json 写入。
  const written = store.writes.find((entry) => entry.file.endsWith('/state.json'))
  assert.ok(written !== undefined, '应当写 state.json')
  assert.equal(written.value.stopped, false, '新窗口必须清掉静音标记')
  assert.equal(written.value.sentCount, 2, '发言计数保留')
  assert.deepEqual(written.value.sentMessages, [{ content: '旧发言' }], '发言记录保留')
  assert.equal(written.value.openingSentAt, '2026-09-21 09:05:00', '开场白时间保留（新窗口自动重新放开一条由发送层判断）')
  assert.equal(written.value.selfUid, 'u@example.com', 'selfUid 保留')

  await new Promise((resolve) => setImmediate(resolve))
  const status = await watcher.status()
  assert.equal(status.value.phase, 'running')
  assert.equal(status.value.poll.running, true, '开窗后采集应当已启动')
  assert.equal(status.value.poll.lastError, null)
  assert.equal(status.value.selfUid, 'u@example.com', '采集回包里带回来的 uid 要写进水位')
})

test('首轮采集失败会关闭并持久化窗口，不排重试，重建实例也不会自动恢复', async (t) => {
  const store = fakeStore()
  const watcher = createWatcher({ store, config: fakeConfig, now: FIXED_NOW, getTransport: () => null, schedule: () => assert.fail('失败后不能排重试') })
  t.after(() => watcher.dispose())

  const started = await watcher.startWindow({ hours: 2 })
  assert.equal(started.ok, false)
  assert.match(started.error, /采集失败，已自动停止/)
  await new Promise((resolve) => setImmediate(resolve))

  const status = await watcher.status()
  assert.equal(status.value.phase, 'degraded')
  assert.equal(status.value.poll.consecutiveFailures, 1)
  assert.match(String(status.value.poll.lastError), /传输层不可用/)
  assert.equal(status.value.poll.running, false)
  assert.equal(status.value.window.stopped, true)
  const saved = store.files['C:/fake/.dsh/popo-watcher/1234567/state.json']
  assert.equal(saved.stopped, true)
  assert.match(saved.stoppedReason, /采集失败/)
  const reloaded = createWatcher({ store, config: fakeConfig, now: FIXED_NOW, transport: healthyTransport })
  t.after(() => reloaded.dispose())
  assert.equal((await reloaded.resume()).resumed, false)
  assert.equal(reloaded.status().value.window.collectionError, saved.collectionError)
  assert.equal(reloaded.status().value.phase, 'idle')
  assert.deepEqual(reloaded.status().value.degraded, { active: false, reason: null, since: null })
  assert.equal(reloaded.status().value.poll.consecutiveFailures, 0)
  assert.equal(reloaded.status().value.poll.lastError, null)
})

test('stop：mode=stop 停采集；mode=mute 只静音，采集继续', async () => {
  const files = {
    'C:/fake/.dsh/popo-watcher/1234567/state.json': { startedAt: '2026-09-22 09:00:00', endsAt: '2026-09-22 11:00:00', stopped: false, sentCount: 0 },
  }
  const store = fakeStore({ files })
  const watcher = createWatcher({ store, config: fakeConfig, now: FIXED_NOW, transport: healthyTransport, schedule: () => () => {} })

  await watcher.startWindow({ hours: 2 })
  const muted = await watcher.stop({ mode: 'mute', reason: '午休' })
  assert.equal(muted.ok, true)
  assert.equal(muted.mode, 'mute')
  assert.equal((await watcher.status()).value.poll.running, true, '静音不停止采集')

  const stopped = await watcher.stop({ mode: 'stop' })
  assert.equal(stopped.ok, true)
  const state = store.writes.at(-1).value
  assert.equal(state.stopped, true)
  assert.equal(state.stoppedReason, '停止监控')
  assert.equal((await watcher.status()).value.poll.running, false, 'stop 要停采集')
})

test('resume：窗口未过期且未静音时启动采集；过期/静音/从未开窗都不启动', async () => {
  const make = (state) => {
    const files = state === null ? {} : { 'C:/fake/.dsh/popo-watcher/1234567/state.json': state }
    const store = fakeStore({ files })
    return { store, watcher: createWatcher({ store, config: fakeConfig, now: FIXED_NOW, transport: healthyTransport, schedule: () => () => {} }) }
  }

  const fresh = make({ startedAt: '2026-09-22 09:00:00', endsAt: '2026-09-22 11:00:00', stopped: false })
  const resumed = await fresh.watcher.resume()
  assert.equal(resumed.ok, true)
  assert.equal(resumed.resumed, true)
  assert.equal((await fresh.watcher.status()).value.poll.running, true)

  const expired = make({ startedAt: '2026-09-21 09:00:00', endsAt: '2026-09-21 11:00:00', stopped: false })
  assert.equal((await expired.watcher.resume()).resumed, false)
  assert.equal((await expired.watcher.status()).value.poll.running, false)

  const mutedState = make({ startedAt: '2026-09-22 09:00:00', endsAt: '2026-09-22 11:00:00', stopped: true })
  assert.equal((await mutedState.watcher.resume()).resumed, false)

  const never = make(null)
  const neverResult = await never.watcher.resume()
  assert.equal(neverResult.resumed, false)
  assert.match(neverResult.reason, /从未开窗/)
})

test('依赖全坏时 status 也返回结果对象而不是抛错', async () => {
  const hostile = {
    dataRoot: () => { throw new Error('boom') },
    groupDir: () => { throw new Error('boom') },
    nowStamp: () => { throw new Error('boom') },
    readJson: () => { throw new Error('boom') },
    writeJsonAtomic: () => { throw new Error('boom') },
  }
  const watcher = createWatcher({ store: hostile, config: fakeConfig, now: FIXED_NOW })
  const result = await watcher.status()
  assert.equal(typeof result, 'object')
  assert.equal(result.ok, true, '快照本身仍然可用（字段降级）')
  assert.equal(result.value.group, '1234567')
})

test('dispose 幂等，且释放后拒绝新的写操作', async () => {
  const watcher = createWatcher({ store: fakeStore(), config: fakeConfig, now: FIXED_NOW })
  watcher.dispose()
  watcher.dispose()

  const result = await watcher.updateConfig({ dryRun: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /已释放/)
  assert.equal((await watcher.status()).value.phase, 'disposed')
})

test('串行队列：并发写按序完成，前一个失败不阻塞后一个', async () => {
  const order = []
  const watcher = createWatcher({
    store: fakeStore({
      write: () => {
        order.push('write')
        return order.length === 1 ? { ok: false, error: 'first fails' } : { ok: true }
      },
    }),
    config: fakeConfig,
    now: FIXED_NOW,
  })

  const [first, second] = await Promise.all([
    watcher.updateConfig({ dryRun: true }),
    watcher.updateConfig({ dryRun: false }),
  ])
  assert.equal(first.written, false)
  assert.equal(second.written, true)
  assert.deepEqual(order, ['write', 'write'])
})
