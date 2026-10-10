/**
 * "绝不 reject" 测试。
 *
 * 宿主进程里一个未处理的 promise rejection 会直接杀掉 `dsh web`（GUI 掉线、会话中断）。
 * 所以本组对每个公开异步入口注入"全抛"的依赖，断言它们**解析**为结果对象，而不是抛/拒绝。
 *
 * @module dsh-popo-watcher/test/never-rejects
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRpcHandler } from '../lib/rpc.js'
import { createTools } from '../lib/tools.js'
import { createWatcher } from '../lib/watcher.js'

/** 每个方法都抛错的 store。 */
const hostileStore = {
  dataRoot: () => { throw new Error('store boom') },
  groupDir: () => { throw new Error('store boom') },
  nowStamp: () => { throw new Error('store boom') },
  readJson: () => { throw new Error('store boom') },
  writeJsonAtomic: () => { throw new Error('store boom') },
}

/** 每个方法都抛错的 config 模块。 */
const hostileConfig = {
  defaultConfig: () => { throw new Error('config boom') },
  normalizeConfig: () => { throw new Error('config boom') },
  applyPatch: () => { throw new Error('config boom') },
}

test('没有依赖时 watcher 仍然可用（全部降级）', async () => {
  const watcher = createWatcher({})
  // status/getConfig 是同步入口，包成 async 只是为了让 doesNotReject 统一断言。
  await assert.doesNotReject(async () => watcher.status())
  await assert.doesNotReject(async () => watcher.getConfig())
  await assert.doesNotReject(() => watcher.updateConfig({ dryRun: true }))
  await assert.doesNotReject(() => watcher.startWindow())
  await assert.doesNotReject(() => watcher.stop())
  await assert.doesNotReject(() => watcher.keyStatus())
  await assert.doesNotReject(() => watcher.runRound([]))
  await assert.doesNotReject(() => watcher.sendNow({ text: '' }))
  await assert.doesNotReject(() => watcher.importLegacy({ from: 'D:/nope' }))
  assert.doesNotThrow(() => watcher.dispose())
})

test('依赖全抛时每个入口都解析为结果对象', async () => {
  const watcher = createWatcher({ store: hostileStore, config: hostileConfig })

  const status = await watcher.status()
  assert.equal(typeof status, 'object')
  assert.equal(status.ok, true, '快照自身可降级返回')

  const configResult = await watcher.getConfig()
  assert.equal(typeof configResult, 'object')

  const patched = await watcher.updateConfig({ dryRun: true })
  assert.equal(typeof patched, 'object')
  assert.equal(patched.ok, false)

  for (const entry of ['startWindow', 'stop']) {
    const result = await watcher[entry]()
    assert.equal(typeof result, 'object')
  }
})

test('watcher 方法 reject 时 RPC 处理器仍然解析', async () => {
  const rejecting = {
    status: async () => { throw new Error('rpc boom') },
    getConfig: () => { throw new Error('rpc boom') },
    updateConfig: async () => { throw new Error('rpc boom') },
  }
  const handle = createRpcHandler({ watcher: rejecting })

  for (const [endpoint, payload] of [['status', {}], ['config.get', {}], ['config.set', { patch: { dryRun: true } }]]) {
    const result = await handle(endpoint, payload)
    assert.equal(result.ok, false)
    assert.match(result.error.message, /boom/)
  }
})

test('watcher 方法 reject 时工具仍然解析为结果对象', async () => {
  const tools = createTools({ watcher: { status: async () => { throw new Error('tool boom') } } })
  const value = await tools[0].execute({})
  assert.equal(value.ok, false)
  assert.match(value.summary, /tool boom/)
  assert.equal(value.snapshotJson, '{}')
})

test('工具在完全没有 watcher 时也解析', async () => {
  const tools = createTools({})
  const value = await tools[0].execute({})
  assert.equal(value.ok, false)
  assert.equal(typeof value.summary, 'string')
})
