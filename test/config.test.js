/**
 * 配置模块测试：默认值、逐字段回落、增量 patch、群 ID 校验。
 *
 * 契约（见 `docs/interfaces.md` §1）：纯函数、无 IO、**绝不抛错**；非法值回落默认值并给一条中文告警；
 * 未知字段一律忽略。因此下面每一次调用都过 `call()` 这层 `assert.doesNotThrow` 壳。
 *
 * @module dsh-popo-watcher/test/config
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULTS, applyPatch, defaultConfig, normalizeConfig, validateGroup } from '../lib/config.js'

/** DEFAULTS 的快照：跑完所有用例后要对拍，证明常量没被改到。 */
const DEFAULTS_SNAPSHOT = JSON.parse(JSON.stringify(DEFAULTS))

/** 契约里的顶层字段清单，逐字段比对用。 */
const FIELDS = [
  'group',
  'intervalSec',
  'windowHours',
  'minGapSec',
  'maxChars',
  'hardMaxChars',
  'dryRun',
  'autoResume',
  'opening',
  'quietHours',
  'hourlyCap',
  'judge',
  'llm',
  'prompt',
  'popoCliJs',
]

/** 所有调用都从这里走：纯函数契约是绝不抛错。 */
function call(fn, label = 'call') {
  let out
  assert.doesNotThrow(() => { out = fn() }, `${label} 不应抛错`)
  return out
}

/** 规范化 + 不抛壳。 */
function normalize(raw, label) {
  return call(() => normalizeConfig(raw), `normalizeConfig(${label})`)
}

/** patch + 不抛壳。 */
function patch(current, value, label) {
  return call(() => applyPatch(current, value), `applyPatch(${label})`)
}

/** 断言告警里有提到某个字段/关键字（不一定只有一条）。 */
function hasWarning(warnings, needle, label) {
  assert.ok(
    warnings.some((w) => w.includes(needle)),
    `${label}: 告警应提到 ${needle}，实际 ${JSON.stringify(warnings)}`,
  )
}

/** 断言恰好一条告警、且提到某个字段/关键字。 */
function onlyWarning(warnings, needle, label) {
  assert.equal(warnings.length, 1, `${label}: 应恰好一条告警，实际 ${JSON.stringify(warnings)}`)
  hasWarning(warnings, needle, label)
}

test('defaultConfig() 逐字段等于 DEFAULTS', () => {
  const config = call(defaultConfig, 'defaultConfig()')

  assert.deepEqual(Object.keys(config).sort(), [...FIELDS].sort(), '字段集合应与接口契约一致')
  for (const key of FIELDS) {
    assert.deepEqual(config[key], DEFAULTS[key], `${key} 应等于 DEFAULTS.${key}`)
  }
  assert.deepEqual(config, DEFAULTS, '整体也应等于 DEFAULTS')
})

test('defaultConfig() 两次调用互不共享引用，改一份不影响另一份', () => {
  const a = call(defaultConfig, 'defaultConfig()#1')
  const b = call(defaultConfig, 'defaultConfig()#2')

  assert.notEqual(a.opening, b.opening, '嵌套对象不能是同一个引用')
  assert.notEqual(a.quietHours, b.quietHours)
  assert.notEqual(a.judge, b.judge)
  assert.notEqual(a.judge.thresholds, b.judge.thresholds)
  assert.notEqual(a.llm, b.llm)
  assert.notEqual(a.prompt, b.prompt)

  // 把 a 的每一层都改掉
  a.group = '123456'
  a.dryRun = true
  a.opening.enabled = false
  a.opening.text = '改过了'
  a.quietHours.start = '00:00'
  a.hourlyCap.max = 60
  a.judge.model = 'other'
  a.judge.thresholds.draftRepeat = 0
  a.llm.provider = 'openai'
  a.prompt.system = '改过了'
  a.popoCliJs = 'C:\\x\\cli.js'

  for (const key of FIELDS) {
    assert.deepEqual(b[key], DEFAULTS[key], `改 a 之后 b.${key} 仍是默认值`)
  }
  assert.deepEqual(call(defaultConfig, 'defaultConfig()#3'), DEFAULTS, '新拿到的默认配置不受 a 影响')
})

test('normalizeConfig(null / undefined) 返回默认配置且不告警', () => {
  for (const raw of [null, undefined]) {
    const { config, warnings } = normalize(raw, String(raw))
    assert.deepEqual(config, DEFAULTS, `${String(raw)} → 默认配置`)
    assert.deepEqual(warnings, [], `${String(raw)} → 不告警`)
  }
})

test("normalizeConfig('x' / [] / 42) 回落默认配置并告警", () => {
  for (const raw of ['x', [], 42]) {
    const label = JSON.stringify(raw)
    const { config, warnings } = normalize(raw, label)
    assert.deepEqual(config, DEFAULTS, `${label} → 默认配置`)
    assert.equal(warnings.length, 1, `${label} → 恰好一条告警，实际 ${JSON.stringify(warnings)}`)
    hasWarning(warnings, '不是对象', label)
  }
})

test('normalizeConfig 数值非法时各自回落默认值 + 对应告警', () => {
  const cases = [
    ['intervalSec', '20'],
    ['minGapSec', 1],
    ['windowHours', 0],
    ['hardMaxChars', 5],
  ]
  for (const [key, bad] of cases) {
    const label = `${key}=${JSON.stringify(bad)}`
    const { config, warnings } = normalize({ [key]: bad }, label)
    assert.equal(config[key], DEFAULTS[key], `${label} → 回落默认 ${DEFAULTS[key]}`)
    assert.deepEqual(config, DEFAULTS, `${label} → 其它字段不受影响`)
    onlyWarning(warnings, key, label)
  }
})

test('normalizeConfig 忽略未知字段且不报错、不告警', () => {
  const { config, warnings } = normalize({ nope: 1, extra: { a: 1 }, list: [1, 2] }, '未知字段')

  assert.deepEqual(config, DEFAULTS, '未知字段不进配置')
  assert.equal(Object.hasOwn(config, 'nope'), false, 'nope 不应出现在配置里')
  assert.equal(Object.hasOwn(config, 'extra'), false, 'extra 不应出现在配置里')
  assert.deepEqual(warnings, [], '未知字段不算错误，不应告警')
})

test("normalizeConfig group='abc' 清空目标并告警，合法群 ID 采纳", () => {
  const bad = normalize({ group: 'abc' }, "group='abc'")
  assert.equal(bad.config.group, '', '非法群 ID 不可回落到真实目标群')
  assert.deepEqual(bad.config, DEFAULTS)
  onlyWarning(bad.warnings, 'group', "group='abc'")

  const ok = normalize({ group: '123456' }, "group='123456'")
  assert.equal(ok.config.group, '123456', '合法群 ID 应被采纳')
  assert.deepEqual(ok.warnings, [], '合法群 ID 不告警')

  const padded = normalize({ group: ' 123456 ' }, "group=' 123456 '")
  assert.equal(padded.config.group, '123456', '首尾空格在规范化时去掉')
})

test('normalizeConfig opening.text 空串回落默认文案 + 告警', () => {
  const { config, warnings } = normalize({ opening: { text: '' } }, "opening.text=''")

  assert.equal(config.opening.text, DEFAULTS.opening.text, '空文案回落默认文案')
  assert.equal(config.opening.enabled, true, 'enabled 缺省时保持默认 true')
  assert.deepEqual(config, DEFAULTS)
  onlyWarning(warnings, 'opening.text', "opening.text=''")
})

test('normalizeConfig opening.text 合法时采纳，enabled 保持默认 true', () => {
  const { config, warnings } = normalize({ opening: { text: '你好' } }, "opening.text='你好'")

  assert.equal(config.opening.text, '你好', '合法文案应被采纳')
  assert.equal(config.opening.enabled, true, 'enabled 缺省时保持默认 true')
  assert.deepEqual(warnings, [])
})

test("normalizeConfig quietHours.start='25:00' 回落 + 告警，'08:30' 采纳", () => {
  const bad = normalize({ quietHours: { start: '25:00' } }, "quietHours.start='25:00'")
  assert.equal(bad.config.quietHours.start, '23:00', '非法时刻回落默认 start')
  assert.deepEqual(bad.config, DEFAULTS)
  onlyWarning(bad.warnings, 'quietHours.start', "quietHours.start='25:00'")

  const ok = normalize({ quietHours: { start: '08:30' } }, "quietHours.start='08:30'")
  assert.equal(ok.config.quietHours.start, '08:30', '合法时刻应被采纳')
  assert.equal(ok.config.quietHours.end, DEFAULTS.quietHours.end, '未提及的字段保持默认')
  assert.deepEqual(ok.warnings, [])
})

test("normalizeConfig judge.unavailablePolicy='x' 回落 'quiet' + 告警", () => {
  const { config, warnings } = normalize({ judge: { unavailablePolicy: 'x' } }, "judge.unavailablePolicy='x'")

  assert.equal(config.judge.unavailablePolicy, 'quiet', "非法策略回落 'quiet'")
  assert.deepEqual(config, DEFAULTS)
  onlyWarning(warnings, 'judge.unavailablePolicy', "judge.unavailablePolicy='x'")
})

test('normalizeConfig judge.thresholds 越界回落默认阈值 + 告警', () => {
  const label = 'judge.thresholds.draftRepeat=1.5'
  const { config, warnings } = normalize({ judge: { thresholds: { draftRepeat: 1.5 } } }, label)

  assert.equal(config.judge.thresholds.draftRepeat, DEFAULTS.judge.thresholds.draftRepeat, '越界阈值回落默认')
  assert.deepEqual(config, DEFAULTS)
  onlyWarning(warnings, 'judge.thresholds.draftRepeat', label)
})

test('defaultConfig() 本身再规范化不应产生任何告警', () => {
  const current = call(defaultConfig, 'defaultConfig()')
  const { config, warnings } = normalize(current, 'defaultConfig()')

  assert.deepEqual(config, DEFAULTS)
  assert.deepEqual(warnings, [], '默认配置必须是"已经规范化好的"配置')
})

test('applyPatch(current, { dryRun: true }) 只改 dryRun，其它字段与 current 一致', () => {
  const current = normalize(
    { group: '123456', intervalSec: 30, dryRun: false, opening: { text: '你好' } },
    'current',
  ).config
  const { config, warnings } = patch(current, { dryRun: true }, '{ dryRun: true }')

  assert.equal(config.dryRun, true, 'dryRun 应被改成 true')
  assert.deepEqual(config, { ...current, dryRun: true }, '除 dryRun 外都应与 current 一致')
  assert.deepEqual(warnings, [], '合法 patch 不应告警')
  assert.equal(current.dryRun, false, '不能就地改到 current')

  // 未被 patch 的字段保持 current 的值，而不是回落 DEFAULTS
  assert.equal(config.group, '123456')
  assert.equal(config.intervalSec, 30)
  assert.equal(config.opening.text, '你好')
})

test('applyPatch(current, { nope: 1 }) 忽略未知字段，并给出含字段名的告警', () => {
  const current = call(defaultConfig, 'defaultConfig()')
  const { config, warnings } = patch(current, { nope: 1 }, '{ nope: 1 }')

  assert.deepEqual(config, DEFAULTS, '未知字段不进配置')
  assert.equal(Object.hasOwn(config, 'nope'), false)
  onlyWarning(warnings, 'nope', '未知字段 patch')
})

test('applyPatch(current, null) 返回规范化后的 current + 告警，不抛', () => {
  const current = normalize({ group: '123456', dryRun: true }, 'current').config
  const { config, warnings } = patch(current, null, 'null')

  assert.deepEqual(config, normalize(current, 'current#2').config, '都按 current 规范化后的结果返回')
  assert.equal(config.group, '123456', 'current 的值必须保留')
  assert.equal(config.dryRun, true)
  onlyWarning(warnings, 'patch', 'applyPatch(current, null)')
})

test('validateGroup 接受纯数字群 ID，并去掉首尾空格', () => {
  assert.equal(call(() => validateGroup('1234567'), "validateGroup('1234567')"), '1234567')
  assert.equal(call(() => validateGroup(' 1234567 '), "validateGroup(' 1234567 ')"), '1234567')
})

test('validateGroup 对非法输入一律返回 undefined', () => {
  for (const bad of ['abc', '', 123, null]) {
    const label = JSON.stringify(bad)
    const out = call(() => validateGroup(bad), `validateGroup(${label})`)
    assert.equal(out, undefined, `validateGroup(${label}) 应为 undefined`)
  }
  assert.equal(call(() => validateGroup(undefined), 'validateGroup(undefined)'), undefined)
})

test('恶意/畸形输入也绝不抛错', () => {
  const weird = [
    'x', 42, [], null, undefined, true,
    { group: {} },
    { opening: [] },
    { opening: 'x' },
    { quietHours: 7 },
    { judge: 'x' },
    { judge: { thresholds: [] } },
    { llm: 0 },
    { prompt: [] },
    { intervalSec: Number.NaN },
    { dryRun: 'yes' },
    { popoCliJs: 5 },
  ]
  for (const raw of weird) {
    const label = JSON.stringify(raw) ?? String(raw)
    const { config, warnings } = normalize(raw, label)
    assert.equal(typeof config, 'object', `${label} → 仍应返回配置对象`)
    assert.ok(Array.isArray(warnings), `${label} → warnings 仍应是数组`)
  }

  const current = call(defaultConfig, 'defaultConfig()')
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    const label = JSON.stringify(bad) ?? String(bad)
    const { config, warnings } = patch(current, bad, label)
    assert.deepEqual(config, DEFAULTS, `${label} → patch 不改配置`)
    assert.equal(warnings.length, 1, `${label} → 恰好一条告警`)
  }
})

test('用例跑完后 DEFAULTS 常量未被污染', () => {
  assert.deepEqual(DEFAULTS, DEFAULTS_SNAPSHOT, 'DEFAULTS 是共享常量，任何用例都不得改到它')
})

test('嵌套 patch 只改明确字段，保留模型、策略、阈值及其它隐藏配置', () => {
  const current = defaultConfig()
  current.judge.model = 'custom-model'
  current.judge.timeoutMs = 12345
  current.judge.unavailablePolicy = 'llm'
  current.judge.thresholds.roundFiller = 0.97
  current.judge.thresholds.draftRepeat = 0.42
  current.hourlyCap.max = 17
  const before = JSON.parse(JSON.stringify(current))
  const { config, warnings } = applyPatch(current, {
    judge: { enabled: false, model: undefined, thresholds: { draftRepeat: 0.6 } },
    hourlyCap: { enabled: true },
  })
  assert.deepEqual(config, {
    ...before,
    judge: { ...before.judge, enabled: false, thresholds: { ...before.judge.thresholds, draftRepeat: 0.6 } },
    hourlyCap: { ...before.hourlyCap, enabled: true },
  })
  assert.deepEqual(current, before)
  assert.deepEqual(warnings, [])
})

test('嵌套未知字段不会进入配置；显式非法值继续规范化并告警', () => {
  const current = defaultConfig()
  current.judge.timeoutMs = 12345
  const { config, warnings } = applyPatch(current, JSON.parse('{"judge":{"timeoutMs":-1,"unknown":1,"__proto__":{"polluted":true},"thresholds":{"unknown":1}},"constructor":42}'))
  assert.equal(config.judge.timeoutMs, DEFAULTS.judge.timeoutMs)
  assert.equal(Object.hasOwn(config.judge, 'unknown'), false)
  assert.equal(Object.hasOwn(config.judge, '__proto__'), false)
  assert.equal({}.polluted, undefined)
  assert.ok(warnings.some(line => line.includes('timeoutMs')))
  assert.ok(warnings.some(line => line.includes('judge.thresholds.unknown')))
})
