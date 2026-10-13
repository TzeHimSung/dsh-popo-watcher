/**
 * 传输层测试（`lib/popo.js`）：假 `spawn` + 假 `resolve`，零网络、零真实子进程、零真实 CLI。
 *
 * 盯三件事：
 * 1. **契约形状** —— `resolveCli` 的探测顺序、`describe()` 的可用性、argv 逐位相等（不经 shell）；
 * 2. **真实回应** —— 用入库脱敏样本 `test/fixtures/popo-search.json`（`data.data.data.data` 四层信封）；
 * 3. **纪律** —— 失败一律 `{ ok:false, kind, error }`，绝不抛/不 reject；超时必须 `terminate()` 恰好一次；
 *    中文只经 UTF-8 临时文件传参（argv 里不许出现中文），临时文件/scratch 目录用完即删。
 *
 * 全部 IO 落在 `os.tmpdir()` 下的独立临时目录，用例结束（含失败）即删。
 *
 * @module dsh-popo-watcher/test/popo
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTransport, resolveCli } from '../lib/popo.js'

/** 入库的真实回应样本（脱敏）。 */
const SEARCH_OK = readFileSync(new URL('./fixtures/popo-search.json', import.meta.url), 'utf8')

/** 假 resolve 给出的两个路径（与真实布局同形，但是假的）。 */
const NODE_PATH = 'C:/node/node.exe'
const CLI_JS = 'C:/cli/node_modules/@popo/cli/bin/popo.js'

/** 独立临时目录，测试结束即删。 */
function tempDir(t, tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-popo-${tag}-`))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** 成功的 `resolve` 桩；`fn.calls` 记录调用次数（用来验证解析结果被缓存）。 */
function resolveOk(nodePath = NODE_PATH, cliJs = CLI_JS) {
  const fn = () => { fn.calls += 1; return { ok: true, nodePath, cliJs } }
  fn.calls = 0
  return fn
}

/**
 * 假子进程句柄工厂：形状照宿主 seam（`{ argv, cwd, stdio, graceMs }` → 句柄）。
 * @param options.stdout - `readFrom(0)` 返回的 stdout（默认空串）。
 * @param options.stderr - stderr 文本（塞 Node 警告用）。
 * @param options.exitCode - `done` 解析出的退出码。
 * @param options.hang - `done` 永不 resolve（测超时用）。
 * @param options.onSpec - spawn 调用瞬间的钩子（"当时文件存在吗"这类断言）。
 * @returns `spawn(spec)`，带 `calls[]`（每条含 `spec / terminateCount / stdoutReads / stderrReads`）。
 */
function fakeSpawn(options = {}) {
  const { stdout = '', stderr = '', exitCode = 0, hang = false, onSpec } = options
  const calls = []

  function spawn(spec) {
    const record = {
      spec,
      terminateCount: 0,
      stdoutReads: [],
      stderrReads: [],
      cwdExistedAtCall: typeof spec?.cwd === 'string' && existsSync(spec.cwd),
    }
    calls.push(record)
    onSpec?.(spec, record)
    return {
      collected: {
        stdout: {
          readFrom(from) {
            record.stdoutReads.push(from)
            return { text: from === 0 ? stdout : '', nextOffset: stdout.length, lossy: false }
          },
        },
        stderr: {
          readFrom(from) {
            record.stderrReads.push(from)
            return { text: stderr, nextOffset: stderr.length, lossy: false }
          },
        },
      },
      done: hang ? new Promise(() => {}) : Promise.resolve({ exitCode }),
      terminate() { record.terminateCount += 1 },
      waitForExit: async () => true,
    }
  }

  spawn.calls = calls
  return spawn
}

/** 建临时目录 + transport 的组合（每例一个独立 scratch 父目录）。 */
function makeTransport(t, tag, spawn, extra = {}) {
  const dir = tempDir(t, tag)
  const resolve = resolveOk()
  return { dir, resolve, transport: createTransport({ spawn, resolve, tmpDir: dir, ...extra }) }
}

/** 本地 `YYYY-MM-DD HH:MM:SS`（独立实现，避免拿被测代码给自己判分）。 */
function localStamp(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 断言是失败结果：`{ ok:false, kind, error }` 且 error 是字符串。 */
function assertFail(result, kind) {
  assert.equal(typeof result, 'object', '失败必须是结果对象，不是抛/reject')
  assert.equal(result.ok, false)
  assert.equal(result.kind, kind)
  assert.equal(typeof result.error, 'string')
}

// ---------------------------------------------------------------- resolveCli

test('resolveCli：explicit 命中时优先（exists 恒 true）', () => {
  const probed = []
  const exists = (path) => { probed.push(path); return true }

  const result = resolveCli({
    explicit: 'D:/custom/popo.js',
    env: { APPDATA: 'C:/Users/demo/AppData/Roaming' },
    exists,
    nodePath: NODE_PATH,
  })

  assert.equal(result.ok, true)
  assert.equal(result.cliJs, 'D:/custom/popo.js')
  assert.equal(result.nodePath, NODE_PATH)
  assert.deepEqual(probed, ['D:/custom/popo.js'], 'explicit 命中就不该再去探环境变量')
})

test('resolveCli：只给 env.APPDATA 时拼出 npm 全局布局', () => {
  const appData = 'C:/Users/demo/AppData/Roaming'
  const expected = join(appData, 'npm', 'node_modules', '@popo', 'cli', 'bin', 'popo.js')
  const probed = []

  // explicit 没给 / 不存在 → 先探 explicit，再探 %APPDATA%
  const miss = resolveCli({
    explicit: 'D:/nope/popo.js',
    env: { APPDATA: appData },
    exists: (path) => { probed.push(path); return false },
  })
  assert.equal(miss.ok, false)
  assert.deepEqual(probed, ['D:/nope/popo.js', expected])

  const hit = resolveCli({ env: { APPDATA: appData }, exists: () => true, nodePath: NODE_PATH })
  assert.equal(hit.ok, true)
  assert.equal(hit.cliJs, expected)
  assert.equal(hit.nodePath, NODE_PATH)
})

test('resolveCli：都不命中时返回 ok:false，错误里点名 popo-cli', () => {
  const empty = resolveCli({ env: { APPDATA: '', USERPROFILE: '', HOME: '' }, exists: () => true })
  assert.equal(empty.ok, false)
  assert.equal(typeof empty.error, 'string')
  assert.match(empty.error, /popo-cli/)
  assert.equal(empty.cliJs, undefined)

  // 连 env 都没有也一样（不抛）
  const bare = resolveCli({ env: undefined, exists: () => false })
  assert.equal(bare.ok, false)
  assert.match(bare.error, /popo-cli/)
})

// ---------------------------------------------------------------- describe

test('describe()：没有 spawn 时不可用；resolve 成功时报 cliPath/nodePath', () => {
  const disabled = createTransport({})
  const bad = disabled.describe()
  assert.equal(bad.ok, false)
  assert.equal(typeof bad.error, 'string')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-popo-describe-'))
  try {
    const resolve = resolveOk()
    const transport = createTransport({ spawn: fakeSpawn(), resolve, tmpDir: dir, now: () => 42 })
    assert.deepEqual(transport.describe(), { ok: true, cliPath: CLI_JS, nodePath: NODE_PATH })
    transport.describe()
    assert.equal(resolve.calls, 1, '解析结果应被缓存')
    assert.equal(transport.nowMs(), 42)

    // resolve 说找不到 → describe 也如实说不可用
    const missing = createTransport({ spawn: fakeSpawn(), resolve: () => ({ ok: false, error: '没有 popo-cli 可用' }) })
    const info = missing.describe()
    assert.equal(info.ok, false)
    assert.equal(info.error, '没有 popo-cli 可用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- search 成功

test('search 缺失或无效的 result_list 不能伪装成成功空列表', async (t) => {
  for (const list of [undefined, null, {}, []]) {
    const body = JSON.parse(SEARCH_OK)
    body.data.data.data.data.result_list = list
    const { transport } = makeTransport(t, 'search-list', fakeSpawn({ stdout: JSON.stringify(body) }))
    const result = await transport.search({ group: '1234567', pageSize: 30 })
    assert.equal(result.ok, Array.isArray(list))
    if (Array.isArray(list)) assert.deepEqual(result.value.messages, [])
    else assertFail(result, 'parse')
  }
})

test('search 成功路径：uid、条数、字段映射与本地时间格式', async (t) => {
  const spawn = fakeSpawn({ stdout: SEARCH_OK })
  const { transport } = makeTransport(t, 'search-ok', spawn)

  const result = await transport.search({ group: '1234567' })

  assert.equal(result.ok, true)
  assert.equal(result.value.uid, 'demo-user@example.com')
  assert.equal(result.value.messages.length, 3)

  const [first, second, third] = result.value.messages
  assert.deepEqual(first, {
    t_msg: 1789991459992,
    time: localStamp(1789991459992),
    from: 'demo-user@example.com',
    name: '张三',
    msgId: '1234567-0000000001',
    content: '示例消息 1',
  })
  assert.deepEqual(second, {
    t_msg: 1789990677750,
    time: localStamp(1789990677750),
    from: 'demo-user@example.com',
    name: '李四',
    msgId: '1234567-0000000002',
    content: '示例消息 2',
  })
  assert.equal(third.msgId, '1234567-0000000003')
  assert.equal(third.content, '示例消息 3')

  for (const message of result.value.messages) {
    assert.match(message.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(typeof message.t_msg, 'number')
  }
})

test('search 的 argv 形状：不经 shell、sessionList 走 @file、pageSize 可覆盖', async (t) => {
  const snapshots = []
  const spawn = fakeSpawn({
    stdout: SEARCH_OK,
    onSpec: (spec) => {
      const last = spec.argv[spec.argv.length - 1]
      const file = String(last).slice('sessionList=@file:'.length)
      snapshots.push({
        file,
        exists: existsSync(file),
        content: existsSync(file) ? readFileSync(file, 'utf8') : '',
      })
    },
  })
  const { transport } = makeTransport(t, 'search-argv', spawn)

  const first = await transport.search({ group: '1234567' })
  const second = await transport.search({ group: '1234567', pageSize: 5 })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(spawn.calls.length, 2)

  const [callA, callB] = spawn.calls
  const base = [NODE_PATH, CLI_JS, 'popo', 'message_search', 'query=', 'type=1', 'page=0']

  assert.equal(callA.spec.argv.length, 10)
  assert.deepEqual(callA.spec.argv.slice(0, 7), base)
  assert.equal(callA.spec.argv[7], 'pageSize=15', '默认 pageSize=15')
  assert.equal(callA.spec.argv[8], 'msgType=0')
  assert.match(callA.spec.argv[9], /^sessionList=@file:/)

  assert.equal(callB.spec.argv.length, 10)
  assert.deepEqual(callB.spec.argv.slice(0, 7), base)
  assert.equal(callB.spec.argv[7], 'pageSize=5')
  assert.equal(callB.spec.argv[8], 'msgType=0')
  assert.match(callB.spec.argv[9], /^sessionList=@file:/)

  // 宿主 seam 的其余形状
  assert.equal(typeof callA.spec.cwd, 'string')
  assert.equal(callA.cwdExistedAtCall, true)
  assert.equal(callA.spec.stdio.stdin, 'ignore')
  assert.equal(typeof callA.spec.stdio.stdout.maxBytes, 'number')
  assert.equal(typeof callA.spec.stdio.stderr.maxBytes, 'number')
  assert.equal(typeof callA.spec.graceMs, 'number')

  // @file 指向的 session 文件在 spawn 的当下真实存在，内容是群 ID 数组，且就在 cwd 里
  assert.equal(snapshots[0].exists, true)
  assert.equal(snapshots[0].content, '["1234567"]')
  assert.equal(snapshots[0].file, join(callA.spec.cwd, 'session.json'))

  // 返回后 scratch 目录（含 session 文件）被删掉
  assert.equal(existsSync(snapshots[0].file), false)
  assert.equal(existsSync(callA.spec.cwd), false)

  // 解析只由 stdout 决定（stderr 仅供诊断，读它不影响结果）
  assert.deepEqual(callA.stdoutReads, [0])
})

test('@ 搜索保持限群，成员数组经临时文件传递并验证时间参数', async (t) => {
  let membersFile
  const spawn = fakeSpawn({ stdout: SEARCH_OK, onSpec: spec => {
    const memberArg = spec.argv.find(arg => arg.startsWith('atMembers='))
    membersFile = memberArg.slice('atMembers=@file:'.length)
    assert.deepEqual(JSON.parse(readFileSync(membersFile, 'utf8')), ['self@example.com'])
    const sessionArg = spec.argv.find(arg => arg.startsWith('sessionList='))
    assert.deepEqual(JSON.parse(readFileSync(sessionArg.slice('sessionList=@file:'.length), 'utf8')), ['1234567'])
    assert.ok(spec.argv.includes('timeStart=1000'))
    assert.ok(spec.argv.includes('timeEnd=2000'))
  } })
  const { transport } = makeTransport(t, 'mention-search', spawn)
  assert.equal((await transport.search({ group: '1234567', atMembers: ['self@example.com'], timeStart: 1000, timeEnd: 2000 })).ok, true)
  assert.equal(existsSync(membersFile), false)
  for (const filter of [{ atMembers: [] }, { atMembers: 'self' }, { atMembers: [''] }, { timeStart: NaN }, { timeEnd: -1 }, { timeStart: 2000, timeEnd: 1000 }]) {
    assert.equal((await transport.search({ group: '1234567', ...filter })).ok, false)
  }
  assert.equal(spawn.calls.length, 1)
})

test('currentUser 只返回 UID 和去重显示名，缺失身份时失败', async (t) => {
  for (const [payload, expected] of [
    [{ uid: 'self@example.com', name: ' 张三 ', nickname: '昵称', token: 'must-not-return' }, { uid: 'self@example.com', names: ['张三', '昵称'] }],
    [{ uid: 'self@example.com', name: '张三', nickname: '张三' }, { uid: 'self@example.com', names: ['张三'] }],
    [{ uid: 'self@example.com', name: '' }, null], [{ name: '张三' }, null],
  ]) {
    const body = JSON.parse(SEARCH_OK)
    body.data.data.data.data = payload
    const spawn = fakeSpawn({ stdout: JSON.stringify(body) })
    const { transport } = makeTransport(t, 'current-user', spawn)
    const result = await transport.currentUser()
    assert.deepEqual(spawn.calls[0].spec.argv, [NODE_PATH, CLI_JS, 'popo', 'team_current_user_info'])
    assert.equal(result.ok, expected !== null)
    if (expected) assert.deepEqual(result.value, expected)
    assert.equal(JSON.stringify(result).includes('must-not-return'), false)
  }
})

test('stderr 里的 Node 警告不影响解析（只看 stdout）', async (t) => {
  const noisyStderr = [
    '(node:33724) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
    'node:internal/modules/cjs/loader:1404',
    'ExperimentalWarning: Importing JSON modules is an experimental feature.',
  ].join('\n')
  const spawn = fakeSpawn({ stdout: SEARCH_OK, stderr: noisyStderr })
  const { transport } = makeTransport(t, 'search-stderr', spawn)

  const result = await transport.search({ group: '1234567' })

  assert.equal(result.ok, true)
  assert.equal(result.value.uid, 'demo-user@example.com')
  assert.equal(result.value.messages.length, 3)
  // stdout 是解析来源：stderr 只用来做诊断，不参与解析（读不读都可以，但解析结果必须只由 stdout 决定）。
  assert.ok(spawn.calls[0].stdoutReads.length > 0)
})

// ---------------------------------------------------------------- send 成功

test('网络错误保留错误码与脱敏摘要，exit=0 仍失败；搜索、检查、发送均只调用一次', async (t) => {
  const message = 'ECONNRESET https://alice:url-password@gateway.example/api?token=url-token#secret-fragment\n'
    + 'access_token="token with spaces"; api_key=key-secret; password=password-secret\n'
    + 'Authorization: Bearer bearer-secret'
  for (const method of ['search', 'checkAuth', 'send']) {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ ok: false, code: 'FABRIC_NETWORK_ERROR', message }), exitCode: 0 })
    const { transport } = makeTransport(t, `network-${method}`, spawn)
    const result = await transport[method]({ group: '1234567', text: '离线测试' })
    assertFail(result, 'upstream')
    assert.equal(result.code, 'FABRIC_NETWORK_ERROR')
    assert.equal(result.retryable, true)
    assert.match(result.error, /ECONNRESET/)
    assert.match(result.error, /gateway\.example\/api/)
    for (const secret of ['alice', 'url-password', 'url-token', 'secret-fragment', 'token with spaces', 'key-secret', 'password-secret', 'bearer-secret']) {
      assert.equal(result.error.includes(secret), false)
    }
    assert.equal(spawn.calls.length, 1)
  }
})

test('只有网络故障与超时标记可重试；认证、升级、无效响应和 CLI 缺失不可重试', async (t) => {
  const responses = [
    JSON.stringify({ ok: false, code: 'FABRIC_NOT_AUTHENTICATED' }),
    JSON.stringify({ ok: false, code: 'UNKNOWN_ERROR', message: 'network unavailable' }),
    '> [!WARNING]\n> POPO CLI 有新版本，请先升级再继续。\n> popo-cli update',
    'not-json',
    '',
  ]
  for (let index = 0; index < responses.length; index += 1) {
    const { transport } = makeTransport(t, `non-retryable-${index}`, fakeSpawn({ stdout: responses[index] }))
    const result = await transport.search({ group: '1234567' })
    assert.equal(result.ok, false)
    assert.equal(result.retryable, false)
  }
  const spawn = fakeSpawn({ hang: true })
  const timeout = await makeTransport(t, 'retryable-timeout', spawn, { timeoutMs: 20 }).transport.search({ group: '1234567' })
  assertFail(timeout, 'timeout')
  assert.equal(timeout.retryable, true)
  assert.equal(spawn.calls[0].terminateCount, 1)
  assert.equal(spawn.calls.length, 1)
  assert.equal((await createTransport({}).checkAuth()).retryable, false)
})

test('手动检查只执行 auth status，成功结果只保留账号', async (t) => {
  const stdout = JSON.stringify({ ok: true, data: { status: 'ok', uid: 'demo@example.com', access_token: 'never-expose-this' } })
  const spawn = fakeSpawn({ stdout: `> warning\n${stdout}` })
  const { transport, dir } = makeTransport(t, 'check-auth', spawn)
  assert.deepEqual(await transport.checkAuth(), { ok: true, value: { uid: 'demo@example.com' } })
  assert.equal(spawn.calls.length, 1)
  assert.deepEqual(spawn.calls[0].spec.argv, [NODE_PATH, CLI_JS, 'auth', 'status'])
  assert.equal(spawn.calls[0].spec.cwd, dir, '只查状态，无需创建消息文件')
})

test('检查区分登录、升级和其他故障，退出码 0 或空成功信封不能冒充正常', async (t) => {
  const cases = [
    ['login', { ok: false, code: 'FABRIC_NOT_AUTHENTICATED' }, 'upstream', /popo-cli auth login/],
    ['expired', { ok: true, data: { status: 'expired' } }, 'upstream', /popo-cli auth login/],
    ['pending', { ok: true, data: { status: 'pending_browser' } }, 'upstream', /popo-cli auth login/],
    ['network', { ok: false, code: 'GATEWAY_UNAVAILABLE' }, 'upstream', /GATEWAY_UNAVAILABLE/],
    ['unknown', { ok: true, data: { status: 'unknown', uid: 'demo' } }, 'parse', /无法确认/],
    ['no-status', { ok: true }, 'parse', /无法确认/],
  ]
  for (const [tag, body, kind, message] of cases) {
    const result = await makeTransport(t, `check-${tag}`, fakeSpawn({ stdout: JSON.stringify(body) })).transport.checkAuth()
    assertFail(result, kind)
    assert.match(result.error, message)
    if (['network', 'unknown', 'no-status'].includes(tag)) assert.doesNotMatch(result.error, /auth login/)
  }
  const update = '> [!WARNING]\n> POPO CLI 有新版本，请先升级再继续。\n> popo-cli update'
  const upgrade = await makeTransport(t, 'check-upgrade', fakeSpawn({ stdout: update })).transport.checkAuth()
  assertFail(upgrade, 'upstream')
  assert.match(upgrade.error, /popo-cli update/)
  assert.doesNotMatch(upgrade.error, /auth login/)
  const malformed = await makeTransport(t, 'check-malformed', fakeSpawn({ stdout: '{"access_token":"never-expose-this"' })).transport.checkAuth()
  assertFail(malformed, 'parse')
  assert.doesNotMatch(malformed.error, /never-expose-this/)
  const nonzero = await makeTransport(t, 'check-nonzero', fakeSpawn({ stdout: '{"ok":true,"data":{"status":"ok"}}', exitCode: 1 })).transport.checkAuth()
  assertFail(nonzero, 'upstream')
  const hanging = fakeSpawn({ hang: true })
  assertFail(await makeTransport(t, 'check-timeout', hanging, { timeoutMs: 20 }).transport.checkAuth(), 'timeout')
  assert.equal(hanging.calls[0].terminateCount, 1)
  assertFail(await createTransport({}).checkAuth(), 'cli-missing')
})

test('采集与发送共享登录和升级提示，升级警告夹带有效 JSON 仍按 JSON 处理', async (t) => {
  const warning = '> [!WARNING]\n> POPO CLI 有新版本，请先升级再继续。\n> popo-cli update\n'
  for (const method of ['search', 'send']) {
    const params = { group: '1234567', text: '仅供离线测试' }
    for (const code of ['FABRIC_AUTH_LOGIN_REQUIRED', 'FABRIC_NOT_AUTHENTICATED']) {
      const spawn = fakeSpawn({ stdout: JSON.stringify({ ok: false, code }) })
      const result = await makeTransport(t, `${method}-${code}`, spawn).transport[method](params)
      assertFail(result, 'upstream')
      assert.match(result.error, /popo-cli auth login/)
      assert.ok(result.error.includes(code))
      assert.equal(spawn.calls.length, 1, '不得自动重试发送')
    }
    const result = await makeTransport(t, `${method}-upgrade`, fakeSpawn({ stdout: warning })).transport[method](params)
    assertFail(result, 'upstream')
    assert.match(result.error, /popo-cli update/)
    const success = method === 'search' ? SEARCH_OK : '{"ok":true,"msgId":"mock-1"}'
    const valid = await makeTransport(t, `${method}-upgrade-noise`, fakeSpawn({ stdout: warning + success })).transport[method](params)
    assert.equal(valid.ok, true)
  }
})

test('send 成功：msgId 正则路径与结构化回落路径', async (t) => {
  const regexHit = JSON.stringify({ ok: true, data: { data: { data: { status: 1, data: { msgId: '1234567-1234567' } } } } })
  const structured = '{"ok":true,"data":{"data":{"data":{"status":1,"data":{"msgId":"X-1"}}}}}'
  // 点号不在 `[0-9A-Za-z_-]` 里 → 正则必然落空，只有结构性回落能救回来
  const fallbackOnly = '{"ok":true,"data":{"data":{"data":{"status":1,"data":{"msgId":"X.1"}}}}}'

  const byRegex = await makeTransport(t, 'send-regex', fakeSpawn({ stdout: regexHit })).transport
    .send({ group: '1234567', text: '收到' })
  assert.equal(byRegex.ok, true)
  assert.deepEqual(byRegex.value, { msgId: '1234567-1234567' })

  const structuredResult = await makeTransport(t, 'send-structured', fakeSpawn({ stdout: structured })).transport
    .send({ group: '1234567', text: '收到' })
  assert.equal(structuredResult.ok, true)
  assert.equal(structuredResult.value.msgId, 'X-1')

  const fallbackResult = await makeTransport(t, 'send-fallback', fakeSpawn({ stdout: fallbackOnly })).transport
    .send({ group: '1234567', text: '收到' })
  assert.equal(fallbackResult.ok, true)
  assert.equal(fallbackResult.value.msgId, 'X.1')
})

test('发送判定：认不出 id 但信封像成功 → 仍报成功 + unrecognized（宁可丢 id，不可重发）', async (t) => {
  const cases = [
    { label: 'nested-msg-id', stdout: JSON.stringify({ ok: true, code: 0, data: { data: { data: { status: 1, data: { msg_id: 'g-2' } } } } }), msgId: 'g-2' },
    { label: 'top-msgid', stdout: JSON.stringify({ ok: true, msgId: 'g-3' }), msgId: 'g-3' },
    { label: 'envelope-no-id', stdout: JSON.stringify({ ok: true, data: { data: { data: { data: { status: 1 } } } } }), msgId: '' },
    { label: 'ok-true-empty', stdout: JSON.stringify({ ok: true }), msgId: '' },
    { label: 'broken-json-regex', stdout: '{ "data": , "msg_id": "g-4" }', msgId: 'g-4' },
  ]

  for (const item of cases) {
    const { transport } = makeTransport(t, `send-ack-${item.label}`, fakeSpawn({ stdout: item.stdout, exitCode: 0 }))
    const result = await transport.send({ group: '1234567', text: '一句话' })
    assert.equal(result.ok, true, `${item.label} 应当算发送成功，实际 ${JSON.stringify(result).slice(0, 160)}`)
    assert.equal(result.value.msgId, item.msgId, `${item.label} 的 msgId`)
    // 只有"结构里明明白白带 id"那两种才不标 unrecognized。
    const expectedUnrecognized = item.label === 'nested-msg-id' || item.label === 'top-msgid' ? undefined : true
    assert.equal(result.value.unrecognized, expectedUnrecognized, `${item.label} 的 unrecognized 标记`)
  }
})

test('发送失败的真实信封（CLI 实测的本地校验失败形状）不会被当成成功', async (t) => {
  // 这条形状是实测抓到的：`node popo.js popo message_send_team source=AGENT` 的输出（退出码 2）。
  const realShape = JSON.stringify({
    ok: false,
    code: 'POPO_VALIDATION_FAILED',
    command: 'popo message_send_team',
    errors: [{ param: 'message', kind: 'missing_required', expected: 'string', hint: '必填参数 message 缺失，期望类型 string' }],
    exitCode: 2,
  })
  const { transport } = makeTransport(t, 'send-real-fail', fakeSpawn({ stdout: realShape, exitCode: 2 }))
  const result = await transport.send({ group: '1234567', text: '一句话' })

  assertFail(result, 'upstream')
  assert.match(result.error, /POPO_VALIDATION_FAILED/)
})

test('send 的传参：中文只走 UTF-8 临时文件，argv 全 ASCII，用完即删', async (t) => {
  const group = '1234567'
  const text = '大家好，我是群聊助手，这是包含中文和标点的合成测试消息。'
  const captured = []
  const spawn = fakeSpawn({
    stdout: JSON.stringify({ msgId: '1234567-1234567' }),
    onSpec: (spec) => {
      const arg = String(spec.argv[4])
      const file = arg.slice('message=@text:'.length)
      captured.push({
        file,
        existsAtCall: existsSync(file),
        text: existsSync(file) ? readFileSync(file, 'utf8') : '',
        bytes: existsSync(file) ? readFileSync(file) : Buffer.alloc(0),
      })
    },
  })
  const { dir, transport } = makeTransport(t, 'send-argv', spawn)

  const result = await transport.send({ group, text })

  assert.equal(result.ok, true)
  assert.equal(result.value.msgId, '1234567-1234567')

  const spec = spawn.calls[0].spec
  assert.equal(spec.argv.length, 7)
  assert.deepEqual(spec.argv.slice(0, 4), [NODE_PATH, CLI_JS, 'popo', 'message_send_team'])
  assert.equal(spec.argv[4], `message=@text:${captured[0].file}`)
  assert.equal(spec.argv[5], `receiver=${group}`)
  assert.equal(spec.argv[6], 'source=AGENT')
  assert.equal(spec.argv.some((value) => /[\u4e00-\u9fff]/.test(String(value))), false, '中文绝不过命令行')

  // 调用的当下：文件真的在，内容就是原文，且是 UTF-8 字节
  assert.equal(captured[0].existsAtCall, true)
  assert.match(captured[0].file, /message\.txt$/)
  assert.equal(captured[0].text, text)
  assert.equal(captured[0].bytes.equals(Buffer.from(text, 'utf8')), true)
  assert.equal(spawn.calls[0].cwdExistedAtCall, true)

  // 返回后：消息文件与 scratch 目录都被删干净；注入的 tmpDir 本身保留
  assert.equal(existsSync(captured[0].file), false)
  assert.equal(existsSync(spec.cwd), false)
  assert.equal(existsSync(dir), true)
})

// ---------------------------------------------------------------- 失败分类

test('失败分类：done 永不 resolve + timeoutMs:20 → timeout，terminate 恰好一次', async (t) => {
  const spawn = fakeSpawn({ hang: true })
  const { transport } = makeTransport(t, 'timeout', spawn, { timeoutMs: 20 })

  const result = await transport.search({ group: '1234567' })

  assertFail(result, 'timeout')
  assert.match(result.error, /20ms/)
  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.calls[0].terminateCount, 1, '卡死的子进程必须被杀，且只杀一次')
  assert.equal(existsSync(spawn.calls[0].spec.cwd), false, '超时也要清 scratch')
})

test('实测漂移：CLI 把 `> [!WARNING]` 提示打到 stdout 时，search 仍然解析成功', async (t) => {
  // 真实环境里 popo-cli 会在 JSON 前面打一行 markdown 警告（打在 stdout，不是 stderr）。
  const noisy = `> [!WARNING]\n> popo-cli 0.9.2 有新版本\n${SEARCH_OK}`
  const { transport } = makeTransport(t, 'noisy-search', fakeSpawn({ stdout: noisy, exitCode: 0 }))

  const result = await transport.search({ group: '1234567', pageSize: 5 })
  assert.equal(result.ok, true, `应当容忍噪声前缀，实际：${JSON.stringify(result).slice(0, 200)}`)
  assert.equal(result.value.messages.length > 0, true)
  assert.match(result.value.noise, /\[!WARNING\]/, '噪声要如实带出来（页面/日志能看出输出不干净）')

  // 尾部噪声（JSON 后面还有话）同样容忍。
  const trailing = `${SEARCH_OK}\n> done.`
  const tail = await makeTransport(t, 'noisy-tail', fakeSpawn({ stdout: trailing, exitCode: 0 })).transport.search({ group: '1234567' })
  assert.equal(tail.ok, true)
  assert.match(tail.value.noise, /done\./)

  // 多行 pretty JSON + 噪声：走括号配对那条路。
  const pretty = `> [!WARNING]\n${JSON.stringify(JSON.parse(SEARCH_OK), null, 2)}\n(exit 0)`
  const prettyResult = await makeTransport(t, 'noisy-pretty', fakeSpawn({ stdout: pretty, exitCode: 0 })).transport.search({ group: '1234567' })
  assert.equal(prettyResult.ok, true)

  // 真的没有 JSON 时仍然如实报 parse 失败，而不是假装成功。
  const junk = await makeTransport(t, 'junk', fakeSpawn({ stdout: '> [!WARNING]\n完全不是 JSON', exitCode: 0 })).transport.search({ group: '1234567' })
  assertFail(junk, 'parse')
  assert.match(junk.error, /输出开头/)
})

test('失败分类：spawn 抛错 → spawn', async (t) => {
  const spawn = () => { throw new Error('spawn 炸了') }
  const { transport } = makeTransport(t, 'spawn-throw', spawn)

  const result = await transport.search({ group: '1234567' })

  assertFail(result, 'spawn')
  assert.match(result.error, /spawn 炸了/)
})

test('失败分类：stdout 垃圾文本 → parse；空串 → empty', async (t) => {
  const garbage = fakeSpawn({ stdout: 'NPM WARNING: something went wrong\nnot json at all' })
  const garbageTransport = makeTransport(t, 'parse', garbage).transport
  const parseResult = await garbageTransport.search({ group: '1234567' })
  assertFail(parseResult, 'parse')
  assert.match(parseResult.error, /不是 JSON/)

  const blank = makeTransport(t, 'empty', fakeSpawn({ stdout: '' })).transport
  assertFail(await blank.search({ group: '1234567' }), 'empty')

  const spaces = makeTransport(t, 'empty-space', fakeSpawn({ stdout: '  \r\n\t ' })).transport
  assertFail(await spaces.search({ group: '1234567' }), 'empty')
})

test('失败分类：回应 {"ok":false,...} → upstream；resolve 失败 → cli-missing（不 spawn）', async (t) => {
  const upstream = fakeSpawn({ stdout: '{"ok":false,"code":"UNAUTHORIZED"}' })
  const upstreamResult = await makeTransport(t, 'upstream', upstream).transport.search({ group: '1234567' })
  assertFail(upstreamResult, 'upstream')
  assert.match(upstreamResult.error, /UNAUTHORIZED/)

  const neverSpawn = fakeSpawn({ stdout: SEARCH_OK })
  const noCli = createTransport({ spawn: neverSpawn, resolve: () => ({ ok: false, error: '找不到 popo-cli' }) })
  const missingResult = await noCli.search({ group: '1234567' })
  assertFail(missingResult, 'cli-missing')
  assert.match(missingResult.error, /popo-cli/)
  assert.equal(neverSpawn.calls.length, 0)

  // 宿主根本没给 spawn 也是同一个 kind
  const noService = createTransport({ resolve: resolveOk() })
  assertFail(await noService.send({ group: '1234567', text: '你好' }), 'cli-missing')
})

test('参数缺失：search 没有群 ID、send 空文本 → 直接失败，不碰 spawn', async (t) => {
  const spawn = fakeSpawn({ stdout: SEARCH_OK })
  const { transport } = makeTransport(t, 'bad-params', spawn)

  const results = [
    await transport.search({}),
    await transport.search(),
    await transport.search({ group: '' }),
    await transport.search({ group: null }),
    await transport.send({ group: '1234567', text: '' }),
    await transport.send({ group: '1234567', text: '   ' }),
    await transport.send({ group: '1234567' }),
    await transport.send({ group: '', text: '你好' }),
  ]

  for (const result of results) {
    assert.equal(result.ok, false)
    assert.equal(typeof result.kind, 'string')
    assert.equal(typeof result.error, 'string')
  }
  assert.equal(spawn.calls.length, 0, '参数都不全就不该起子进程')
})

test('resolve 自己抛错时也不 reject（每次都降级为结果对象）', async (t) => {
  const dir = tempDir(t, 'resolve-throw')
  const transport = createTransport({
    spawn: fakeSpawn({ stdout: SEARCH_OK }),
    resolve: () => { throw new Error('resolve 炸了') },
    tmpDir: dir,
  })

  assert.equal(transport.describe().ok, false)

  const searched = await transport.search({ group: '1234567' })
  assert.equal(searched.ok, false)
  assert.equal(typeof searched.error, 'string')

  const sent = await transport.send({ group: '1234567', text: '你好' })
  assert.equal(sent.ok, false)
  assert.equal(typeof sent.error, 'string')
})
