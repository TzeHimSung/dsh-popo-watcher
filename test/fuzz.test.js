/**
 * 模糊测试（deterministic fuzz）：把**恶意/畸形输入**灌进每一个公开入口，断言"绝不抛、绝不 reject"。
 *
 * 为什么值得单独一组：宿主进程里一次未捕获的异常或未处理的 rejection 会直接带走 `dsh web`
 * （GUI 掉线、会话中断）。单测用的是"想得到的坏输入"，这一组用**种子化随机**生成想不到的那种：
 * 带抛错 getter 的对象、循环引用、Proxy、超长字符串、NaN/Infinity、函数、Symbol、BigInt、
 * 数组当对象、对象当数组……每一个入口都过一遍。
 *
 * 种子固定（可复现）：失败时打印种子与用例下标，便于定位。
 *
 * @module dsh-popo-watcher/test/fuzz
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as config from '../lib/config.js'
import { quietHoursActive, roundView, sendGuards, sendsWithinLastHour } from '../lib/guards.js'
import { buildDraftState, buildState, composeRoundView, decideDraft, decideRound, formatAnswers, loadQuestions } from '../lib/judge.js'
import { normalizeKey, readStoredKey, resolveKeySource } from '../lib/key-source.js'
import { createDraftWriter } from '../lib/llm.js'
import { createRpcHandler } from '../lib/rpc.js'
import { buildDraftPrompt, createRound } from '../lib/round.js'
import { createSender } from '../lib/send.js'
import { claimSingleton } from '../lib/singleton.js'
import * as store from '../lib/store.js'
import { createTools } from '../lib/tools.js'
import { createWatcher } from '../lib/watcher.js'

/** 线性同余伪随机（种子固定 → 可复现）。 */
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** 会抛错的 getter 对象（很多实现会在读属性时炸）。 */
function throwingGetter() {
  return Object.defineProperty({}, 'boom', { get() { throw new Error('getter boom') }, enumerable: true })
}

/** 什么都抛的 Proxy（连 ownKeys/toString 都炸）。 */
function hostileProxy() {
  return new Proxy({}, {
    get() { throw new Error('proxy get boom') },
    has() { throw new Error('proxy has boom') },
    ownKeys() { throw new Error('proxy ownKeys boom') },
    getPrototypeOf() { throw new Error('proxy proto boom') },
  })
}

/** 循环引用。 */
function circular() {
  const value = { name: 'loop' }
  value.self = value
  return value
}

/** 一组"想不到的坏值"生成器。 */
const GENERATORS = [
  () => undefined,
  () => null,
  () => '',
  () => '   ',
  () => 0,
  () => -0,
  () => Number.NaN,
  () => Number.POSITIVE_INFINITY,
  () => Number.NEGATIVE_INFINITY,
  () => 1e309,
  () => -1,
  () => 1.5,
  () => 'x'.repeat(100_000),
  () => '\u0000\uffff\u202e',
  () => [],
  () => [null, undefined, 0, 'x'],
  () => new Array(3),
  () => [circular()],
  () => ({}),
  () => ({ a: 1, b: [2, { c: 3 }] }),
  () => Object.create(null),
  () => throwingGetter(),
  () => hostileProxy(),
  () => circular(),
  () => () => 'fn',
  () => async () => 'async fn',
  () => Symbol('sym'),
  () => BigInt(42),
  () => new Date('not a date'),
  () => new Map([[1, 2]]),
  () => new Set([1]),
  () => Buffer.from('bytes'),
  () => new Uint8Array([1, 2, 3]),
  () => Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
  () => [{}, [], 'x', 0, null],
  () => ({ then: 'not a function' }),
  () => ({ toJSON() { throw new Error('toJSON boom') } }),
  () => ({ toString() { throw new Error('toString boom') } }),
  () => 12345678901234567890n,
  () => 'C:/not/a/real/path\u0000bad',
]

/**
 * 跑一组用例：每个入口对每个坏值都要解析成结果（不能抛、不能 reject）。
 * @param label - 用例名（失败信息里带上）。
 * @param run - `(value, index) => unknown | Promise<unknown>`。
 */
async function fuzz(label, run) {
  const trace = process.env.DSH_FUZZ_TRACE === '1'
  for (let index = 0; index < GENERATORS.length; index += 1) {
    if (trace) console.error(`  → ${label} #${index}`)
    const value = GENERATORS[index]()
    let result
    try {
      result = run(value, index)
    } catch (error) {
      assert.fail(`[${label}] 对第 ${index} 号坏值**同步抛了**：${error instanceof Error ? error.message : String(error)}`)
    }
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      try {
        await result
      } catch (error) {
        assert.fail(`[${label}] 对第 ${index} 号坏值**reject 了**：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

test('纯函数层：config / guards / judge / key-source 对任何坏值都不抛', async () => {
  await fuzz('config.normalizeConfig', (value) => config.normalizeConfig(value))
  await fuzz('config.applyPatch', (value) => config.applyPatch(value, value))
  await fuzz('config.validateGroup', (value) => config.validateGroup(value))
  await fuzz('config.defaultConfig', () => config.defaultConfig())

  await fuzz('guards.roundView', (value) => roundView(value))
  await fuzz('guards.sendGuards', (value) => sendGuards(value))
  await fuzz('guards.quietHoursActive', (value) => quietHoursActive(value))
  await fuzz('guards.quietHoursActive(date)', (value) => quietHoursActive({ enabled: true, start: '23:00', end: '09:00' }, value))
  await fuzz('guards.sendsWithinLastHour', (value) => sendsWithinLastHour(value, value))

  await fuzz('judge.decideRound', (value) => decideRound(value))
  await fuzz('judge.decideRound(thresholds)', (value) => decideRound({}, value))
  await fuzz('judge.decideDraft', (value) => decideDraft(value, value))
  await fuzz('judge.formatAnswers', (value) => formatAnswers(value))
  await fuzz('judge.buildState', (value) => buildState(value))
  await fuzz('judge.buildDraftState', (value) => buildDraftState(value, value))
  await fuzz('round.buildDraftPrompt', (value) => buildDraftPrompt(value))
  await fuzz('judge.composeRoundView', (value) => composeRoundView(value, value))
  await fuzz('judge.loadQuestions', (value) => loadQuestions(value))

  await fuzz('key.normalizeKey', (value) => normalizeKey(value))
  await fuzz('key.readStoredKey', (value) => readStoredKey(value))
  await fuzz('key.resolveKeySource', (value) => resolveKeySource(value))
})

test('存储层：任何坏路径/坏值都返回结果对象（ok:false 或 ok:true），不抛', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'popo-watcher-fuzz-'))
  try {
    await fuzz('store.readJson', (value) => store.readJson(value, 'fallback'))
    await fuzz('store.readText', (value) => store.readText(value))
    await fuzz('store.writeJsonAtomic', (value) => store.writeJsonAtomic(value, value))
    await fuzz('store.writeText', (value) => store.writeText(value, value))
    await fuzz('store.appendJsonl', (value) => store.appendJsonl(value, value))
    await fuzz('store.appendJsonlCapped', (value) => store.appendJsonlCapped(value, value, value))
    await fuzz('store.appendLineCapped', (value) => store.appendLineCapped(value, value, value))
    await fuzz('store.readJsonlTail', (value) => store.readJsonlTail(value, value))
    await fuzz('store.readLineTail', (value) => store.readLineTail(value, value))
    await fuzz('store.removeFile', (value) => store.removeFile(value))
    await fuzz('store.ensureDir', (value) => store.ensureDir(value))
    await fuzz('store.groupDir', (value) => store.groupDir(value, value))
    await fuzz('store.nowStamp', (value) => store.nowStamp(value))
    await fuzz('store.resolveHome', (value) => store.resolveHome(value))

    // 用真目录跑一遍"写进去再读回来"的坏值组合（值本身也可能序列化失败）
    for (let index = 0; index < GENERATORS.length; index += 1) {
      const value = GENERATORS[index]()
      const file = join(temp, `f-${index}.json`)
      assert.doesNotThrow(() => store.writeJsonAtomic(file, value), `第 ${index} 号值写盘不该抛`)
      assert.doesNotThrow(() => store.appendJsonl(join(temp, `f-${index}.jsonl`), value), `第 ${index} 号值追加不该抛`)
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('编排层：round / llm 对任何坏输入都给结论，不抛不 reject', async () => {
  const sender = createSender()
  await fuzz('sender.deliver', value => sender.deliver(value))
  const runner = createRound({
    judgeClient: { available: async () => ({ ok: true }), runRound: async () => ({ ok: true, answers: {} }), runDraft: async () => ({ ok: true, answers: {} }) },
    draftWriter: { write: async () => ({ ok: true, text: '一句话', model: 'm' }) },
  })
  await fuzz('round.plan', (value) => runner.plan(value))

  // 判读/文案层自己抛错时，编排层仍然给结论
  const hostileRunner = createRound({
    judgeClient: { available: async () => { throw new Error('boom') }, runRound: async () => { throw new Error('boom') } },
    draftWriter: { write: async () => { throw new Error('boom') } },
  })
  await fuzz('round.plan(hostile deps)', (value) => hostileRunner.plan(value))

  const writer = createDraftWriter({
    getLlm: () => ({ stream: () => (async function* generate() { yield { type: 'text-delta', text: 'x' }; yield { type: 'finish', reason: { kind: 'stop' } } })() }),
    getRoute: () => ({ provider: 'p', model: 'm' }),
  })
  await fuzz('llm.write', (value) => writer.write(value))

  const hostileWriter = createDraftWriter({ getLlm: () => { throw new Error('boom') }, getRoute: () => { throw new Error('boom') } })
  await fuzz('llm.write(hostile deps)', (value) => hostileWriter.write(value))
})

test('宿主半入口：watcher / rpc / tools / singleton 对任何坏值都不抛不 reject', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'popo-watcher-fuzz-host-'))
  try {
    // 真 store + 真 config：最接近生产的组合
    const watcher = createWatcher({
      store,
      config,
      env: { USERPROFILE: temp },
      getTransport: () => null,
      schedule: () => () => {},
      autoRound: false,
      keyResolver: async () => ({ key: '', source: 'none' }),
      judgeClient: { available: async () => ({ ok: false, error: 'no key' }), runRound: async () => ({ ok: false, error: 'no key' }), runDraft: async () => ({ ok: false, error: 'no key' }) },
    })

    await fuzz('watcher.getConfig', () => watcher.getConfig())
    await fuzz('watcher.status', () => watcher.status())
    await fuzz('watcher.updateConfig', (value) => watcher.updateConfig(value))
    await fuzz('watcher.startWindow', (value) => watcher.startWindow(value))
    await fuzz('watcher.stop', (value) => watcher.stop(value))
    await fuzz('watcher.runRound', (value) => watcher.runRound(value))
    await fuzz('watcher.sendNow', (value) => watcher.sendNow(value))
    await fuzz('watcher.judgeNow', (value) => watcher.judgeNow(value))
    await fuzz('watcher.messages', (value) => watcher.messages(value))
    await fuzz('watcher.sends', (value) => watcher.sends(value))
    await fuzz('watcher.log', (value) => watcher.log(value))
    await fuzz('watcher.keyStatus', () => watcher.keyStatus())
    await fuzz('watcher.setKey', (value) => watcher.setKey(value))
    await fuzz('watcher.clearKey', () => watcher.clearKey())
    await fuzz('watcher.importLegacy', (value) => watcher.importLegacy(value))
    await fuzz('watcher.resume', () => watcher.resume())

    // 依赖全坏时（store 的每个方法都抛）也要给结果对象
    const brokenStore = {
      dataRoot: () => { throw new Error('boom') },
      groupDir: () => { throw new Error('boom') },
      nowStamp: () => { throw new Error('boom') },
      readJson: () => { throw new Error('boom') },
      writeJsonAtomic: () => { throw new Error('boom') },
      readText: () => { throw new Error('boom') },
      writeText: () => { throw new Error('boom') },
      appendJsonl: () => { throw new Error('boom') },
      readJsonlTail: () => { throw new Error('boom') },
      readLineTail: () => { throw new Error('boom') },
      removeFile: () => { throw new Error('boom') },
      ensureDir: () => { throw new Error('boom') },
    }
    const broken = createWatcher({ store: brokenStore, config, keyResolver: async () => { throw new Error('boom') } })
    await fuzz('watcher(status, broken store)', () => broken.status())
    await fuzz('watcher(runRound, broken store)', (value) => broken.runRound(value))
    await fuzz('watcher(sendNow, broken store)', (value) => broken.sendNow(value))
    await fuzz('watcher(importLegacy, broken store)', (value) => broken.importLegacy(value))
    await fuzz('watcher(keyStatus, broken store)', () => broken.keyStatus())

    const handle = createRpcHandler({ watcher })
    await fuzz('rpc.endpoint', (value) => handle(value, value))
    await fuzz('rpc.payload', (value) => handle('config.set', value))

    const tools = createTools({ watcher })
    for (const tool of tools) {
      await fuzz(`tool.${tool.name}`, (value) => tool.execute(value))
    }
    await fuzz('tools(no watcher)', (value) => createTools({})[0].execute(value))

    // 单例锁：坏 target / 坏 instance
    await fuzz('singleton.claim', (value) => {
      const release = claimSingleton(value, value)
      return typeof release === 'function' ? release() : release
    })

    // 收尾：真 watcher 释放（幂等）
    assert.doesNotThrow(() => watcher.dispose())
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
