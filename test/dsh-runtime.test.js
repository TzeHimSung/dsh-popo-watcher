import assert from 'node:assert/strict'
import { request } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CHANNEL, createRpcHandler, registerRpc } from '../lib/rpc.js'
import { listDraftModels } from '../lib/llm.js'
import * as plugin from '../lib/index.js'

const runtime = process.env.DSH_TEST_RUNTIME

test('本机 DSH：完整插件在真实 Cordis/Connection 中提供当前 RPC 契约', {
  skip: runtime ? false : '需用 DSH 内置 Node 运行',
}, async t => {
  const packageDir = name => join(runtime, 'node_modules', '@deepseek-ai', name)
  const load = name => import(pathToFileURL(join(packageDir(name), 'lib', 'index.js')).href)
  const [{ Context }, { WebServer }, { HostConnectionService, serverResponseSchema }, boot] = await Promise.all([
    load('cordis'), load('dsh-host-webserver'), load('dsh-client-connection'), load('dsh-app-boot'),
  ])
  const entries = boot.composeEntries([
    boot.loadOverlayPatches('dsh', join(packageDir('dsh-web-app'), 'cordis.patch.yml')),
    boot.loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
  ])
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
  const registered = []
  await ctx.plugin({ name: 'offline-services', inject: ['webServer'], apply(owner) {
    owner.provide('webRuntime', {})
    owner.provide('tools', { register: definition => registered.push(definition) })
  } })
  await ctx.plugin({ name: 'connection', inject: entries.find(entry => entry.id === 'connection').inject,
    apply(owner) { new HostConnectionService(owner, [], { isAuthenticated: () => true }) } })
  // 没有 subprocess / llm / credentials 服务；不可能调用真实 POPO 或模型。
  await ctx.plugin(plugin)
  await Promise.all([...ctx.registry.values()].flatMap(entry => [...entry.fibers].map(fiber => fiber.await())))
  const ping = await registered.find(tool => tool.name === 'popo_watcher_ping').execute({ message: 'offline acceptance' })
  assert.equal(ping.ok, true)
  assert.equal(ping.version, '0.1.3')
  const response = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${ctx.get('webServer').port}${CHANNEL}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.once('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      res.once('error', reject)
    })
    req.once('error', reject)
    req.end(JSON.stringify({ type: 'client-request', rpcId: 'full-plugin', method: 'status', payload: {} }))
  })
  assert.equal(response.status, 200)
  serverResponseSchema.parse(response.body)
  assert.equal(response.body.result.ok, true)
  assert.equal(response.body.result.value.group, '')
  assert.deepEqual(response.body.result.value.persistence, { ok: true, error: null })
  assert.equal(response.body.result.value.poll.running, false)
})

test('本机 DSH：通过插件上下文惰性读取真实 llm 服务的模型目录', {
  skip: runtime ? false : '需用 DSH 内置 Node 运行',
}, async t => {
  const load = name => import(pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href)
  const [{ Context }, { LlmRuntime, LlmAdapter }] = await Promise.all([load('cordis'), load('dsh-llm')])
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin({
    name: 'offline-model-catalog', inject: ['llm'],
    apply(owner) {
      owner.llm.registerAdapter(['offline-first', 'offline-second'], new class extends LlmAdapter {
        listModels(provider) { return Promise.resolve([{ provider, id: 'shared-model', name: '离线目录模型' }]) }
        stream() { assert.fail('目录读取不允许调用模型') }
      }())
    },
  })
  let read
  await ctx.plugin({
    name: 'catalog-consumer',
    apply(owner) { read = () => listDraftModels({ getLlm: () => owner.get('llm') }) },
  })
  await Promise.all([...ctx.registry.values()].flatMap(entry => [...entry.fibers].map(fiber => fiber.await())))
  const result = await read()
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.providers.map(provider => [provider.id, provider.models[0].id]), [
    ['offline-first', 'shared-model'], ['offline-second', 'shared-model'],
  ])
})

test('本机 DSH：独立服务上下文下，bundle 能挂载设置页的 HTTP RPC 路由', {
  skip: runtime ? false : '需用 DSH 内置 Node 运行，并设置 DSH_TEST_RUNTIME 为 resources/app.asar/dsh',
}, async (t) => {
  const packageDir = (name) => join(runtime, 'node_modules', '@deepseek-ai', name)
  const load = (name) => import(pathToFileURL(join(packageDir(name), 'lib', 'index.js')).href)
  const [{ Context }, { WebServer }, { HostConnectionService, serverResponseSchema }, boot] = await Promise.all([
    load('cordis'), load('dsh-host-webserver'), load('dsh-client-connection'), load('dsh-app-boot'),
  ])
  const entries = boot.composeEntries([
    boot.loadOverlayPatches('dsh', join(packageDir('dsh-web-app'), 'cordis.patch.yml')),
    boot.loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
  ])
  const connectionEntry = entries.find((entry) => entry.id === 'connection')
  assert.ok(connectionEntry, '必须使用本机 Web profile 的 Connection 声明')

  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  // 必须由独立插件提供服务；在根 ctx 上直接 provide 会绕过实机的依赖访问检查。
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
  await ctx.plugin({
    name: 'web-runtime', inject: ['webServer'],
    apply(owner) { owner.provide('webRuntime', {}) },
  })
  await ctx.plugin({
    name: 'connection', inject: connectionEntry.inject,
    apply(owner) { new HostConnectionService(owner, [], { isAuthenticated: () => true }) },
  })
  const webServer = ctx.get('webServer')
  webServer.registerFallback((_req, res) => { res.writeHead(405); res.end() })
  await ctx.plugin({
    name: 'test-popo-rpc',
    apply(owner) {
      registerRpc(owner, createRpcHandler({ watcher: {
        status: () => ({ ok: true, value: { phase: 'idle', group: '1234567' } }),
        getConfig: () => ({ ok: true, config: { group: '1234567' }, warnings: [] }),
        keyStatus: () => ({ ok: true, configured: false, source: 'none', stored: false }),
        checkCli: () => ({ ok: false, error: '请运行 popo-cli auth login' }),
        messages: async () => ({ ok: true, rows: [{ t_msg: 1000, msgId: 'latest' }], group: '1234567', fetchedAt: '2026-10-10 12:00:00' }),
        sendNow: () => ({ ok: false, reason: 'self spoke last', detail: 'wait for someone else to speak' }),
      }, listModels: async () => ({ llm: { ok: true, providers: [], defaultSelection: null }, judge: { ok: true, models: [] } }) }))
    },
  })
  await Promise.all([...ctx.registry.values()].flatMap((entry) => [...entry.fibers].map((fiber) => fiber.await())))

  for (const endpoint of ['status', 'config.get', 'models.list', 'key.status', 'cli.check', 'messages', 'send.now', 'config.set', 'unknown']) {
    const rpcId = `test-${endpoint}`
    const response = await new Promise((resolve, reject) => {
      const req = request(`http://127.0.0.1:${webServer.port}${CHANNEL}/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { text += chunk })
        res.once('end', () => resolve({ status: res.statusCode, text }))
        res.once('error', reject)
      })
      req.once('error', reject)
      req.end(JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: endpoint === 'send.now' ? { text: '离线验证，不会发送' } : {} }))
    })
    assert.equal(response.status, 200, `${endpoint} 必须命中 RPC 路由，不能落入静态文件的 405`)
    const body = JSON.parse(response.text)
    // HTTP 200 不代表回包可用：真实 Connection 要求失败也带 code/message/details。
    serverResponseSchema.parse(body)
    assert.equal(body.rpcId, rpcId)
    const failed = ['send.now', 'config.set', 'unknown'].includes(endpoint)
    assert.equal(body.result.ok, !failed, endpoint)
    if (endpoint === 'send.now') assert.match(body.result.error.message, /self spoke last/)
    if (endpoint === 'status') assert.equal(body.result.value.phase, 'idle')
    if (endpoint === 'models.list') assert.deepEqual(body.result.value.judge.models, [])
    if (endpoint === 'messages') assert.deepEqual(body.result.value, { rows: [{ t_msg: 1000, msgId: 'latest' }], limit: 30, group: '1234567', fetchedAt: '2026-10-10 12:00:00' })
    if (endpoint === 'cli.check') {
      assert.equal(body.result.value.healthy, false)
      assert.match(body.result.value.message, /popo-cli auth login/)
    }
  }
})
