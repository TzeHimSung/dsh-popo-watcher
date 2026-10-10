/**
 * RPC 处理器测试：端点表、信封形状、参数校验，以及"处理器绝不抛错"
 * （处理器一旦把异常漏到传输层，可能在宿主里变成未处理 rejection）。
 *
 * @module dsh-popo-watcher/test/rpc
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHANNEL, createRpcHandler, registerRpc, rpcFail } from '../lib/rpc.js'

test('models.list：只调用目录读取器，部分失败保持成功信封，可仅刷新判读目录', async () => {
  const calls = []
  const value = { llm: { ok: true, providers: [], defaultSelection: null }, judge: { ok: false, models: [], error: '缺凭证' } }
  const handle = createRpcHandler({
    watcher: new Proxy({}, { get: () => assert.fail('列表请求不访问 watcher 或消息') }),
    listModels: async options => { calls.push(options); return value },
  })
  assert.deepEqual(await handle('models.list', {}), { ok: true, value })
  await handle('models.list', { scope: 'judge' })
  assert.deepEqual(calls, [{ scope: 'all' }, { scope: 'judge' }])
  assert.equal((await handle('models.list', { scope: 'invalid' })).ok, false)
  assert.equal(calls.length, 2)
  assert.equal((await createRpcHandler()('models.list', {})).ok, false)
  const failed = await createRpcHandler({ listModels: () => { throw new Error('offline') } })('models.list', {})
  assert.equal(failed.ok, false)
  assert.equal(typeof failed.error.code, 'string')
})

/** 正常 watcher 桩。 */
const goodWatcher = {
  status: async () => ({ ok: true, value: { phase: 'idle', group: '1234567' } }),
  getConfig: () => ({ ok: true, config: { group: '1234567', dryRun: false }, warnings: ['w'] }),
  updateConfig: async (patch) => ({ ok: true, config: { group: '1234567', ...patch }, warnings: [], written: true }),
}

test('status 返回 watcher 的快照', async () => {
  const handle = createRpcHandler({ watcher: goodWatcher })
  const result = await handle('status', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.phase, 'idle')
})

test('所有失败回包携带 Connection 要求的 code/message/details，status 失败也规范化', async () => {
  const handle = createRpcHandler({ watcher: { status: () => ({ ok: false, error: '状态读取失败' }) } })
  const results = [rpcFail('拒绝'), await handle('status', {}), await handle('unknown', {})]
  for (const result of results) {
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'popo-watcher/error')
    assert.equal(typeof result.error.message, 'string')
    assert.deepEqual(result.error.details, {})
  }
  assert.equal(results[1].error.message, '状态读取失败')
})

test('cli.check 区分检查完成和健康状态，只回显提示，不透传凭证', async () => {
  let response = { ok: false, error: '请运行 popo-cli auth login' }
  const handle = createRpcHandler({ watcher: { checkCli: async () => response } })
  assert.deepEqual(await handle('cli.check', {}), { ok: true, value: { healthy: false, message: response.error } })
  response = { ok: true, value: { uid: 'demo@example.com', access_token: 'never-expose-this' } }
  const healthy = await handle('cli.check', {})
  assert.equal(healthy.value.healthy, true)
  assert.match(healthy.value.message, /demo@example.com/)
  assert.doesNotMatch(JSON.stringify(healthy), /never-expose-this/)
  assert.deepEqual(Object.keys(healthy.value).sort(), ['healthy', 'message'])
  const missing = await createRpcHandler()('cli.check', {})
  assert.equal(missing.ok, false)
  const throwing = createRpcHandler({ watcher: { checkCli: async () => { throw new Error('offline') } } })
  assert.equal((await throwing('cli.check', {})).ok, false)
})

test('config.get / config.set 的信封与校验', async () => {
  const handle = createRpcHandler({ watcher: goodWatcher })

  const got = await handle('config.get', {})
  assert.equal(got.ok, true)
  assert.equal(got.value.config.group, '1234567')
  assert.deepEqual(got.value.warnings, ['w'])

  const set = await handle('config.set', { patch: { dryRun: true } })
  assert.equal(set.ok, true)
  assert.equal(set.value.config.dryRun, true)
  assert.equal(set.value.written, true)

  for (const bad of [undefined, null, 'x', 42]) {
    const rejected = await handle('config.set', { patch: bad })
    assert.equal(rejected.ok, false)
    assert.match(rejected.error.message, /patch/)
  }
})

test('配置状态与显式 reload 通过 RPC 传递，旧字段保持兼容', async () => {
  const reads = []
  const handle = createRpcHandler({ watcher: {
    getConfig: (options) => { reads.push(options); return { ok: true, config: {}, warnings: [], configState: 'default' } },
    updateConfig: async () => ({ ok: true, config: {}, warnings: ['EACCES'], configState: 'unsaved', written: false }),
  } })
  assert.equal((await handle('config.get', { reload: true })).value.configState, 'default')
  assert.deepEqual(reads, [{ reload: true }])
  assert.equal((await handle('config.set', { patch: {} })).value.configState, 'unsaved')
})

test('未知端点与缺端点名都返回失败信封', async () => {
  const handle = createRpcHandler({ watcher: goodWatcher })
  assert.equal((await handle('nope', {})).ok, false)
  assert.match((await handle('nope', {})).error.message, /未知端点/)
  assert.equal((await handle('', {})).ok, false)
  assert.equal((await handle(undefined, {})).ok, false)
})

test('importLegacy：把 from 透给 watcher，并回传导入/跳过明细', async () => {
  const calls = []
  const watcher = {
    importLegacy: async (params) => {
      calls.push(params)
      if (params.from === 'bad') return { ok: false, error: '源目录里没有可读的 state.json：bad' }
      return {
        ok: true,
        group: '1234567',
        from: params.from ?? '',
        imported: { state: { sentMessages: 16 }, poller: { lastSeenMsgTime: 1789991459992 } },
        skipped: {},
      }
    },
  }
  const handle = createRpcHandler({ watcher })

  const done = await handle('importLegacy', { from: 'D:/legacy' })
  assert.equal(done.ok, true)
  assert.deepEqual(calls[0], { from: 'D:/legacy' })
  assert.equal(done.value.imported.poller.lastSeenMsgTime, 1789991459992)
  assert.deepEqual(done.value.skipped, {})

  // 不给 from 就用默认目录（由 watcher 决定，RPC 层不硬编码路径）
  await handle('importLegacy', {})
  assert.deepEqual(calls[1], {})

  const failed = await handle('importLegacy', { from: 'bad' })
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /state\.json/)
})

test('key.set / key.clear / key.status：只回状态，绝不回显 key', async () => {
  const calls = []
  const watcher = {
    keyStatus: async () => ({ ok: true, configured: true, source: 'file', stored: true }),
    setKey: async (key) => { calls.push(['set', key]); return { ok: true, configured: true, source: 'file' } },
    clearKey: async () => { calls.push(['clear']); return { ok: true, configured: false, source: 'none', stored: false } },
  }
  const handle = createRpcHandler({ watcher })

  const status = await handle('key.status', {})
  assert.equal(status.ok, true)
  assert.deepEqual(status.value, { configured: true, source: 'file', stored: true })

  const secret = 'ts_live_abcdef123456'
  const saved = await handle('key.set', { key: `  ${secret}  ` })
  assert.equal(saved.ok, true)
  assert.deepEqual(calls[0], ['set', `  ${secret}  `], '原样交给 watcher 清洗')
  assert.equal(JSON.stringify(saved).includes(secret), false, '返回值里绝不能出现 key')

  const cleared = await handle('key.clear', {})
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value.configured, false)
  assert.equal(JSON.stringify(cleared).includes(secret), false)

  // 空 key / 带换行的 key 在 RPC 层就拒（不用麻烦 watcher）
  for (const bad of ['', '   ', 'a\nb']) {
    const rejected = await handle('key.set', { key: bad })
    assert.equal(rejected.ok, false, `${JSON.stringify(bad)} 应当被拒`)
  }
  assert.equal(calls.length, 2, '非法输入不该打到 watcher')

  const unavailable = createRpcHandler({ watcher: { keyStatus: async () => { throw new Error('boom') } } })
  assert.equal((await unavailable('key.status', {})).ok, false)
  assert.match((await unavailable('key.status', {})).error.message, /boom/)
})

test('watcher 缺少某个方法时该端点报"watcher 不可用"，而不是假成功', async () => {
  // P0 时代的断言已经作废：judge.now / send.now / messages / sends / log 都已实现，
  // 现在缺的是 watcher 上的方法，而不是端点本身。
  const handle = createRpcHandler({ watcher: goodWatcher })
  for (const endpoint of ['judge.now', 'send.now', 'sends', 'log', 'messages', 'key.status', 'key.set', 'key.clear', 'importLegacy']) {
    const result = await handle(endpoint, {})
    assert.equal(result.ok, false, `${endpoint} 应当失败`)
    assert.match(result.error.message, /watcher 不可用/)
  }
})

test('judge.now / send.now 走 watcher 的方法并按信封返回', async () => {
  const calls = []
  const watcher = {
    judgeNow: async (params) => { calls.push(['judge.now', params]); return { ok: true, mode: 'draft', draft: params.draft, answers: { a: 1 } } },
    sendNow: async (params) => { calls.push(['send.now', params]); return { ok: true, msgId: 'm1', dryRun: false, warnings: ['w'] } },
  }
  const handle = createRpcHandler({ watcher })

  const judged = await handle('judge.now', { draft: '在吗' })
  assert.equal(judged.ok, true)
  assert.deepEqual(calls[0], ['judge.now', { draft: '在吗' }])

  const sent = await handle('send.now', { text: ' 你好 ' })
  assert.equal(sent.ok, true)
  assert.equal(sent.value.msgId, 'm1')
  assert.deepEqual(sent.value.warnings, ['w'])
  assert.deepEqual(calls[1], ['send.now', { text: ' 你好 ', opening: false, manual: true }])

  // 空文本在 RPC 层就被拒（不用麻烦 watcher）
  const empty = await handle('send.now', { text: '   ' })
  assert.equal(empty.ok, false)
  assert.match(empty.error.message, /不能为空/)

  const refused = await handle('send.now', { text: 'x' })
  assert.equal(refused.ok, true, '第二次调用仍走 watcher（桩不拒绝）')
})

test('send.now 把 watcher 的拒绝原因与细节一起带出来', async () => {
  const handle = createRpcHandler({
    watcher: { sendNow: async () => ({ ok: false, reason: 'too soon', detail: 'last send 3.0s ago, need 20s' }) },
  })
  const result = await handle('send.now', { text: '早' })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /too soon/)
  assert.match(result.error.message, /20s/)
})

test('start / stop / messages 走 watcher 的方法并夹取输入', async () => {
  const calls = []
  const watcher = {
    startWindow: async (params) => { calls.push(['start', params]); return { ok: true, window: { hours: 4 }, polling: true } },
    stop: async (params) => { calls.push(['stop', params]); return { ok: true, mode: params.mode, stoppedAt: 'x' } },
    messages: async (limit) => { calls.push(['messages', limit]); await Promise.resolve(); return { ok: true, rows: [{ t_msg: 1 }], group: '1234567', fetchedAt: '2026-10-10 12:00:00' } },
  }
  const handle = createRpcHandler({ watcher })

  const started = await handle('start', { hours: 4 })
  assert.equal(started.ok, true)
  assert.deepEqual(calls[0], ['start', { hours: 4 }])

  await handle('stop', { mode: 'mute', reason: '午休' })
  assert.deepEqual(calls[1], ['stop', { mode: 'mute', reason: '午休' }])

  await handle('stop', { mode: 'nonsense' })
  assert.equal(calls[2][1].mode, 'stop', '非法 mode 一律按 stop 处理')

  const messages = await handle('messages', { limit: 5 })
  assert.equal(messages.ok, true)
  assert.equal(messages.value.limit, 5)
  assert.equal(messages.value.group, '1234567')
  assert.equal(messages.value.fetchedAt, '2026-10-10 12:00:00')
  assert.deepEqual(calls[3], ['messages', 5])

  // limit 缺失/超界都要夹到 1..200
  await handle('messages', {})
  assert.equal(calls[4][1], 30)
  await handle('messages', { limit: 9999 })
  assert.equal(calls[5][1], 200)
  await handle('messages', { limit: -3 })
  assert.equal(calls[6][1], 1)

  const failing = createRpcHandler({
    watcher: {
      startWindow: async () => ({ ok: false, error: '窗口开不了' }),
      stop: async () => ({ ok: false, error: '停不了' }),
      messages: async () => { throw new Error('读不了') },
    },
  })
  assert.match((await failing('start', {})).error.message, /窗口开不了/)
  assert.match((await failing('stop', {})).error.message, /停不了/)
  assert.match((await failing('messages', {})).error.message, /读不了/)
})

test('watcher 缺失或方法抛错时返回失败信封而不是抛', async () => {
  const empty = createRpcHandler({})
  assert.equal((await empty('status', {})).ok, false)

  const hostile = createRpcHandler({
    watcher: {
      status: async () => { throw new Error('boom') },
      getConfig: () => { throw new Error('boom') },
      updateConfig: async () => { throw new Error('boom') },
    },
  })
  for (const endpoint of ['status', 'config.get', 'config.set']) {
    const result = await handleOrThrowFree(hostile, endpoint, { patch: {} })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /boom/)
  }
})

/** 断言"不抛"并把返回值取出来（避免测试里写重复的 try/catch）。 */
async function handleOrThrowFree(handle, endpoint, payload) {
  return await handle(endpoint, payload)
}

test('registerRpc：无 inject 服务时静默跳过', () => {
  assert.doesNotThrow(() => registerRpc({}, () => {}))
  assert.doesNotThrow(() => registerRpc(undefined, () => {}))
})

test('registerRpc：有 connection 时以固定通道注册，包装后的处理器不抛', async () => {
  const registrations = []
  const ctx = {
    inject: (services, callback) => callback({
      connection: {
        rpc: {
          handle: (channel, handler, ...extra) => {
            registrations.push({ channel, handler, extra })
          },
        },
      },
    }),
  }

  registerRpc(ctx, createRpcHandler({ watcher: goodWatcher }))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].channel, CHANNEL)
  assert.deepEqual(registrations[0].extra, [], 'DSH 0.2 的 handle 只接收 channel 和 handler')

  const value = await registrations[0].handler('status', {})
  assert.equal(value.ok, true)

  const hostileHandler = createRpcHandler({ watcher: { status: async () => { throw new Error('boom') } } })
  const ctx2 = {
    inject: (services, callback) => callback({ connection: { rpc: { handle: (channel, handler) => registrations.push({ channel, handler }) } } }),
  }
  registerRpc(ctx2, hostileHandler)
  const failure = await registrations[1].handler('status', {})
  assert.equal(failure.ok, false)
})

test('registerRpc：两个服务按任意顺序就绪时，等 HTTP 服务可用后只注册一次', async () => {
  for (const order of [['connection', 'webServer'], ['webServer', 'connection']]) {
    const ready = new Set()
    const registrations = []
    let pending
    const services = {
      webServer: {},
      connection: { rpc: { handle: (channel, handler) => {
        if (!ready.has('webServer')) throw new Error('webServer 尚未就绪')
        registrations.push({ channel, handler })
      } } },
    }
    registerRpc({
      inject: (needs, callback) => { pending = { needs, callback } },
    }, createRpcHandler({ watcher: goodWatcher }))

    for (const [index, service] of order.entries()) {
      ready.add(service)
      if (pending?.needs.every((name) => ready.has(name))) {
        const { callback } = pending
        pending = undefined
        callback(services)
      }
      assert.equal(registrations.length, index, order.join(' → '))
    }
    assert.equal(registrations[0].channel, CHANNEL)
    assert.equal((await registrations[0].handler('status', {})).value.phase, 'idle')
  }
})

test('registerRpc：connection.rpc.handle 抛错也不会传播', () => {
  const ctx = {
    inject: (services, callback) => callback({ connection: { rpc: { handle: () => { throw new Error('boom') } } } }),
    logger: () => ({ warn: () => {} }),
  }
  assert.doesNotThrow(() => registerRpc(ctx, createRpcHandler({ watcher: goodWatcher })))
})

test('registerRpc：inject 本身抛错也不会传播', () => {
  const ctx = { inject: () => { throw new Error('boom') }, logger: () => ({ warn: () => {} }) }
  assert.doesNotThrow(() => registerRpc(ctx, createRpcHandler({ watcher: goodWatcher })))
})
