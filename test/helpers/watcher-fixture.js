import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import * as config from '../../lib/config.js'
import * as store from '../../lib/store.js'
import { createWatcher } from '../../lib/watcher.js'

export function tempDirectory(t, label = 'reliability') {
  const directory = mkdtempSync(join(tmpdir(), `dsh-${label}-`))
  t.after(() => {
    const target = resolve(directory)
    assert.ok(target.toLowerCase().startsWith((resolve(tmpdir()) + sep).toLowerCase()))
    rmSync(target, { recursive: true, force: true })
  })
  return directory
}

/** Real files and real configuration; all external calls are local fixtures. */
export function watcherFixture(t, options = {}) {
  const home = tempDirectory(t)
  const env = { USERPROFILE: home, HOME: home }
  const root = store.dataRoot(env)
  const group = '1234567'
  const dir = store.groupDir(root, group)
  let time = new Date('2026-10-10T12:00:00').getTime()
  const now = () => new Date(time)
  const sent = []
  const drafts = []
  const transport = {
    search: async () => ({ ok: true, value: { uid: 'self', messages: [] } }),
    send: async input => { sent.push(input); return { ok: true, value: { msgId: `fixture-${sent.length}` } } },
    ...options.transport,
  }
  const judgeClient = {
    available: async () => ({ ok: true }),
    runRound: async () => ({ ok: true, answers: {} }),
    runDraft: async state => { drafts.push(structuredClone(state)); return { ok: true, answers: {} } },
    ...options.judgeClient,
  }
  const cfg = config.applyPatch(config.defaultConfig(), { group, opening: { enabled: false }, ...options.config }).config
  assert.equal(store.writeJsonAtomic(join(root, 'config.json'), cfg).ok, true)
  assert.equal(store.writeJsonAtomic(join(dir, 'state.json'), {
    group, selfUid: 'self', startedAt: '2026-10-10 11:00:00', endsAt: '2026-10-11 11:00:00',
    stopped: false, sentCount: 0, sentMessages: [], lastSendEpochMs: 0, minGapSec: cfg.minGapSec,
  }).ok, true)
  assert.equal(store.appendJsonl(join(dir, 'messages.jsonl'), {
    t_msg: time - 1000, from: 'peer', name: 'fixture', msgId: 'fixture-message', content: '连接池需要怎么检查？',
  }).ok, true)
  const watcher = createWatcher({
    store: { ...store, ...options.store }, config, env, now, autoRound: false,
    schedule: () => () => {}, getTransport: () => transport, judgeClient,
    keyResolver: async () => ({ key: '', source: 'none' }),
    draftWriter: options.draftWriter,
    checkStartup: options.checkStartup,
    getModelSelection: options.getModelSelection,
  })
  t.after(() => watcher.dispose())
  return { watcher, dir, root, env, transport, judgeClient, sent, drafts, now, advance: ms => { time += ms } }
}
