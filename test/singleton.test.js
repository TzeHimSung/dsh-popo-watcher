/**
 * 单实例锁测试：HMR 会重复 apply，锁必须保证同一进程里只有一个实例活着。
 *
 * @module dsh-popo-watcher/test/singleton
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SINGLETON_KEY, claimSingleton, currentSingleton } from '../lib/singleton.js'

test('认领后锁指向当前实例，release 清空且幂等', () => {
  const target = {}
  const instance = { dispose() {} }
  const release = claimSingleton(target, instance)

  assert.equal(currentSingleton(target), instance)
  assert.equal(target[SINGLETON_KEY], instance)

  release()
  assert.equal(currentSingleton(target), undefined)
  release() // 幂等
  assert.equal(currentSingleton(target), undefined)
})

test('第二个实例认领时先 dispose 第一个（HMR 场景）', () => {
  const target = {}
  let disposed = 0
  const first = { dispose: () => { disposed += 1 } }
  const second = { dispose() {} }

  const releaseFirst = claimSingleton(target, first)
  const releaseSecond = claimSingleton(target, second)

  assert.equal(disposed, 1, '旧实例必须被 dispose')
  assert.equal(currentSingleton(target), second)

  // 旧实例迟到的 release 不能把新实例的锁清掉
  releaseFirst()
  assert.equal(currentSingleton(target), second)
  releaseSecond()
  assert.equal(currentSingleton(target), undefined)
})

test('旧实例 dispose 抛错不传播，也不阻止新实例上锁', () => {
  const target = {}
  const first = { dispose: () => { throw new Error('boom') } }
  const second = { dispose() {} }

  assert.doesNotThrow(() => claimSingleton(target, first))
  assert.doesNotThrow(() => claimSingleton(target, second))
  assert.equal(currentSingleton(target), second)
})

test('instance 缺少 dispose 也不抛', () => {
  const target = {}
  assert.doesNotThrow(() => claimSingleton(target, {}) )
  assert.doesNotThrow(() => claimSingleton(target, {}))
})

test('target 不可用时返回空释放函数而不是抛错', () => {
  const hostile = {
    get [SINGLETON_KEY]() { throw new Error('boom') },
    set [SINGLETON_KEY](_value) { throw new Error('boom') },
  }
  let release
  assert.doesNotThrow(() => { release = claimSingleton(hostile, {}) })
  assert.equal(typeof release, 'function')
  assert.doesNotThrow(() => release())
})
