/**
 * 宿主安全（boot）测试：这是最要紧的一组。
 *
 * 背景：宿主插件在 import 期抛错、或 `apply` 同步抛错，会让 Loader 的行永远不激活，
 * DSH 启动 audit 就 fail loud —— 整个 `dsh web` 直接起不来。所以本测试用"真实 import
 * + 各种残缺/敌意 ctx"来钉住两条不变量：
 *   1) import 本模块不产生副作用、不抛错；
 *   2) 无论 ctx 缺哪些服务、哪些方法抛错，`apply` 都不抛出。
 *
 * @module dsh-popo-watcher/test/boot-safety
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'
import { SINGLETON_KEY } from '../lib/singleton.js'

/** 收集注册结果的 ctx 桩。 */
function makeCtx(overrides = {}) {
  const registered = []
  const effects = []
  const base = {
    logger: () => ({ info() {}, warn() {} }),
    tools: { register: (definition) => registered.push(definition) },
    get: () => undefined,
    effect: (callback, label) => effects.push({ label, dispose: callback() }),
  }
  return { ctx: { ...base, ...overrides }, registered, effects }
}

/** 静音 console.log（apply 会打一条终端加载行）。 */
function quiet(run) {
  const original = console.log
  console.log = () => {}
  try {
    return run()
  } finally {
    console.log = original
  }
}

test('import 期无副作用：模块导出形状正确', () => {
  assert.equal(plugin.name, 'popo-watcher')
  assert.deepEqual(plugin.inject, ['tools'], '硬 inject 只能有 tools，多一个就可能让宿主起不来')
  assert.equal(typeof plugin.apply, 'function')
})

test('残缺 ctx（无 get / 无 inject / 无 effect）不抛错，且工具照常注册', () => {
  const { ctx, registered } = makeCtx()
  delete ctx.get
  delete ctx.inject
  delete ctx.effect

  assert.doesNotThrow(() => quiet(() => plugin.apply(ctx, {})))
  assert.deepEqual(registered.map((tool) => tool.name).sort(), ['popo_watch_status', 'popo_watcher_ping'])
})

test('敌意 ctx（logger/get/inject 全抛）也不抛错', () => {
  const { ctx, registered } = makeCtx({
    logger: () => { throw new Error('logger boom') },
    get: () => { throw new Error('get boom') },
    inject: () => { throw new Error('inject boom') },
  })

  assert.doesNotThrow(() => quiet(() => plugin.apply(ctx, { greeting: '你好' })))
  assert.equal(registered.length, 2)
})

test('connection 注册抛错也不影响行激活', () => {
  const { ctx, registered } = makeCtx({
    inject: (services, callback) => callback({ connection: { rpc: { handle: () => { throw new Error('boom') } } } }),
  })

  assert.doesNotThrow(() => quiet(() => plugin.apply(ctx, {})))
  assert.equal(registered.length, 2)
})

test('effect 清理会释放单实例锁', () => {
  const { ctx, effects } = makeCtx()
  quiet(() => plugin.apply(ctx, {}))

  assert.equal(effects.length, 1, '应当只注册一个 effect')
  assert.equal(typeof effects[0].dispose, 'function')
  assert.notEqual(globalThis[SINGLETON_KEY], undefined, 'apply 之后应当持有单实例锁')

  assert.doesNotThrow(() => effects[0].dispose())
  assert.equal(globalThis[SINGLETON_KEY], undefined, 'dispose 之后锁必须释放')
})

test('HMR 二次 apply 会先释放上一个实例（不允许两个循环并联）', () => {
  const first = makeCtx()
  const second = makeCtx()
  quiet(() => plugin.apply(first.ctx, {}))
  const firstInstance = globalThis[SINGLETON_KEY]
  assert.notEqual(firstInstance, undefined)

  quiet(() => plugin.apply(second.ctx, {}))
  const secondInstance = globalThis[SINGLETON_KEY]
  assert.notEqual(secondInstance, firstInstance, '第二次 apply 必须换上新实例')

  // 旧实例的 effect 清理是迟到的，不能把新实例的锁清掉
  first.effects[0].dispose()
  assert.equal(globalThis[SINGLETON_KEY], secondInstance)

  second.effects[0].dispose()
  assert.equal(globalThis[SINGLETON_KEY], undefined)
})

test('注册的工具定义落在宿主支持的 JSON Schema 子集内', () => {
  const { ctx, registered } = makeCtx()
  quiet(() => plugin.apply(ctx, {}))

  for (const tool of registered) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.description.length > 0)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')

    const schema = tool.output.schema
    assert.equal(schema.type, 'object')
    assert.ok(Array.isArray(schema.required))
    for (const key of schema.required) {
      assert.ok(Object.hasOwn(schema.properties, key), `${tool.name}: required 字段 ${key} 未在 properties 里声明`)
    }
    if (Object.hasOwn(schema, 'additionalProperties')) {
      assert.equal(typeof schema.additionalProperties, 'boolean')
    }
  }
})

test('状态工具在 watcher 不可用时返回失败值而不是抛错', async () => {
  const { ctx, registered } = makeCtx()
  quiet(() => plugin.apply(ctx, {}))
  const tool = registered.find((entry) => entry.name === 'popo_watch_status')

  const value = await tool.execute({})
  assert.equal(typeof value, 'object')
  assert.equal(typeof value.ok, 'boolean')
  assert.equal(typeof value.summary, 'string')
  assert.equal(typeof value.snapshotJson, 'string')
  assert.doesNotThrow(() => JSON.parse(value.snapshotJson))
})
