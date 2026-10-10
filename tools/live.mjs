/**
 * 真机演练（**只读 + 干跑，绝不发言**）：把整条流水线在真实环境里跑几十秒。
 *
 * 为什么需要它：单测用的是桩传输层，`tools/smoke.mjs` 只证明"CLI 能搜到消息"；
 * 而"采集 → 落盘 → 触发一轮 → 出结论 → 落流水"这条链路只有真跑才知道通不通。
 *
 * 安全边界（三重）：
 * 1. **数据根在临时目录**（`<tmp>/.dsh/popo-watcher`），不碰用户真实的 state/config；
 * 2. **`dryRun: true`**：`lib/send.js` 在传输层之前就短路，物理上不可能发出去；
 * 3. **开场白关掉** + 判读/文案默认不接（没 key 或没网时自然安静）。
 * 结束时还会断言"一条都没发"，发现发了就以非 0 退出。
 *
 * 用法：node tools/live.mjs --group <group-id> [--seconds 60] [--interval 20] [--judge]
 *
 * @module dsh-popo-watcher/tools/live
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as config from '../lib/config.js'
import { createJudge, loadQuestions } from '../lib/judge.js'
import { resolveKeySource, storedKeyFile } from '../lib/key-source.js'
import { createTransport, resolveCli } from '../lib/popo.js'
import * as store from '../lib/store.js'
import { createWatcher } from '../lib/watcher.js'
import { localSpawn, mask, parseFlags, sleep } from './shared.mjs'

/** 读一个 JSONL 的尾部（不依赖 store 的 root，直接给路径）。 */
function tail(file, limit = 5) {
  return store.readJsonlTail(file, limit).rows ?? []
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), { group: '', seconds: '60', interval: '20', judge: false })
  const group = config.validateGroup(flags.group)
  if (!group) {
    console.error('请用 --group 指定有效群 ID；未执行任何查询。')
    process.exitCode = 1
    return
  }
  const seconds = Math.max(10, Math.min(600, Number(flags.seconds) || 60))
  const intervalSec = Math.max(5, Math.min(600, Number(flags.interval) || 20))

  const home = mkdtempSync(join(tmpdir(), 'popo-watcher-live-'))
  const env = { ...process.env, USERPROFILE: home, HOME: home }
  const root = store.dataRoot(env)
  const dir = join(root, group)

  const cli = resolveCli()
  console.log(`真机演练（干跑）：群 ${group}，跑 ${seconds}s，轮询 ${intervalSec}s`)
  console.log(`  临时数据根：${root}`)
  console.log(`  popo-cli：${cli.ok === true ? cli.cliJs : `⛔ ${cli.error}`}`)
  if (cli.ok !== true) {
    console.log('找不到 popo-cli，演练直接结束（这不是插件的问题）。')
    rmSync(home, { recursive: true, force: true })
    process.exitCode = 1
    return
  }

  const base = config.defaultConfig()
  const cfg = {
    ...base,
    group,
    intervalSec,
    windowHours: 1,
    dryRun: true,
    opening: { enabled: false, text: base.opening.text },
  }
  const configModule = {
    defaultConfig: () => ({ ...cfg }),
    normalizeConfig: (raw) => (raw === null || raw === undefined ? { config: { ...cfg }, warnings: [] } : { config: { ...cfg, ...raw }, warnings: [] }),
    applyPatch: (current, patch) => ({ config: { ...current, ...patch }, warnings: [] }),
  }

  // 判读（TypeSafe）只有在 --judge 且真有 key 时才接；文案层不接（那是宿主 LLM 的活）。
  let judgeClient
  if (flags.judge === true) {
    const resolved = await resolveKeySource({ name: 'TYPESAFE_API_KEY', file: storedKeyFile(root) })
    if (resolved.source === 'none') {
      console.log('  --judge 需要 TYPESAFE_API_KEY，这里没读到，按不接判读处理。')
    } else {
      judgeClient = createJudge({ getKey: () => resolveKeySource({ name: 'TYPESAFE_API_KEY', file: storedKeyFile(root) }).then((value) => value.key) })
      console.log(`  判读：接入（key 来源 ${resolved.source}）`)
    }
  } else {
    console.log('  判读：未接入（不加 --judge）→ 每轮结论会是 quote/judgeUnavailable 那一档')
  }

  const transport = createTransport({ spawn: localSpawn })
  const watcher = createWatcher({
    store,
    config: configModule,
    env,
    getTransport: () => transport,
    judgeClient,
    autoRound: true,
    // 真定时器：这就是"真跑"的意义（poller 自己按 intervalSec 轮询）。
    logger: (line) => console.log(`  [log] ${line}`),
  })

  const started = await watcher.startWindow({ hours: 1 })
  console.log(`  开窗：${started.ok === true ? 'ok' : `失败 ${started.error}`}（opening=${started.opening === null ? '未配置' : JSON.stringify(started.opening)}）`)
  if (started.ok !== true) {
    await watcher.dispose()
    rmSync(home, { recursive: true, force: true })
    process.exitCode = 1
    return
  }

  // 跑 seconds 秒，每 5 秒报一次进度。
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    await sleep(Math.min(5000, Math.max(1000, deadline - Date.now())))
    const snapshot = (await watcher.status()).value
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    console.log(
      `  [${remaining}s] 阶段=${snapshot.phase} 轮询=${snapshot.poll.running ? '跑' : '停'}`
      + ` 已抓=${snapshot.poll.watchedMsgs ?? 0} 滞后=${snapshot.poll.lagSec ?? '—'}s`
      + ` 窗口已发=${snapshot.sends.count}`
      + (snapshot.round ? ` 最近一轮=${snapshot.round.verdict}` : ''),
    )
  }

  await watcher.stop({ mode: 'stop', reason: '真机演练结束' })
  await watcher.dispose()

  // ---- 汇总（这里是"演练到底验到了什么"的证据） ----
  const messages = tail(join(dir, 'messages.jsonl'), 100)
  const rounds = tail(join(dir, 'round.jsonl'), 100)
  const sends = tail(join(dir, 'sends.jsonl'), 100)
  const pollLog = (store.readLineTail(join(dir, 'poll.log'), 200).lines ?? [])

  console.log('')
  console.log('演练结果：')
  console.log(`  抓到消息：${messages.length} 条（最近：${messages.at(-1)?.time ?? '—'} ${mask(messages.at(-1)?.name ?? '')}）`)
  console.log(`  轮次记录：${rounds.length} 条（最近：${rounds.at(-1)?.verdict ?? '—'} / ${rounds.at(-1)?.reason ?? '—'}）`)
  console.log(`  发言流水：${sends.length} 条 ${sends.length === 0 ? '✅ 一条都没发（dryRun 生效）' : '⛔ 竟然发了，必须查！'}`)
  console.log(`  轮询日志：${pollLog.length} 行（最近：${pollLog.at(-1) ?? '—'}）`)
  console.log(`  落盘目录：${dir}（临时目录，退出即删）`)

  const problems = []
  if (messages.length === 0) problems.push('一条消息都没抓到（CLI 搜索失败或群太久没人说话）')
  if (rounds.length === 0) problems.push('一轮都没触发（采集没产出新消息）')
  if (sends.length > 0) problems.push('干跑模式下竟然发出了消息')
  console.log(problems.length === 0 ? '真机演练通过。' : `真机演练有问题：${problems.join('；')}`)

  rmSync(home, { recursive: true, force: true })
  process.exitCode = problems.length === 0 ? 0 : 1
}

await main()
