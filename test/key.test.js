/**
 * 判读 key 的存取测试：优先级顺序、清洗规则、以及**绝不泄露**。
 *
 * 分两层：
 * - `lib/key-source.js`：纯解析/读取（用临时目录里的真文件）；
 * - `lib/watcher.js`：`keyStatus` / `setKey` / `clearKey`（桩 store + 注入的 key 解析器，
 *   所以既不会碰本机真实的注册表 key，也不会容忍解析器抛错）。
 *
 * @module dsh-popo-watcher/test/key
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { defaultConfig } from '../lib/config.js'
import { normalizeKey, readStoredKey, resolveKey, resolveKeySource, storedKeyFile, STORED_KEY_FIELD } from '../lib/key-source.js'
import * as store from '../lib/store.js'
import { createWatcher } from '../lib/watcher.js'

const SECRET = 'ts_live_do_not_leak_0123456789'
/** 一个几乎不可能存在的环境变量名：用来测"没有来源"这条路径，不读注册表真值。 */
const ABSENT_NAME = 'TYPESAFE_API_KEY_DEFINITELY_UNSET_9Z3'

/** 临时目录（用完就删）。 */
function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'popo-watcher-key-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* -------------------------------------------------------------------------- */
/* key-source                                                                  */
/* -------------------------------------------------------------------------- */

test('normalizeKey：去空白、剥引号，拒绝换行/超长/非字符串', () => {
  assert.equal(normalizeKey('  abc  '), 'abc')
  assert.equal(normalizeKey('"abc"'), 'abc')
  assert.equal(normalizeKey("'abc'"), 'abc')
  assert.equal(normalizeKey('a\nb'), '')
  assert.equal(normalizeKey('a\tb'), '')
  assert.equal(normalizeKey('   '), '')
  assert.equal(normalizeKey('x'.repeat(513)), '')
  assert.equal(normalizeKey('x'.repeat(512)), 'x'.repeat(512), '512 字是允许的上限')
  assert.equal(normalizeKey(null), '')
  assert.equal(normalizeKey(12345), '')
})

test('storedKeyFile：跟着数据根走，空数据根给空串', () => {
  assert.equal(storedKeyFile('C:/x/.dsh/popo-watcher'), 'C:/x/.dsh/popo-watcher/secret.json')
  assert.equal(storedKeyFile(''), '')
  assert.equal(storedKeyFile(undefined), '')
  assert.equal(readStoredKey(''), '', '空路径直接读不到，不抛')
})

test('readStoredKey：缺文件/坏 JSON/空字段/怪类型都回落空串', () => {
  withTempDir((dir) => {
    const file = join(dir, 'secret.json')
    assert.equal(readStoredKey(file), '', '文件不存在')

    assert.equal(store.writeJsonAtomic(file, { [STORED_KEY_FIELD]: SECRET }).ok, true)
    assert.equal(readStoredKey(file), SECRET)

    store.writeJsonAtomic(file, { [STORED_KEY_FIELD]: '   ' })
    assert.equal(readStoredKey(file), '', '只有空白等于没有')

    store.writeJsonAtomic(file, { [STORED_KEY_FIELD]: 42 })
    assert.equal(readStoredKey(file), '', '非字符串字段忽略')

    store.writeJsonAtomic(file, { other: SECRET })
    assert.equal(readStoredKey(file), '', '字段名不对就当没有')

    writeFileSync(file, '{ not json', 'utf8')
    assert.equal(readStoredKey(file), '', '坏 JSON 不抛')
  })
})

test('resolveKeySource：显式 → 文件 → 进程环境变量 的优先级', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'secret.json')
    const env = { TYPESAFE_API_KEY: 'from-env' }

    assert.deepEqual(await resolveKeySource({ file, env }), { key: 'from-env', source: 'env' })

    store.writeJsonAtomic(file, { [STORED_KEY_FIELD]: 'from-file' })
    assert.deepEqual(await resolveKeySource({ file, env }), { key: 'from-file', source: 'file' }, '文件要压过环境变量')

    assert.deepEqual(
      await resolveKeySource({ file, env, explicit: 'from-explicit' }),
      { key: 'from-explicit', source: 'explicit' },
    )
  })
})

test('resolveKeySource：环境对象坏掉、文件是目录，都不抛', async () => {
  const hostile = {}
  Object.defineProperty(hostile, 'TYPESAFE_API_KEY', { get() { throw new Error('boom') } })
  const resolved = await resolveKeySource({ env: hostile, name: ABSENT_NAME, file: '' })
  assert.equal(resolved.key, '')
  assert.equal(resolved.source, 'none')

  await withTempDir(async (dir) => {
    const asDir = join(dir, 'not-a-file')
    mkdirSync(asDir)
    const fromDir = await resolveKeySource({ file: asDir, env: {}, name: ABSENT_NAME })
    assert.equal(fromDir.key, '')
    assert.equal(fromDir.source, 'none')
  })
})

test('resolveKey 返回字符串且 never-throw（与 resolveKeySource 同源）', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'secret.json')
    store.writeJsonAtomic(file, { [STORED_KEY_FIELD]: SECRET })
    assert.equal(await resolveKey({ file }), SECRET)
  })
  assert.equal(typeof (await resolveKey({ name: ABSENT_NAME, env: {}, file: '' })), 'string')
})

/* -------------------------------------------------------------------------- */
/* watcher：keyStatus / setKey / clearKey                                      */
/* -------------------------------------------------------------------------- */

const SECRET_PATH = 'C:/fake/.dsh/popo-watcher/secret.json'

/** 桩 store：内存 JSON 表 + 记录写入与删除。 */
function fakeStore() {
  const files = new Map()
  const writes = []
  const removals = []
  return {
    files,
    writes,
    removals,
    dataRoot: () => 'C:/fake/.dsh/popo-watcher',
    groupDir: (root, group) => `${root}/${group}`,
    nowStamp: () => '2026-09-22 10:00:00',
    readJson: (file, fallback) => (files.has(file) ? { ok: true, value: files.get(file) } : { ok: false, value: fallback, error: 'ENOENT', code: 'ENOENT' }),
    writeJsonAtomic: (file, value) => {
      writes.push({ file, value })
      files.set(file, value)
      return { ok: true }
    },
    removeFile: (file) => {
      removals.push(file)
      files.delete(file)
      return { ok: true }
    },
  }
}

/** 造一个 watcher（key 解析器注入，不碰注册表）。 */
function makeWatcher({ store: storeStub = fakeStore(), resolve = async () => ({ key: '', source: 'none' }) } = {}) {
  const cfg = defaultConfig()
  const watcher = createWatcher({
    store: storeStub,
    config: {
      defaultConfig: () => ({ ...cfg }),
      normalizeConfig: () => ({ config: { ...cfg }, warnings: [] }),
      applyPatch: (current, patch) => ({ config: { ...current, ...patch }, warnings: [] }),
    },
    now: () => new Date('2026-09-22T10:00:00'),
    keyResolver: resolve,
  })
  return { watcher, store: storeStub }
}

test('keyStatus：只报有没有与来源，绝不回显 key', async () => {
  const missing = makeWatcher({ resolve: async () => ({ key: '', source: 'none' }) })
  assert.deepEqual(await missing.watcher.keyStatus(), { ok: true, configured: false, source: 'none', stored: false })

  const stored = makeWatcher({ resolve: async () => ({ key: SECRET, source: 'file' }) })
  const withKey = await stored.watcher.keyStatus()
  assert.equal(withKey.configured, true)
  assert.equal(withKey.source, 'file')
  assert.equal(JSON.stringify(withKey).includes(SECRET), false, 'key 绝不能出现在返回里')

  // 解析器抛错也不能把状态接口带崩（页面每 2 秒要看它）。
  const hostile = makeWatcher({ resolve: async () => { throw new Error('boom') } })
  const failed = await hostile.watcher.keyStatus()
  assert.equal(failed.ok, true)
  assert.equal(failed.configured, false)
})

test('keyStatus：文件还在但解析器说没有时，以"能用"为准（不许显示未配置）', async () => {
  const storeStub = fakeStore()
  storeStub.files.set(SECRET_PATH, { [STORED_KEY_FIELD]: SECRET })
  // 解析器（这里故意用一个"什么都不认"的桩）说没有，但文件明明在。
  const { watcher } = makeWatcher({ store: storeStub, resolve: async () => ({ key: '', source: 'none' }) })

  const status = await watcher.keyStatus()
  assert.equal(status.configured, true)
  assert.equal(status.source, 'file')
  assert.equal(status.stored, true)
  assert.equal(JSON.stringify(status).includes(SECRET), false)
})

test('setKey：清洗后落盘，返回值不含 key；非法输入直接拒', async () => {
  const { watcher, store: storeStub } = makeWatcher()
  const saved = await watcher.setKey(`  ${SECRET}  `)

  assert.equal(saved.ok, true)
  assert.equal(saved.configured, true)
  assert.equal(saved.source, 'file')
  assert.equal(JSON.stringify(saved).includes(SECRET), false, '返回值里绝不能出现 key')

  assert.equal(storeStub.writes.length, 1)
  assert.equal(storeStub.writes[0].file, SECRET_PATH)
  assert.equal(storeStub.writes[0].value[STORED_KEY_FIELD], SECRET, '落盘的才是清洗后的 key')
  assert.equal(storeStub.writes[0].value.savedAt, '2026-09-22 10:00:00')

  for (const bad of ['', '   ', 'a\nb', 12345, null]) {
    const rejected = await watcher.setKey(bad)
    assert.equal(rejected.ok, false, `${JSON.stringify(bad)} 应当被拒`)
  }
  assert.equal(storeStub.writes.length, 1, '非法输入不该写盘')
})

test('setKey：写盘失败如实报错，且错误信息里不带 key', async () => {
  const storeStub = fakeStore()
  storeStub.writeJsonAtomic = () => ({ ok: false, error: 'EACCES' })
  const { watcher } = makeWatcher({ store: storeStub })

  const failed = await watcher.setKey(SECRET)
  assert.equal(failed.ok, false)
  assert.match(failed.error, /EACCES/)
  assert.equal(String(failed.error).includes(SECRET), false)
})

test('clearKey：删掉文件并回报剩余来源；重复清除也成功', async () => {
  const storeStub = fakeStore()
  storeStub.files.set(SECRET_PATH, { [STORED_KEY_FIELD]: SECRET })
  // 文件删掉之后还有环境变量兜底：清除要说清楚"现在从哪来"。
  const { watcher } = makeWatcher({
    store: storeStub,
    resolve: async () => (storeStub.files.has(SECRET_PATH) ? { key: SECRET, source: 'file' } : { key: 'from-env', source: 'env' }),
  })

  const first = await watcher.clearKey()
  assert.equal(first.ok, true)
  assert.equal(first.stored, false)
  assert.equal(first.source, 'env')
  assert.equal(first.configured, true, '环境变量还在，就是还配置着')
  assert.deepEqual(storeStub.removals, [SECRET_PATH])

  const second = await watcher.clearKey()
  assert.equal(second.ok, true, '重复清除不该报错')
  assert.equal(storeStub.removals.length, 2)
})

test('快照与 config.get 里只有 keyStored 布尔，没有任何 key 内容', async () => {
  const storeStub = fakeStore()
  storeStub.files.set(SECRET_PATH, { [STORED_KEY_FIELD]: SECRET })
  const { watcher } = makeWatcher({ store: storeStub, resolve: async () => ({ key: SECRET, source: 'file' }) })

  const snapshot = await watcher.status()
  assert.equal(snapshot.value.judge.keyStored, true)
  assert.equal(JSON.stringify(snapshot).includes(SECRET), false, '快照会进页面/工具输出，绝不能含 key')
  assert.equal(JSON.stringify(watcher.getConfig()).includes(SECRET), false)
})
