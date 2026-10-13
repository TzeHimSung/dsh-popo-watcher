/**
 * 装配冒烟测试：用**真实**的 lib/* 模块 + 真实文件系统（临时 HOME）跑一遍 `apply`。
 *
 * `test/boot-safety.test.js` 钉的是"残缺 ctx 也不能抛"，这里钉的是另一半：
 * 把真 store / 真 config / 真 watcher 装起来之后，工具能返回**真的**快照，
 * 数据根落在 `<home>/.dsh/popo-watcher` 下，配置能落盘再读回来。
 *
 * 不联网、不碰真实数据目录（临时目录用完即删）。
 *
 * @module dsh-popo-watcher/test/host-mount
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'

/** 宿主 ctx 桩（tools / logger / get / inject / effect 都在，够装配用）。 */
function makeCtx(overrides = {}) {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    ctx: {
      logger: () => ({ info() {}, warn() {} }),
      tools: { register: (definition) => registered.push(definition) },
      get: () => undefined,
      inject: () => {},
      effect: (callback, label) => {
        const dispose = callback()
        effects.push({ label, dispose })
      },
      ...overrides,
    },
  }
}

/** 在临时 HOME 下跑一段（store 的数据根按 process.env 解析）。 */
async function withTempHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'popo-watcher-mount-'))
  const previous = process.env.USERPROFILE
  process.env.USERPROFILE = home
  const originalLog = console.log
  console.log = () => {}
  try {
    return await run(home)
  } finally {
    console.log = originalLog
    if (previous === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('真实装配：工具返回真快照，数据根落在 <home>/.dsh/popo-watcher', async () => {
  await withTempHome(async (home) => {
    const { ctx, registered, effects } = makeCtx()
    plugin.apply(ctx, {})

    assert.deepEqual(registered.map((tool) => tool.name).sort(), ['popo_watch_status', 'popo_watcher_ping'])

    const tool = registered.find((entry) => entry.name === 'popo_watch_status')
    const value = await tool.execute({})
    assert.equal(value.ok, true)
    assert.equal(value.phase, 'idle', '没有窗口时应当是 idle')
    assert.match(value.summary, /阶段=idle/)

    const snapshot = JSON.parse(value.snapshotJson)
    assert.equal(snapshot.group, '')
    // 平台路径分隔符不管，只比结构（store 用 path.join，Windows 下是反斜杠）。
    const normalize = (value) => value.replace(/\\/g, '/')
    assert.equal(normalize(snapshot.dataRoot), normalize(join(home, '.dsh', 'popo-watcher')))
    assert.deepEqual(snapshot.window.active, false)
    assert.equal(snapshot.transport.ok, false, '没有 subprocess 服务时如实报告传输层不可用')

    // 单实例锁装上、清理时释放（effect 的 dispose 走 release）
    for (const effect of effects) effect.dispose()
  })
})

test('真实装配：配置改动能落盘、再读回来', async () => {
  await withTempHome(async (home) => {
    const { ctx, registered, effects } = makeCtx()
    plugin.apply(ctx, {})

    // 直接用 watcher 的 RPC 处理器更贴近真实路径，但这里只需要确认"写盘 → 读回"闭环。
    const status = registered.find((entry) => entry.name === 'popo_watch_status')
    assert.equal((await status.execute({})).ok, true)

    const configPath = join(home, '.dsh', 'popo-watcher', 'config.json')
    // 首次读配置不会落盘（只回落默认值），所以文件此时不该存在——这条也是契约的一部分。
    assert.equal(existsSync(configPath), false, '只读状态不该凭空写 config.json')

    for (const effect of effects) effect.dispose()
  })
})

test('真实装配：配置里的 popoCliJs 会被当成 CLI 路径（改配置不用重启宿主）', async () => {
  await withTempHome(async (home) => {
    // 自己造一个"CLI 文件"：只要存在，resolveCli 就会认它。
    const cli = join(home, 'fake-popo.js')
    writeFileSync(cli, '// fake popo cli\n', 'utf8')
    const dataDir = join(home, '.dsh', 'popo-watcher')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ group: '1234567', popoCliJs: cli }), 'utf8')

    const { ctx, registered, effects } = makeCtx({
      get: (service) => (service === 'subprocess' ? { spawn: () => null } : undefined),
    })
    plugin.apply(ctx, {})
    const tool = registered.find((entry) => entry.name === 'popo_watch_status')
    const snapshot = JSON.parse((await tool.execute({})).snapshotJson)

    assert.equal(snapshot.transport.ok, true, `传输层应当可用：${JSON.stringify(snapshot.transport)}`)
    assert.equal(
      String(snapshot.transport.cliPath).replace(/\\/g, '/'),
      cli.replace(/\\/g, '/'),
      '配置里的 popoCliJs 必须真的被用上（这条曾经是死配置）',
    )

    for (const effect of effects) effect.dispose()
  })
})

test('真实装配：模型目录只读，保存后状态与两种判读使用新模型，恢复默认后动态跟随宿主', async (t) => {
  await withTempHome(async home => {
    const root = join(home, '.dsh', 'popo-watcher')
    const groupDir = join(root, '1234567')
    mkdirSync(groupDir, { recursive: true })
    writeFileSync(join(root, 'config.json'), JSON.stringify({ group: '1234567', autoResume: false, llm: { temperature: 0.6 } }))
    writeFileSync(join(groupDir, 'messages.jsonl'), JSON.stringify({ from: 'offline-other', content: '模型设置如何保存？', t_msg: Date.now() }) + '\n')
    const previousKey = process.env.TYPESAFE_API_KEY
    process.env.TYPESAFE_API_KEY = 'fake-offline-model-key'
    let handler
    let directoryReads = 0
    let hostSelection = { provider: 'first', model: 'host-a' }
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requests.push({ url, init })
      return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith('/models')
        ? { models: [{ name: 'jev-latest' }, { name: 'jev-preview' }] }
        : { answers: {} }) }
    })
    const { ctx, effects } = makeCtx({
      get: service => service === 'agentDefaultModel' ? { currentSelection: () => hostSelection }
        : service === 'llm' ? {
          listProviders: () => { directoryReads++; return [{ id: 'second', name: '提供方二' }] },
          listModels: provider => [{ provider, id: 'shared-id', name: '共享型号' }],
          stream: () => assert.fail('目录读取和只判读操作不能生成文本'),
        } : undefined,
      inject: (_needs, callback) => callback({ connection: { rpc: { handle: (_channel, callback) => { handler = callback } } } }),
    })
    try {
      plugin.apply(ctx, {})
      assert.equal(typeof handler, 'function')
      assert.equal((await handler('status', {})).value.llm.resolved.model, 'host-a')
      assert.equal(directoryReads, 0, '状态不应读取目录')
      assert.equal(requests.length, 0, '状态不应请求 TypeSafe')
      const before = readFileSync(join(root, 'config.json'), 'utf8')
      const catalog = await handler('models.list', {})
      assert.equal(catalog.ok, true)
      assert.equal(catalog.value.llm.providers[0].models[0].id, 'shared-id')
      assert.equal(catalog.value.judge.models[1].id, 'jev-preview')
      assert.equal(JSON.stringify(catalog).includes('fake-offline-model-key'), false)
      assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), before)
      await handler('models.list', { scope: 'judge' })
      assert.equal(directoryReads, 1)
      const changed = await handler('config.set', { patch: { llm: { provider: 'second', model: 'shared-id' }, judge: { model: 'jev-preview' } } })
      assert.equal(changed.value.written, true)
      const disk = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
      assert.deepEqual(disk.llm, { provider: 'second', model: 'shared-id', temperature: 0.6 })
      assert.equal(disk.judge.model, 'jev-preview')
      await handler('judge.now', {})
      await handler('judge.now', { draft: '离线草稿，仅测试路由' })
      assert.deepEqual(requests.filter(request => request.init.method === 'POST').map(request => JSON.parse(request.init.body).model), ['jev-preview', 'jev-preview'])
      hostSelection = { provider: 'first', model: 'host-b' }
      assert.deepEqual((await handler('status', {})).value.llm.resolved, { provider: 'second', model: 'shared-id', source: 'plugin' })
      await handler('config.set', { patch: { llm: { provider: '', model: '' } } })
      assert.deepEqual((await handler('status', {})).value.llm.resolved, { provider: 'first', model: 'host-b', source: 'host' })
      assert.equal((await handler('config.get', { reload: true })).value.config.llm.provider, '')
      assert.equal(directoryReads, 1)
    } finally {
      for (const effect of effects) effect.dispose()
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
      else process.env.TYPESAFE_API_KEY = previousKey
    }
  })
})

test('真实装配：重启读到旧停止错误时不采集、不写盘，状态保持 idle 并保留历史原因', async () => {
  await withTempHome(async (home) => {
    const root = join(home, '.dsh', 'popo-watcher', '1234567')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '..', 'config.json'), JSON.stringify({ group: '1234567' }), 'utf8')
    const stateFile = join(root, 'state.json')
    const saved = JSON.stringify({ group: '1234567', startedAt: '2026-10-09 21:54:03', endsAt: '2099-10-12 21:54:03',
      stopped: true, stoppedAt: '2026-10-09 23:11:49', collectionError: 'FABRIC_NETWORK_ERROR', sentCount: 13 })
    writeFileSync(stateFile, saved, 'utf8')
    let requests = 0
    const { ctx, registered, effects } = makeCtx({ get: name => name === 'subprocess' ? { spawn: () => { requests += 1; assert.fail('重启后未开启监控，不应调用 CLI') } } : undefined })
    try {
      plugin.apply(ctx, {})
      await new Promise(resolve => setTimeout(resolve, 20))
      const tool = registered.find(entry => entry.name === 'popo_watch_status')
      for (let index = 0; index < 3; index += 1) {
        const snapshot = JSON.parse((await tool.execute({})).snapshotJson)
        assert.equal(snapshot.phase, 'idle')
        assert.equal(snapshot.poll.running, false)
        assert.equal(snapshot.poll.consecutiveFailures, 0)
        assert.equal(snapshot.poll.lastError, null)
        assert.deepEqual(snapshot.degraded, { active: false, reason: null, since: null })
        assert.equal(snapshot.window.collectionError, 'FABRIC_NETWORK_ERROR')
        assert.equal(snapshot.window.stoppedAt, '2026-10-09 23:11:49')
        assert.equal(snapshot.sends.count, 13)
      }
      assert.equal(requests, 0)
      assert.equal(readFileSync(stateFile, 'utf8'), saved)
      assert.equal(existsSync(join(root, 'poll.log')), false)
    } finally {
      for (const effect of effects) effect.dispose()
    }
  })
})

test('真实装配：恢复窗口时采集失败会自动停止，并写盘阻止下次启动恢复', async () => {
  await withTempHome(async (home) => {
    const root = join(home, '.dsh', 'popo-watcher', '1234567')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '..', 'config.json'), JSON.stringify({ group: '1234567' }), 'utf8')
    writeFileSync(join(root, 'state.json'), JSON.stringify({
      group: '1234567',
      selfUid: 'u@example.com',
      startedAt: '2026-09-22 09:00:00',
      endsAt: '2099-09-22 09:00:00',
      stopped: false,
      sentCount: 0,
      sentMessages: [],
    }), 'utf8')

    const { ctx, registered, effects } = makeCtx()
    plugin.apply(ctx, {})
    const tool = registered.find((entry) => entry.name === 'popo_watch_status')

    // apply 的 effect 里用 setTimeout(0) 调 resume()，等它跑完再看状态。
    await new Promise((resolve) => setTimeout(resolve, 20))
    const snapshot = JSON.parse((await tool.execute({})).snapshotJson)

    assert.equal(snapshot.window.active, true, '窗口没过期，应当被认出来')
    assert.equal(snapshot.poll.running, false, '恢复采集失败后必须停止')
    assert.equal(snapshot.window.stopped, true)
    assert.equal(snapshot.phase, 'degraded', '停止后仍保留故障状态')

    // 失败只更新停止标记与原因，不能伪造成功采集或发言。
    const written = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
    assert.equal(written.stopped, true)
    assert.match(written.collectionError, /传输层不可用/)
    assert.equal(written.sentCount, 0)

    for (const effect of effects) effect.dispose()
  })
})

test('真实装配：开始与自动恢复都接入 CodeMaker 检查，失败不启动 POPO CLI', async () => {
  for (const restore of [false, true]) {
    await withTempHome(async home => {
      const root = join(home, '.dsh', 'popo-watcher')
      const groupDir = join(root, '1234567')
      mkdirSync(groupDir, { recursive: true })
      writeFileSync(join(root, 'config.json'), JSON.stringify({ group: '1234567', autoResume: restore }))
      if (restore) writeFileSync(join(groupDir, 'state.json'), JSON.stringify({
        startedAt: '2026-10-10 09:00:00', endsAt: '2099-10-10 09:00:00', stopped: false,
      }))
      let handler, checks = 0
      const { ctx, effects } = makeCtx({
        get: service => service === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'codemaker', model: 'fixture' }) }
          : service === 'llm' ? {
            listConfigurableProviders: () => [{ provider: 'codemaker', settingsNs: 'llm-fixture', settingsPath: ['providers', 'codemaker'] }],
            discoverModels: async () => { checks++; throw new Error('fixture endpoint answered 503') },
          } : service === 'settings' ? { describe: () => [{ ns: 'llm-fixture', value: { providers: {
            codemaker: { baseURL: 'http://127.0.0.1:12345/v1', api: 'openai-responses' },
          } } }] }
            : service === 'subprocess' ? { spawn: () => assert.fail('检查失败不能启动 CLI') } : undefined,
        inject: (_needs, callback) => callback({ connection: { rpc: { handle: (_channel, callback) => { handler = callback } } } }),
      })
      try {
        plugin.apply(ctx, {})
        if (restore) await new Promise(resolve => setTimeout(resolve, 20))
        else assert.equal((await handler('start', { hours: 1 })).ok, false)
        const state = (await handler('status', {})).value
        assert.equal(checks, 1)
        assert.equal(state.window.stopped, true)
        assert.match(state.window.stoppedReason, /CodeMaker 接口检查失败.*HTTP 503/)
        assert.equal(state.poll.running, false)
        assert.equal(state.window.collectionError, null)
        assert.equal(state.phase, 'idle')
      } finally {
        for (const effect of effects) effect.dispose()
      }
    })
  }
})
