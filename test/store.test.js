/**
 * 存储层测试：所有落盘都在 `os.tmpdir()` 下的独立临时目录里做，用例结束（含失败）即删。
 *
 * 盯的不是"能读能写"，而是 store 的纪律：**任何失败都返回 `{ ok:false, error }`，绝不抛**
 * （见 lib/store.js 文件头），成功路径不留 `*.tmp-*` 残渣。
 *
 * @module dsh-popo-watcher/test/store
 */

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  appendJsonl,
  appendJsonlCapped,
  appendLineCapped,
  dataRoot,
  ensureDir,
  groupDir,
  nowStamp,
  readJson,
  readJsonlTail,
  readLineTail,
  readText,
  resolveHome,
  removeFile,
  writeJsonAtomic,
  writeText,
} from '../lib/store.js'

/** 独立临时目录，测试结束即删。 */
function tempDir(t, tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-store-${tag}-`))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** 递归列出目录下所有条目名（找残留临时文件用）。 */
function listAll(dir) {
  return readdirSync(dir, { recursive: true }).map((name) => String(name))
}

test('dataRoot 以 <home>/.dsh/popo-watcher 结尾；resolveHome 在只有 HOME 时用 HOME', () => {
  // 期望值用 path.join 拼，不硬编码分隔符（Windows 是反斜杠，别处是正斜杠）
  const suffix = join('.dsh', 'popo-watcher')
  assert.equal(dataRoot({ USERPROFILE: 'C:/u' }), join('C:/u', suffix))
  assert.ok(dataRoot({ USERPROFILE: 'C:/u' }).endsWith(suffix))

  // USERPROFILE 优先于 HOME
  assert.equal(resolveHome({ USERPROFILE: 'C:/u', HOME: '/home/u' }), 'C:/u')
  assert.equal(resolveHome({ HOME: '/home/u' }), '/home/u')
  assert.equal(dataRoot({ HOME: '/home/u' }), join('/home/u', suffix))

  // 都为空串时回落到 os.homedir()；env 缺省时用 process.env
  assert.equal(resolveHome({ USERPROFILE: '', HOME: '' }), homedir())
  assert.ok(dataRoot().endsWith(suffix))

  // groupDir 是纯拼接；root 不可用时返回空串，不把相对路径交给下游写出
  assert.equal(groupDir('C:/u/.dsh/popo-watcher', '1234567'), join('C:/u/.dsh/popo-watcher', '1234567'))
  assert.equal(groupDir('C:/u', undefined), join('C:/u', ''))
  assert.equal(groupDir(undefined, '1234567'), '')
  assert.equal(groupDir('', '1234567'), '')
})

test('nowStamp 输出 YYYY-MM-DD HH:MM:SS（长度 19，两位补零）', () => {
  const stamp = nowStamp(new Date('2026-09-22T10:00:00')) // 无时区后缀 = 本地时间，字段不走样
  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(stamp.length, 19)
  assert.equal(stamp, '2026-09-22 10:00:00')

  // 个位数的月/日/时/分/秒必须补零
  assert.equal(nowStamp(new Date(2026, 0, 5, 3, 4, 5)), '2026-01-05 03:04:05')

  // 不传参时是当前时间（默认参数）
  assert.match(nowStamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

test('writeJsonAtomic + readJson 回环；目标目录自动创建；不留 *.tmp-* 残留', (t) => {
  const dir = tempDir(t, 'atomic')
  const nested = join(dir, 'a', 'b') // 故意不存在
  const file = join(nested, 'state.json')

  assert.deepEqual(writeJsonAtomic(file, { hook: 'on', n: 1, text: '中文' }), { ok: true })
  assert.ok(existsSync(nested), '目标目录应被自动创建')
  assert.deepEqual(readJson(file, null), { ok: true, value: { hook: 'on', n: 1, text: '中文' } })

  // 覆盖写：tmp + rename 替换已存在的文件（Windows 上最容易出问题的一步）
  assert.deepEqual(writeJsonAtomic(file, { hook: 'off' }), { ok: true })
  assert.deepEqual(readJson(file, null), { ok: true, value: { hook: 'off' } })
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ hook: 'off' }, null, 2))

  // 序列化不了的值直接判失败，且不落盘、不留 tmp
  const unserializable = join(nested, 'unserializable.json')
  const circular = {}
  circular.self = circular
  assert.equal(writeJsonAtomic(unserializable, undefined).ok, false)
  assert.equal(writeJsonAtomic(unserializable, circular).ok, false)
  assert.equal(existsSync(unserializable), false)

  const leftovers = listAll(dir).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '同目录不得留下临时文件')
})

test('readJson：JSON 损坏或文件不存在都回落 fallback，且不抛', (t) => {
  const dir = tempDir(t, 'read-json')
  const fallback = { fallback: true }

  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{oops', 'utf8')
  let brokenResult
  assert.doesNotThrow(() => { brokenResult = readJson(broken, fallback) })
  assert.equal(brokenResult.ok, false)
  assert.deepEqual(brokenResult.value, fallback)
  assert.match(brokenResult.error, /解析失败/)
  assert.equal(brokenResult.code, 'JSON_PARSE_ERROR')

  // 不存在的文件同理：ok:false + 回落 fallback，只是 error 来自 fs 而不是 JSON.parse
  const missing = join(dir, 'missing.json')
  let missingResult
  assert.doesNotThrow(() => { missingResult = readJson(missing, fallback) })
  assert.equal(missingResult.ok, false)
  assert.deepEqual(missingResult.value, fallback)
  assert.equal(typeof missingResult.error, 'string')
  assert.ok(missingResult.error.length > 0)
  assert.equal(missingResult.code, 'ENOENT')
})

test('appendJsonl 逐行追加；readJsonlTail 只取尾部 N 行且顺序正确，坏行被跳过', (t) => {
  const dir = tempDir(t, 'jsonl')
  const file = join(dir, 'messages.jsonl')

  for (const row of [{ i: 1 }, { i: 2 }, { i: 3 }]) {
    assert.deepEqual(appendJsonl(file, row), { ok: true })
  }

  const tail = readJsonlTail(file, 2)
  assert.equal(tail.ok, true)
  assert.deepEqual(tail.rows, [{ i: 2 }, { i: 3 }], '只返回最后 2 行，且保持写入顺序')

  // 混入一行坏 JSON（比如进程被杀留下的半行）：坏行跳过，整体仍 ok
  appendFileSync(file, '{"i": 4\n', 'utf8')
  const withBroken = readJsonlTail(file, 10)
  assert.equal(withBroken.ok, true)
  assert.deepEqual(withBroken.rows, [{ i: 1 }, { i: 2 }, { i: 3 }])
})

test('appendLineCapped 超过 maxLines 时只保留最后 maxLines 行', (t) => {
  const dir = tempDir(t, 'capped')
  const file = join(dir, 'poll.log')

  for (let i = 1; i <= 8; i += 1) {
    assert.deepEqual(appendLineCapped(file, `第${i}行`, 5), { ok: true })
  }

  const tail = readLineTail(file, 100)
  assert.equal(tail.ok, true)
  assert.ok(tail.lines.length <= 5, `行数应被压到 5 行内，实际 ${tail.lines.length}`)
  assert.equal(tail.lines.at(-1), '第8行')
  assert.deepEqual(tail.lines, ['第4行', '第5行', '第6行', '第7行', '第8行'])
})

test('appendJsonlCapped：小文件也遵守行数上限，字节上限独立生效', (t) => {
  const dir = tempDir(t, 'jsonl-capped')
  const file = join(dir, 'messages.jsonl')

  // 尚未达到字节上限时，也必须保留最后三行。
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(appendJsonlCapped(file, { i }, { maxLines: 3, maxBytes: 1024 * 1024 }).ok, true)
  }
  assert.deepEqual(readJsonlTail(file, 10).rows, [{ i: 3 }, { i: 4 }, { i: 5 }])

  // 16 字节只容得下两个 8 字节记录，虽然行数上限仍是三。
  const result = appendJsonlCapped(file, { i: 6 }, { maxLines: 3, maxBytes: 16 })
  assert.equal(result.ok, true)
  assert.equal(result.trimmed, true)
  assert.deepEqual(readJsonlTail(file, 10).rows, [{ i: 5 }, { i: 6 }])

  // 裁剪之后文件还能继续追加（不是一次性的）。
  assert.equal(appendJsonlCapped(file, { i: 7 }, { maxLines: 3, maxBytes: 1024 * 1024 }).ok, true)
  assert.deepEqual(readJsonlTail(file, 10).rows, [{ i: 5 }, { i: 6 }, { i: 7 }])

  // 坏路径 + 坏入参都不抛。
  assert.equal(appendJsonlCapped('', { i: 1 }).ok, false)
  const fileAsParent = join(dir, 'not-a-dir')
  writeFileSync(fileAsParent, 'x', 'utf8')
  assert.equal(appendJsonlCapped(join(fileAsParent, 'x.jsonl'), { i: 1 }).ok, false)
  assert.doesNotThrow(() => appendJsonlCapped(undefined, undefined))
})

test('非法路径：把已存在的文件当目录用返回 {ok:false, error} 而不是抛', (t) => {
  const dir = tempDir(t, 'illegal-path')
  const fileAsDir = join(dir, 'not-a-dir')
  writeFileSync(fileAsDir, 'x', 'utf8') // 存在，但是个文件

  let atomic
  assert.doesNotThrow(() => { atomic = writeJsonAtomic(join(fileAsDir, 'x.json'), { a: 1 }) })
  assert.equal(atomic.ok, false)
  assert.equal(typeof atomic.error, 'string')
  assert.ok(atomic.error.length > 0)

  let jsonl
  assert.doesNotThrow(() => { jsonl = appendJsonl(join(fileAsDir, 'y.jsonl'), { a: 1 }) })
  assert.equal(jsonl.ok, false)
  assert.equal(typeof jsonl.error, 'string')
  assert.ok(jsonl.error.length > 0)

  // 空/非字符串目录路径直接判失败，不会落到 mkdirSync('')
  assert.equal(ensureDir('').ok, false)
  assert.equal(typeof ensureDir('').error, 'string')
  assert.equal(ensureDir(undefined).ok, false)

  // 正向对照：正常路径真的建出来
  const fresh = join(dir, 'fresh', 'deeper')
  assert.deepEqual(ensureDir(fresh), { ok: true })
  assert.ok(existsSync(fresh))
})

test('所有导出对 undefined / 空字符串入参都不抛（IO 类必须返回 ok:false）', (t) => {
  const dir = tempDir(t, 'never-throw')
  const fallback = { fallback: true }
  const cwd = process.cwd()
  // writeJsonAtomic('') 会在 cwd 落一个相对临时文件（随后被清掉），这里留快照做对照
  const cwdTmpBefore = readdirSync(cwd).filter((name) => name.startsWith('.tmp-'))

  // [标签, 调用, 是否必须返回 { ok:false }]
  const cases = [
    ['resolveHome(undefined)', () => resolveHome(undefined), false],
    ['dataRoot(undefined)', () => dataRoot(undefined), false],
    ['dataRoot("")', () => dataRoot(''), false],
    ['groupDir(undefined, "1")', () => groupDir(undefined, '1'), false],
    ['groupDir("", "1")', () => groupDir('', '1'), false],
    ['nowStamp(undefined)', () => nowStamp(undefined), false],
    ['ensureDir(undefined)', () => ensureDir(undefined), true],
    ['ensureDir("")', () => ensureDir(''), true],
    ['readText(undefined)', () => readText(undefined), true],
    ['readText("")', () => readText(''), true],
    ['readJson(undefined, fb)', () => readJson(undefined, fallback), true],
    ['readJson("", fb)', () => readJson('', fallback), true],
    ['readJsonlTail("", 1)', () => readJsonlTail('', 1), true],
    ['readJsonlTail(undefined, 1)', () => readJsonlTail(undefined, 1), true],
    ['readLineTail("", 1)', () => readLineTail('', 1), true],
    ['readLineTail(undefined, 1)', () => readLineTail(undefined, 1), true],
    ['writeJsonAtomic(undefined, {})', () => writeJsonAtomic(undefined, {}), true],
    ['writeJsonAtomic("", {})', () => writeJsonAtomic('', {}), true],
    ['appendJsonl(undefined, {})', () => appendJsonl(undefined, {}), true],
    ['appendJsonl("", {})', () => appendJsonl('', {}), true],
    ['appendLineCapped(undefined, "x")', () => appendLineCapped(undefined, 'x'), true],
    ['appendLineCapped("", "x")', () => appendLineCapped('', 'x'), true],
  ]

  for (const [label, run, mustFail] of cases) {
    let result
    assert.doesNotThrow(() => { result = run() }, `${label} 不应抛`)
    if (mustFail) {
      assert.equal(result?.ok, false, `${label} 应返回 ok:false`)
      assert.equal(typeof result.error, 'string', `${label} 应带 error`)
      assert.ok(result.error.length > 0, `${label} 的 error 不应为空`)
    }
  }

  // 失败路径也不许把临时文件丢在 cwd
  const cwdTmpAfter = readdirSync(cwd).filter((name) => name.startsWith('.tmp-'))
  assert.deepEqual(cwdTmpAfter.filter((name) => !cwdTmpBefore.includes(name)), [])

  // 空路径的读文本/读 JSON 也要给出可用值，而不是 undefined
  assert.deepEqual(readJson('', fallback).value, fallback)
  assert.deepEqual(readJsonlTail('', 1).rows, [])
  assert.deepEqual(readLineTail('', 1).lines, [])
  assert.equal(existsSync(dir), true)
})
