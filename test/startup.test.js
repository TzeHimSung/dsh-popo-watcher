import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkCodeMakerConnection, resolveDraftRoute } from '../lib/llm.js'
import { createWatcher } from '../lib/watcher.js'
import { createRpcHandler } from '../lib/rpc.js'
import * as config from '../lib/config.js'
import * as store from '../lib/store.js'
import { watcherFixture } from './helpers/watcher-fixture.js'

function hostFixture() {
  const calls = []
  const profile = { baseURL: 'http://127.0.0.1:12345/v1', api: 'openai-responses' }
  let route = { provider: 'codemaker', model: 'unlisted-alias' }
  const llm = {
    listConfigurableProviders: () => [{ provider: 'codemaker', settingsNs: 'custom-llm', settingsPath: ['providers', 'codemaker'] }],
    listModels: () => assert.fail('本地模型目录不能代替连通性检查'),
    stream: () => assert.fail('启动检查不能调用生成'),
    discoverModels: async (...args) => { calls.push(args); return [{ id: 'another-model' }] },
  }
  const settings = { describe: options => {
    assert.deepEqual(options, { redactSecrets: true })
    return [{ ns: 'custom-llm', value: { providers: { codemaker: profile } } }]
  } }
  const options = { getRoute: () => route, getLlm: () => llm, getSettings: () => settings }
  return { options, calls, profile, llm, settings, route: value => { route = value } }
}

test('启动检查跟随生效路由和实时配置，调用原生 discovery，不要求型号在列表中', async () => {
  const fixture = hostFixture()
  const { options, calls, profile } = fixture
  let cfg = { llm: { provider: '', model: '' } }
  const hostRoute = { provider: 'codemaker', model: 'host-model' }
  options.getRoute = () => resolveDraftRoute(cfg, hostRoute)
  assert.deepEqual(await checkCodeMakerConnection(options), { ok: true })
  assert.deepEqual(calls[0].slice(0, 2), ['custom-llm', {
    provider: 'codemaker', baseURL: profile.baseURL, api: 'openai-responses',
  }])
  assert.ok(calls[0][2] instanceof AbortSignal)
  assert.equal(calls[0][2].aborted, false)
  profile.baseURL = 'http://127.0.0.1:23456/gateway/v1'
  fixture.llm.discoverModels = async (...args) => { calls.push(args); return [] }
  assert.equal((await checkCodeMakerConnection(options)).ok, true, '合法空列表也代表接口可访问')
  assert.equal(calls[1][1].baseURL, profile.baseURL)
  cfg = { llm: { provider: 'another-provider', model: 'chosen-model' } }
  options.getLlm = () => assert.fail('非 CodeMaker 不读取检查服务')
  options.getSettings = () => assert.fail('非 CodeMaker 不读取宿主设置')
  assert.deepEqual(await checkCodeMakerConnection(options), { ok: true })
  assert.equal(calls.length, 2)
})

test('缺少检查能力或接口配置时拒绝启动，不使用固定地址兜底', async () => {
  for (const mutate of [
    f => { f.options.getLlm = () => undefined },
    f => { f.options.getSettings = () => undefined },
    f => { f.llm.discoverModels = undefined },
    f => { f.llm.listConfigurableProviders = () => [] },
    f => { f.settings.describe = () => [] },
    f => { f.profile.baseURL = '' },
    f => { f.profile.baseURL = 'not a URL' },
    f => { f.profile.baseURL = 'file:///fixture' },
    f => { f.profile.api = 123 },
  ]) {
    const f = hostFixture()
    mutate(f)
    const result = await checkCodeMakerConnection(f.options)
    assert.equal(result.ok, false)
    assert.match(result.error, /CodeMaker 接口检查失败/)
    assert.equal(f.calls.length, 0)
  }
})

test('检查错误提供安全的具体原因，不暴露凭证、请求头或响应正文', async () => {
  const cases = [
    [Object.assign(new Error('could not reach secret'), { cause: { code: 'ECONNREFUSED' } }), /连接被拒绝.*ECONNREFUSED/],
    [Object.assign(new Error('secret'), { cause: { code: 'ENOTFOUND' } }), /无法解析/],
    ...[401, 403, 500, 503].map(status => [new Error(`endpoint answered ${status}; secret body`), new RegExp(`HTTP ${status}`)]),
    [new Error('endpoint did not answer with JSON: secret body'), /不是合法 JSON/],
    [new Error('the endpoint\'s model listing has neither a "data" array nor a "models" object: secret body'), /响应格式错误/],
    [Object.assign(new Error('secret key'), { code: 'MISSING_CREDENTIAL' }), /宿主凭证不可用/],
    [Object.assign(new Error('secret'), { code: 'NO_DISCOVERY' }), /不支持/],
    [new Error('Authorization: Bearer secret; full response body'), /请求失败/],
  ]
  for (const [error, expected] of cases) {
    const f = hostFixture()
    f.profile.baseURL = 'http://user:secret@127.0.0.1:12345/v1?key=secret#secret'
    f.llm.discoverModels = async () => { throw error }
    const result = await checkCodeMakerConnection(f.options)
    assert.equal(result.ok, false)
    assert.match(result.error, expected)
    assert.match(result.error, /http:\/\/127\.0\.0\.1:12345\/v1/)
    assert.doesNotMatch(result.error, /secret|user:|Authorization|response body/)
  }
  const f = hostFixture()
  for (const models of [{ data: [] }, [null], [{ id: '' }]]) {
    f.llm.discoverModels = async () => models
    assert.match((await checkCodeMakerConnection(f.options)).error, /模型列表响应格式错误/)
  }
})

test('完整检查最多等待 5 秒，即使宿主 discovery 忽略取消也能结束', { timeout: 8000 }, async () => {
  const f = hostFixture()
  let signal, release
  f.llm.discoverModels = async (_ns, _request, inputSignal) => {
    signal = inputSignal
    return new Promise(resolve => { release = resolve })
  }
  const result = await checkCodeMakerConnection(f.options)
  assert.equal(result.ok, false)
  assert.match(result.error, /检查超时（5 秒）/)
  assert.equal(signal.aborted, true)
  release([])
})

test('开始失败保持关闭、保存原因和原数据；修复后显式重试才能采集并发开场白', async t => {
  const events = []
  let healthy = false
  const error = 'CodeMaker 接口检查失败（http://127.0.0.1:12345/v1）：连接被拒绝（ECONNREFUSED）'
  const f = watcherFixture(t, {
    config: { opening: { enabled: true, text: 'synthetic opening' } },
    checkStartup: async () => { events.push('probe'); return healthy ? { ok: true } : { ok: false, error } },
    transport: {
      search: async () => { events.push('search'); return { ok: true, value: { uid: 'self', messages: [] } } },
      send: async () => { events.push('send'); return { ok: true, value: { msgId: 'synthetic-opening' } } },
    },
  })
  const stateFile = join(f.dir, 'state.json')
  const original = store.readJson(stateFile).value
  original.sentCount = 3
  original.sentMessages = [{ content: 'old confirmed send', atMs: 1, msgId: 'old-send' }]
  store.writeJsonAtomic(stateFile, original)
  const pollFile = join(f.dir, 'poller.json')
  store.writeJsonAtomic(pollFile, { lastSeenMsgTime: 123, watchedMsgs: 7 })
  const pollBefore = readFileSync(pollFile, 'utf8')
  const messagesBefore = readFileSync(join(f.dir, 'messages.jsonl'), 'utf8')
  const handle = createRpcHandler({ watcher: f.watcher })
  const failed = await handle('start', { hours: 2 })
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.error, { code: 'popo-watcher/error', message: error, details: {} })
  assert.deepEqual(events, ['probe'])
  const stopped = store.readJson(stateFile).value
  assert.deepEqual(stopped, { ...original, stopped: true, stoppedAt: store.nowStamp(f.now()), stoppedReason: error })
  assert.equal(readFileSync(pollFile, 'utf8'), pollBefore)
  assert.equal(readFileSync(join(f.dir, 'messages.jsonl'), 'utf8'), messagesBefore)
  assert.equal(f.watcher.status().value.poll.running, false)
  assert.equal(f.watcher.status().value.poll.consecutiveFailures, 0)
  assert.equal(f.watcher.status().value.window.collectionError, null)
  assert.equal(f.watcher.status().value.phase, 'idle')
  assert.equal((await f.watcher.resume()).resumed, false, '失败后不能自动再试')
  assert.deepEqual(events, ['probe'])
  healthy = true
  assert.equal((await handle('start', { hours: 2 })).ok, true)
  assert.deepEqual(events, ['probe', 'probe', 'search', 'send'])
  assert.equal(f.watcher.status().value.window.stopped, false)
  assert.equal(f.watcher.status().value.window.stoppedReason, null)
})

test('首次启动检查失败不创建活动窗口；CodeMaker 未装配检查回调时也拒绝', async t => {
  const f = watcherFixture(t, { config: { llm: { provider: 'codemaker', model: 'fixture-model' } } })
  store.removeFile(join(f.dir, 'state.json'))
  const result = await f.watcher.startWindow()
  assert.equal(result.ok, false)
  assert.match(result.error, /CodeMaker 接口检查失败.*未接入/)
  assert.equal(f.watcher.status().value.window.startedAt, null)
  assert.equal(f.watcher.status().value.window.active, false)
  assert.equal(f.watcher.status().value.window.stopped, true)
  assert.equal(f.watcher.status().value.poll.running, false)
  assert.equal(f.sent.length, 0)
})

test('自动恢复同样先检查，失败持久化并阻止下次宿主恢复', async t => {
  const error = 'CodeMaker 接口检查失败：HTTP 503'
  let checks = 0
  const f = watcherFixture(t, { checkStartup: async () => { checks++; return { ok: false, error } },
    transport: { search: () => assert.fail('检查失败不能采集'), send: () => assert.fail('检查失败不能发送') },
  })
  const before = store.readJson(join(f.dir, 'state.json')).value
  const result = await f.watcher.resume()
  assert.equal(result.ok, false)
  assert.equal(result.error, error)
  assert.equal(f.watcher.status().value.window.startedAt, before.startedAt)
  assert.equal(f.watcher.status().value.window.endsAt, before.endsAt)
  f.watcher.dispose()
  const reloaded = createWatcher({ store, config, env: f.env, now: f.now,
    checkStartup: () => assert.fail('重载后保持停止，不检查或自动重试'),
  })
  t.after(() => reloaded.dispose())
  assert.equal((await reloaded.resume()).resumed, false)
  assert.equal(reloaded.status().value.window.stoppedReason, error)
  assert.equal(reloaded.status().value.poll.running, false)
  assert.equal(checks, 1)
})

test('旧采集停止记录不能遮住这次 CodeMaker 启动失败原因', async t => {
  let healthy = true
  const error = 'CodeMaker 接口检查失败：HTTP 503'
  const f = watcherFixture(t, {
    checkStartup: async () => healthy ? { ok: true } : { ok: false, error },
    transport: { search: async () => ({ ok: false, kind: 'auth', error: 'old collection error' }) },
  })
  assert.equal((await f.watcher.startWindow()).ok, false)
  assert.match(f.watcher.status().value.window.stoppedReason, /采集失败/)
  healthy = false
  assert.equal((await f.watcher.startWindow()).error, error)
  assert.equal(f.watcher.status().value.window.stoppedReason, error)
  assert.equal(store.readJson(join(f.dir, 'state.json')).value.stoppedReason, error)
  assert.equal(f.watcher.status().value.window.collectionError, 'old collection error', '原采集故障仍保留')
})

test('停止、卸载和更新的启动请求使在途检查失效，迟到的成功与失败都不能修改状态', async t => {
  for (const entry of ['startWindow', 'resume']) {
    for (const action of ['stop', 'dispose', 'new-start']) {
      for (const lateResult of [{ ok: true }, { ok: false, error: 'CodeMaker 接口检查失败：late result' }]) {
        await t.test(`${entry} / ${action} / ${lateResult.ok}`, async t => {
          let release, entered, checks = 0, searches = 0
          const pending = new Promise(resolve => { release = resolve })
          const checking = new Promise(resolve => { entered = resolve })
          const f = watcherFixture(t, { checkStartup: () => { checks++; entered(); return checks === 1 ? pending : { ok: true } },
            transport: { search: async () => { searches++; return { ok: true, value: { messages: [] } } } },
          })
          const first = f.watcher[entry]()
          await checking
          let replacement
          if (action === 'stop') await f.watcher.stop({ reason: 'explicit stop' })
          else if (action === 'dispose') f.watcher.dispose()
          else replacement = f.watcher.startWindow()
          const stateAfterAction = readFileSync(join(f.dir, 'state.json'), 'utf8')
          release(lateResult)
          assert.match((await first).error, /开始请求已取消/)
          if (replacement) {
            assert.equal((await replacement).ok, true)
            assert.equal(searches, 1)
            assert.equal(checks, 2)
          } else {
            assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8'), stateAfterAction)
            assert.equal(searches, 0)
            assert.equal(f.watcher.status().value.poll.running, false)
            assert.equal(f.watcher.status().value.errors.length, 0)
          }
          assert.equal(f.sent.length, 0)
        })
      }
    }
  }
})

test('检查成功到创建窗口之间的异步交接也不能覆盖停止操作', async t => {
  for (const entry of ['startWindow', 'resume']) {
    const f = watcherFixture(t, { checkStartup: async () => {
      queueMicrotask(() => queueMicrotask(() => { void f.watcher.stop({ reason: 'stop after probe' }) }))
      return { ok: true }
    }, transport: { search: () => assert.fail('已经停止，不能继续启动采集') } })
    const before = store.readJson(join(f.dir, 'state.json')).value
    assert.match((await f.watcher[entry]()).error, /开始请求已取消/)
    const win = f.watcher.status().value.window
    assert.equal(win.stopped, true)
    assert.equal(win.stoppedReason, 'stop after probe')
    assert.equal(win.startedAt, before.startedAt)
    assert.equal(win.endsAt, before.endsAt)
  }
})
