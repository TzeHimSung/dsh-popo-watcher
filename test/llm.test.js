/**
 * 文案层（llm）测试：文本累积、清洗、失败降级，以及"绝不抛错/绝不 reject"。
 *
 * 全部用桩 llm 服务（异步生成器），不联网、不碰真实模型。
 *
 * @module dsh-popo-watcher/test/llm
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cleanDraft, createDraftWriter, isSkipLine, listDraftModels, resolveDraftRoute, SKIP_MARKER } from '../lib/llm.js'
import { applyPatch, defaultConfig } from '../lib/config.js'

/** 桩 llm 服务：把预置 chunk 逐个吐出来，并记录调用参数。 */
function fakeLlm(chunks = [], { onStream } = {}) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* generate() {
        if (typeof onStream === 'function') {
          yield* await onStream(options)
          return
        }
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

test('选模：明确选择优先，缺一项整组跟随默认；后续请求读取新配置', async () => {
  let config = defaultConfig()
  let host = { provider: 'host', model: 'host-a' }
  const llm = fakeLlm([{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: 'stop' }])
  const writer = createDraftWriter({ getLlm: () => llm, getRoute: () => resolveDraftRoute(config, host) })
  const check = async (provider, model, source) => {
    assert.deepEqual(resolveDraftRoute(config, host), { provider, model, source })
    await writer.write({ prompt: 'offline model selection check' })
    assert.equal(llm.calls.at(-1).provider, provider)
    assert.equal(llm.calls.at(-1).model, model)
  }
  await check('host', 'host-a', 'host')
  config = applyPatch(config, { llm: { provider: 'second', model: 'shared-id' } }).config
  await check('second', 'shared-id', 'plugin')
  host = { provider: 'new-host', model: 'host-b' }
  await check('second', 'shared-id', 'plugin')
  config = applyPatch(config, { llm: { provider: '', model: '' } }).config
  await check('new-host', 'host-b', 'host')
  config = applyPatch(config, { llm: { model: 'ignored-partial' } }).config
  await check('new-host', 'host-b', 'host')
  assert.deepEqual(resolveDraftRoute(config, null), { provider: '', model: '', source: 'host' })
})

test('模型目录：不同提供方同名模型保留身份，单方失败隔离，只返回显示字段', async () => {
  const calls = []
  const catalog = await listDraftModels({
    getDefaultSelection: () => ({ ...ROUTE, reasoningEffort: 'max' }),
    getLlm: () => ({
      listProviders: () => ['first', 'second', 'broken'].map(id => ({ id, name: id, apiKey: 'secret' })),
      listModels: async provider => {
        calls.push(provider)
        if (provider === 'broken') throw new Error('目录不可读')
        return [{ provider, id: 'shared-id', name: '显示名称', credentials: 'secret' }]
      },
      stream: () => assert.fail('列模型不调用生成'),
    }),
  })
  assert.equal(catalog.ok, true)
  assert.deepEqual(catalog.defaultSelection, ROUTE)
  assert.deepEqual(calls.sort(), ['broken', 'first', 'second'])
  assert.deepEqual(catalog.providers[0], { id: 'first', name: 'first', models: [{ id: 'shared-id', name: '显示名称' }] })
  assert.deepEqual(catalog.providers[1].models, catalog.providers[0].models)
  assert.deepEqual(catalog.providers[2], { id: 'broken', name: 'broken', models: [], error: '目录不可读' })
  assert.equal(JSON.stringify(catalog).includes('secret'), false)
})

test('模型目录：空目录、服务缺失、异常格式和超时都有明确结果', async () => {
  const empty = await listDraftModels({ getLlm: () => ({ listProviders: () => [], listModels: () => [] }) })
  assert.deepEqual(empty, { ok: true, defaultSelection: null, providers: [] })
  assert.equal((await listDraftModels()).ok, false)
  const malformed = await listDraftModels({ getLlm: () => ({ listProviders: () => ({}), listModels: () => [] }) })
  assert.match(malformed.error, /格式/)
  const badModels = await listDraftModels({ getLlm: () => ({ listProviders: () => [{ id: 'p', name: 'p' }], listModels: () => [null] }) })
  assert.match(badModels.providers[0].error, /格式/)
  const timedOut = await listDraftModels({ timeoutMs: 10, getLlm: () => ({
    listProviders: () => [{ id: 'p', name: 'p' }], listModels: () => new Promise(() => {}),
  }) })
  assert.match(timedOut.providers[0].error, /超时/)
})

test('available：服务缺失 / 档位缺失 / 都齐时的三种结论', () => {
  const none = createDraftWriter({ getLlm: () => undefined, getRoute: () => ROUTE })
  assert.equal(none.available().ok, false)
  assert.match(none.available().error, /llm 服务不可用/)

  const noRoute = createDraftWriter({ getLlm: () => fakeLlm(), getRoute: () => ({ provider: '', model: '' }) })
  assert.equal(noRoute.available().ok, false)
  assert.match(noRoute.available().error, /模型档/)

  const ok = createDraftWriter({ getLlm: () => fakeLlm(), getRoute: () => ROUTE })
  assert.deepEqual(ok.available(), { ok: true, provider: 'deepseek', model: 'deepseek-chat' })
})

test('write：累积 text-delta，忽略非文本 chunk，返回清洗后的单行', async () => {
  const llm = fakeLlm([
    { type: 'block-start', blockType: 'text' },
    { type: 'text-delta', text: '这题的' },
    { type: 'reasoning-delta', text: '（不该出现）' },
    { type: 'text-delta', text: '坑我踩过，' },
    { type: 'text-delta', text: '是缓存没清。' },
    { type: 'block-end', block: { type: 'text', text: '这题的坑我踩过，是缓存没清。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const writer = createDraftWriter({ getLlm: () => llm, getRoute: () => ROUTE, now: () => 1000 })
  const result = await writer.write({ system: 'S', prompt: 'P' })

  assert.equal(result.ok, true)
  assert.equal(result.text, '这题的坑我踩过，是缓存没清。')
  assert.equal(result.model, 'deepseek-chat')
  assert.equal(result.ms, 0)

  // 请求体的形状：路由原样传下去，消息是 user 角色 + 文本块 + plugin 来源（插件不能 import dsh-llm）。
  const call = llm.calls[0]
  assert.equal(call.provider, 'deepseek')
  assert.equal(call.model, 'deepseek-chat')
  assert.equal(call.system, 'S')
  assert.equal(call.messages.length, 1)
  assert.equal(call.messages[0].role, 'user')
  assert.equal(call.messages[0].content[0].type, 'text')
  assert.equal(call.messages[0].content[0].text, 'P')
  assert.equal(call.messages[0].source.kind, 'plugin')
  assert.equal(call.messages[0].source.plugin, 'dsh-popo-watcher')
})

test('write：多行只取第一行；围栏与引号被剥掉', () => {
  assert.equal(cleanDraft('第一行\n第二行'), '第一行')
  assert.equal(cleanDraft('```text\n就这一句\n```'), '就这一句')
  assert.equal(cleanDraft('「这样也行」'), '这样也行')
  assert.equal(cleanDraft('"quoted"'), 'quoted')
  assert.equal(cleanDraft('   \n  '), '')
  assert.equal(cleanDraft(undefined), '')
})

test('isSkipLine：只认「SKIP」本身（含引号/标点/大小写），别把正常句子误判', () => {
  for (const text of ['SKIP', 'skip', ' SKIP。', '“SKIP”', '"skip!"']) {
    assert.equal(isSkipLine(text), true, `${text} 应当算 SKIP`)
  }
  for (const text of ['SKIP 一下', '不要 skip', '', '这是我 skip 的理由', undefined]) {
    assert.equal(isSkipLine(text), false, `${text} 不该算 SKIP`)
  }
  assert.equal(SKIP_MARKER, 'SKIP')
})

test('write：温度按配置传给宿主，非法值不发（宿主会用它做调用配置比对）', async () => {
  const llm = fakeLlm([{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }])
  const writer = createDraftWriter({ getLlm: () => llm, getRoute: () => ROUTE })

  await writer.write({ prompt: 'P', temperature: 0.9 })
  assert.equal(llm.calls[0].temperature, 0.9)
  assert.equal(Object.hasOwn(llm.calls[0], 'maxTokens'), false, '预算交给宿主，不在插件里设置回落值')
  await writer.write({ prompt: 'P', maxTokens: 200 })
  assert.equal(Object.hasOwn(llm.calls.at(-1), 'maxTokens'), false, '旧调用参数同样被忽略')

  await writer.write({ prompt: 'P', temperature: '0.3' })
  assert.equal(llm.calls.at(-1).temperature, 0.3, '数字字符串也认')

  for (const bad of [undefined, null, '', 'hot', -1, 3, Number.NaN]) {
    await writer.write({ prompt: 'P', temperature: bad })
  }
  for (const call of llm.calls.slice(3)) {
    assert.equal(Object.hasOwn(call, 'temperature'), false, '非法温度应当整个不发（让宿主用默认档）')
  }
})

test('write：模型中断（finish 不是 stop）算失败，不把半句话交出去', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', text: '半句话' },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded', code: 'QUOTA' } } },
  ])
  const writer = createDraftWriter({ getLlm: () => llm, getRoute: () => ROUTE })
  const result = await writer.write({ prompt: 'P' })

  assert.equal(result.ok, false)
  assert.match(result.error, /模型中断/)
  assert.match(result.error, /quota exceeded/)
  // 半句话只作为诊断字段留在 raw 里
  assert.equal(result.raw, '半句话')
})

test('write：没有文本 / prompt 为空都如实失败', async () => {
  const empty = createDraftWriter({ getLlm: () => fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]), getRoute: () => ROUTE })
  assert.equal((await empty.write({ prompt: 'P' })).ok, false)
  assert.match((await empty.write({ prompt: 'P' })).error, /没有输出文本/)

  const writer = createDraftWriter({ getLlm: () => fakeLlm(), getRoute: () => ROUTE })
  assert.equal((await writer.write({ prompt: '   ' })).ok, false)
})

test('write：流里抛错、服务取用抛错都只返回失败，绝不抛', async () => {
  const throwing = {
    stream() {
      return (async function* generate() {
        yield { type: 'text-delta', text: 'x' }
        throw new Error('socket hang up')
      })()
    },
  }
  const writer = createDraftWriter({ getLlm: () => throwing, getRoute: () => ROUTE })
  const result = await writer.write({ prompt: 'P' })
  assert.equal(result.ok, false)
  assert.match(result.error, /socket hang up/)

  const hostile = createDraftWriter({
    getLlm: () => { throw new Error('ctx.get 炸了') },
    getRoute: () => ROUTE,
  })
  const hostileResult = await hostile.write({ prompt: 'P' })
  assert.equal(hostileResult.ok, false)
  assert.equal((await hostile.write({ prompt: 'P' })).ok, false)

  const badRoute = createDraftWriter({ getLlm: () => fakeLlm(), getRoute: () => { throw new Error('boom') } })
  assert.equal(badRoute.available().ok, false)
  assert.equal((await badRoute.write({ prompt: 'P' })).ok, false)
})

test('write：超过 20 秒仍允许正常完成，插件不设置总时限', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const output = new Promise(resolve => { release = resolve })
  const llm = fakeLlm([], { onStream: () => output })
  const writer = createDraftWriter({ getLlm: () => llm, getRoute: () => ROUTE })
  const pending = writer.write({ prompt: 'P' })
  await Promise.resolve()
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  release([{ type: 'text-delta', text: '完整回复' }, { type: 'finish', reason: { kind: 'stop' } }])
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.text, '完整回复')
  assert.equal(result.finishReason, 'stop')
})

test('write：取消立即返回，忽略取消的适配器迟到输出不会变成成功', async () => {
  const controller = new AbortController()
  let release
  const output = new Promise(resolve => { release = resolve })
  const llm = fakeLlm([], { onStream: () => output })
  const writer = createDraftWriter({ getLlm: () => llm, getRoute: () => ROUTE })
  const pending = writer.write({ prompt: 'P', signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(llm.calls[0].signal, controller.signal)
  controller.abort(new Error('user stopped'))
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.match(result.error, /取消/)
  release([{ type: 'text-delta', text: '不应使用的迟到回复' }, { type: 'finish', reason: 'stop' }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await pending).cancelled, true)
  const before = llm.calls.length
  assert.equal((await writer.write({ prompt: 'P', signal: controller.signal })).cancelled, true)
  assert.equal(llm.calls.length, before, '已取消的请求不启动模型')
})
