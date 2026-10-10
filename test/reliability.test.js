import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import * as store from '../lib/store.js'
import { createJudge } from '../lib/judge.js'
import { createDraftWriter } from '../lib/llm.js'
import { createTransport } from '../lib/popo.js'
import { createRpcHandler } from '../lib/rpc.js'
import { createWatcher } from '../lib/watcher.js'
import * as config from '../lib/config.js'
import { MESSAGE_CAP, ROUND_LOG_CAP, SENDS_LOG_CAP, JUDGE_LOG_CAP } from '../lib/limits.js'
import { tempDirectory, watcherFixture } from './helpers/watcher-fixture.js'

test('自动发送与仅判读一次都将准确的草稿正文传给判读', async t => {
  const { watcher, drafts } = watcherFixture(t)
  const text = '可以先看下连接池等待时间'
  assert.equal((await watcher.sendNow({ text })).ok, true)
  assert.equal(drafts[0].our_draft, text)
  assert.equal((await watcher.judgeNow({ draft: text })).ok, true)
  assert.equal(drafts[1].our_draft, text)
})

test('自动草稿判读和手动诊断使用已保存的阈值', async t => {
  const { watcher, sent } = watcherFixture(t, {
    config: { judge: { thresholds: { draftLeak: 0.8 } } },
    judgeClient: { runDraft: async () => ({ ok: true, answers: { leaks_internal_detail: { type: 'noul', noul: 0.65 } } }) },
  })
  assert.equal((await watcher.sendNow({ text: 'synthetic draft' })).ok, true)
  assert.equal((await watcher.judgeNow({ draft: 'synthetic draft' })).decision.decision, 'pass')
  assert.equal(sent.length, 1)
})

test('已发出的消息记账失败：保留内存计数、暂停自动发送，只恢复记账且不重发', async t => {
  let fail = true
  const fixture = watcherFixture(t, { store: {
    writeJsonAtomic(file, value) {
      return fail && file.endsWith('state.json') ? { ok: false, error: 'fixture ENOSPC' } : store.writeJsonAtomic(file, value)
    },
  } })
  const { watcher, sent, dir } = fixture
  const first = await watcher.sendNow({ text: '已确认的第一条' })
  assert.equal(first.ok, true)
  assert.equal(first.stateWritten, false)
  assert.equal(watcher.status().value.sends.count, 1)
  assert.equal(watcher.status().value.persistence.ok, false)
  assert.equal((await watcher.sendNow({ text: '不应自动发出的第二条' })).ok, false)
  assert.equal(sent.length, 1)
  const handle = createRpcHandler({ watcher })
  const manual = await handle('send.now', { text: '用户明确发送的第二条' })
  assert.equal(manual.ok, true)
  assert.equal(manual.value.stateWritten, false)
  assert.equal(sent.length, 2)
  assert.equal(watcher.status().value.sends.count, 2)
  fail = false
  assert.equal((await watcher.startWindow({ hours: 1 })).ok, true)
  assert.equal(watcher.status().value.persistence.ok, true)
  assert.equal(store.readJson(join(dir, 'state.json')).value.sentCount, 2)
  assert.equal(sent.length, 2, '重新开始只补记账，不重发已确认的消息')
})

test('消息写入失败不推进水位；显式恢复后只保存一次，水位失败也可恢复', async t => {
  let failMessage = true
  let failWatermark = false
  const message = { t_msg: new Date('2026-10-10T12:00:01').getTime(), from: 'peer', name: 'fixture', msgId: 'durable-message', content: '新消息' }
  const { watcher, dir } = watcherFixture(t, {
    transport: { search: async () => ({ ok: true, value: { uid: 'self', messages: [message] } }) },
    store: {
      appendJsonlCapped(file, value, options) {
        return failMessage && file.endsWith('messages.jsonl') ? { ok: false, error: 'fixture ENOSPC' } : store.appendJsonlCapped(file, value, options)
      },
      writeJsonAtomic(file, value) {
        return failWatermark && file.endsWith('poller.json') ? { ok: false, error: 'fixture watermark failure' } : store.writeJsonAtomic(file, value)
      },
    },
  })
  assert.equal((await watcher.startWindow()).ok, false)
  assert.equal(watcher.status().value.poll.lastSeenMsgTime, 0)
  assert.equal(watcher.status().value.persistence.ok, false)
  assert.equal(watcher.status().value.poll.running, false)
  failMessage = false
  failWatermark = true
  assert.equal((await watcher.startWindow()).ok, false)
  assert.equal(watcher.status().value.poll.lastSeenMsgTime, 0)
  failWatermark = false
  assert.equal((await watcher.startWindow()).ok, true)
  assert.equal(watcher.status().value.poll.lastSeenMsgTime, message.t_msg)
  const rows = store.readJsonlTail(join(dir, 'messages.jsonl'), 100).rows
  assert.equal(rows.filter(row => row.msgId === message.msgId).length, 1)
})

test('判读正文卡住时仍按总超时返回，即使 fetch 没有响应取消', { timeout: 5000 }, async () => {
  let signal, release
  const judge = createJudge({ getKey: () => 'fixture-key', timeoutMs: 1000, fetchImpl: async (_url, init) => {
    signal = init.signal
    return { ok: true, text: () => new Promise(resolve => { release = resolve }) }
  } })
  let guard
  try {
    const result = await Promise.race([
      judge.runRound({}, {}),
      new Promise(resolve => { guard = setTimeout(() => resolve({ guard: true }), 2000) }),
    ])
    assert.equal(result.guard, undefined, '正文等待不能逃脱超时')
    assert.equal(result.ok, false)
    assert.equal(signal.aborted, true)
  } finally {
    clearTimeout(guard)
    release?.('{"answers":{}}')
  }
})

test('模型流必须正常 finish/stop，缺少结束标记或截断均失败', async () => {
  for (const chunks of [
    [{ type: 'text-delta', text: '未完成的句子' }],
    [{ type: 'text-delta', text: 'x'.repeat(2001) }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'text-delta', text: '没有结束原因' }, { type: 'finish' }],
  ]) {
    const writer = createDraftWriter({
      getRoute: () => ({ provider: 'fixture', model: 'fixture' }),
      getLlm: () => ({ stream: () => (async function* () { yield* chunks })() }),
    })
    assert.equal((await writer.write({ prompt: 'fixture' })).ok, false)
  }
})

test('临时目录创建失败不写工作目录、不写 sessionFile，也不启动 CLI', async t => {
  const root = tempDirectory(t)
  const before = readdirSync(process.cwd())
  const transport = createTransport({
    tmpDir: join(root, 'missing-parent', 'nested'),
    resolve: () => ({ ok: true, nodePath: 'fixture', cliJs: 'fixture' }),
    spawn: () => assert.fail('不能启动 CLI'),
  })
  // search 提供明确的临时路径：即使旧实现缺少 scratch 检查，也不会写入真实目录。
  const sessionFile = join(root, 'session.json')
  const result = await transport.search({ group: '1234567', sessionFile })
  assert.equal(result.ok, false)
  assert.equal(existsSync(sessionFile), false)
  assert.deepEqual(readdirSync(process.cwd()), before)
})

test('日志同时执行行数和 UTF-8 字节上限，超大记录保留截断标记', t => {
  const root = tempDirectory(t)
  const file = join(root, 'bounded.jsonl')
  for (let i = 0; i < 6; i++) assert.equal(store.appendJsonlCapped(file, { i }, { maxLines: 3, maxBytes: 1024 }).ok, true)
  assert.deepEqual(store.readJsonlTail(file, 20).rows.map(row => row.i), [3, 4, 5])
  assert.equal(store.appendJsonlCapped(file, { at: 'fixture', content: '很长😀'.repeat(1000) }, { maxLines: 3, maxBytes: 256 }).ok, true)
  assert.ok(readFileSync(file).length <= 256)
  assert.equal(store.readJsonlTail(file, 20).rows.at(-1).truncated, true)
})

test('慢判读不会阻塞停止回包和状态持久化', async t => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { watcher, dir } = watcherFixture(t, { judgeClient: { runDraft: () => pending } })
  const judging = watcher.judgeNow({ draft: 'fixture' })
  await new Promise(resolve => setImmediate(resolve))
  let guard
  try {
    const stopped = await Promise.race([
      watcher.stop(),
      new Promise(resolve => { guard = setTimeout(() => resolve({ guard: true }), 100) }),
    ])
    assert.equal(stopped.guard, undefined)
    assert.equal(stopped.ok, true)
    assert.equal(store.readJson(join(dir, 'state.json')).value.stopped, true)
  } finally {
    clearTimeout(guard)
    release({ ok: true, answers: {} })
    await judging
  }
})

test('宿主重启可从成功回执恢复遗漏记账，恢复前不会自动启动', async t => {
  const fixture = watcherFixture(t, { store: {
    writeJsonAtomic(file, value) { return file.endsWith('state.json') ? { ok: false, error: 'fixture ENOSPC' } : store.writeJsonAtomic(file, value) },
  } })
  assert.equal((await fixture.watcher.sendNow({ text: '远端已确认的消息' })).ok, true)
  fixture.watcher.dispose()
  const restored = createWatcher({ store, config, env: fixture.env, now: fixture.now,
    schedule: () => () => {}, autoRound: false, getTransport: () => fixture.transport })
  t.after(() => restored.dispose())
  assert.equal((await restored.resume()).resumed, false)
  assert.equal(restored.status().value.sends.count, 1)
  assert.equal(restored.status().value.persistence.ok, false)
  assert.equal((await restored.startWindow()).ok, true)
  assert.equal(restored.status().value.persistence.ok, true)
  assert.equal(store.readJson(join(fixture.dir, 'state.json')).value.sentCount, 1)
  assert.equal(fixture.sent.length, 1)
})

test('已经排队的开始请求不能覆盖稍后的停止', async t => {
  const { watcher } = watcherFixture(t)
  const starting = watcher.startWindow()
  assert.equal((await watcher.stop()).ok, true)
  assert.equal((await starting).ok, false)
  assert.equal(watcher.status().value.window.stopped, true)
  assert.equal(watcher.status().value.poll.running, false)
})

test('真实日志跨越生产容量边界，重建 watcher 后发送计数与日志仍一致', async t => {
  const { watcher, dir, env, now } = watcherFixture(t)
  const limits = { 'messages.jsonl': MESSAGE_CAP, 'round.jsonl': ROUND_LOG_CAP, 'sends.jsonl': SENDS_LOG_CAP, 'judge.jsonl': JUDGE_LOG_CAP }
  for (const [name, cap] of Object.entries(limits)) {
    const rows = Array.from({ length: cap.maxLines }, (_, i) => ({ i }))
    assert.equal(store.writeText(join(dir, name), rows.map(row => JSON.stringify(row)).join('\n') + '\n').ok, true)
    assert.equal(store.appendJsonlCapped(join(dir, name), { i: 'newest' }, cap).ok, true)
    const saved = readFileSync(join(dir, name), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(saved.length, cap.maxLines)
    assert.equal(saved[0].i, 1)
    assert.equal(saved.at(-1).i, 'newest')
    assert.ok(readFileSync(join(dir, name)).length <= cap.maxBytes)
  }
  assert.equal((await watcher.sendNow({ text: '模拟手动消息', manual: true })).ok, true)
  const restored = createWatcher({ store, config, env, now })
  t.after(() => restored.dispose())
  assert.equal(restored.status().value.sends.count, 1)
  assert.equal(store.readJsonlTail(join(dir, 'sends.jsonl'), 1).rows[0].content, '模拟手动消息')
})

test('发送临时目录失败不遗留 message.txt：子进程仅使用独立临时工作目录', t => {
  const root = tempDirectory(t, 'scratch-failure')
  const source = `import { createTransport } from ${JSON.stringify(new URL('../lib/popo.js', import.meta.url).href)};
    const transport = createTransport({tmpDir: './missing/nested', resolve: () => ({ok:true,nodePath:'fixture',cliJs:'fixture'}),
      spawn: () => { throw new Error('unexpected simulated spawn') }});
    console.log(JSON.stringify(await transport.send({group:'1234567',text:'synthetic fixture'})));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 3000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout).ok, false)
  assert.deepEqual(readdirSync(root), [])
})

test('发送流水写入失败可跨重启补写；已确认消息始终不会重发', async t => {
  const fixture = watcherFixture(t, { store: {
    appendJsonlCapped(file, value, options) { return file.endsWith('sends.jsonl') ? { ok: false, error: 'fixture audit failure' } : store.appendJsonlCapped(file, value, options) },
  } })
  const result = await fixture.watcher.sendNow({ text: '已确认但流水缺失' })
  assert.equal(result.ok, true)
  assert.equal(result.stateWritten, true)
  assert.match(result.warnings.join(' '), /记账失败/)
  fixture.advance(21000)
  assert.equal((await fixture.watcher.sendNow({ text: '不能继续自动发送' })).ok, false)
  fixture.watcher.dispose()
  const restored = createWatcher({ store, config, env: fixture.env, now: fixture.now, autoRound: false,
    schedule: () => () => {}, getTransport: () => fixture.transport })
  t.after(() => restored.dispose())
  assert.equal((await restored.resume()).resumed, false)
  assert.equal(restored.status().value.persistence.ok, false)
  assert.equal((await restored.startWindow()).ok, true)
  assert.equal(restored.status().value.persistence.ok, true)
  assert.equal(store.readJsonlTail(join(fixture.dir, 'sends.jsonl'), 10).rows.length, 1)
  assert.equal(fixture.sent.length, 1)
})
