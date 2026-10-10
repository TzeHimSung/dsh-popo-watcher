/**
 * 环境体检（只读）：把"这台机器上这个插件能不能干活"一次问清楚。
 *
 * 检查项：
 * 1) **数据根**：`<home>/.dsh/popo-watcher` 能不能定位（只报路径，不建目录、不写文件）；
 * 2) **popo-cli**：`resolveCli()` 能不能找到 CLI（找不到时报出期望路径与 `popoCliJs` 配置项）；
 * 3) **真实搜索**：真起一次 `message_search`（**只读**，绝不发送），报出返回条数、selfUid 与最新一条；
 * 4) **问句集**：`loadQuestions()` 能不能读出 round/draft 两套问题；
 * 5) **判读 key**：有没有 key、从哪来（**只报来源，绝不打印 key**）；
 * 6) `--judge` 时额外真跑一次 TypeSafe round（会花 token，默认不跑）。
 *
 * 退出码：默认恒为 0（离线/无 CLI 只是"这台机器暂时用不了"，不该让 CI 红）；
 * 加 `--strict` 时，任何一项失败都以 1 退出。
 *
 * 用法：node tools/smoke.mjs --group <group-id> [--page-size 5] [--judge] [--strict] [--json]
 *
 * @module dsh-popo-watcher/tools/smoke
 */

import { createJudge, loadQuestions } from '../lib/judge.js'
import { resolveKeySource, storedKeyFile } from '../lib/key-source.js'
import { createTransport, resolveCli } from '../lib/popo.js'
import * as store from '../lib/store.js'
import { localSpawn, mask } from './shared.mjs'
import { validateGroup } from '../lib/config.js'

/** 解析命令行参数（够用即可，不引依赖）。 */
function parseArgs(argv) {
  const out = { group: '', pageSize: 5, judge: false, strict: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--group' && value) out.group = value
    else if (key === '--page-size' && value) out.pageSize = Math.max(1, Math.min(50, Number(value) || 5))
    else if (key === '--judge') out.judge = true
    else if (key === '--strict') out.strict = true
    else if (key === '--json') out.json = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!validateGroup(args.group)) {
    console.error('请用 --group 指定有效群 ID；未执行任何查询。')
    process.exitCode = 1
    return
  }
  const checks = []
  const record = (name, ok, detail) => checks.push({ name, ok, detail })

  // 1) 数据根
  const root = store.dataRoot()
  record('数据根', typeof root === 'string' && root !== '', root)

  // 2) popo-cli
  const cli = resolveCli()
  record('popo-cli', cli.ok === true, cli.ok === true ? cli.cliJs : cli.error)

  // 3) 真实搜索（只读）
  let messages = []
  let uid = ''
  if (cli.ok === true) {
    const transport = createTransport({ spawn: localSpawn })
    const started = Date.now()
    const found = await transport.search({ group: args.group, pageSize: args.pageSize })
    const ms = Date.now() - started
    if (found.ok === true) {
      messages = found.value?.messages ?? []
      uid = found.value?.uid ?? ''
      const latest = messages.length > 0 ? `${messages[messages.length - 1].time} ${messages[messages.length - 1].name}` : '（空）'
      record('真实搜索', messages.length > 0, `${messages.length} 条 / ${ms}ms / selfUid=${mask(uid)} / 最新：${latest}`)
    } else {
      record('真实搜索', false, `${found.kind}：${found.error}`)
    }
  } else {
    record('真实搜索', false, '跳过（没找到 CLI）')
  }

  // 4) 问句集
  const questions = loadQuestions()
  record(
    '问句集',
    questions.ok === true,
    questions.ok === true
      ? `round ${Object.keys(questions.questions.round).length} 问 / draft ${Object.keys(questions.questions.draft).length} 问`
      : String(questions.error),
  )

  // 5) 判读 key（只报来源）
  const keyFile = storedKeyFile(root)
  const resolved = await resolveKeySource({ name: 'TYPESAFE_API_KEY', file: keyFile }).catch(() => ({ key: '', source: 'none' }))
  record('判读 key', resolved.source !== 'none', resolved.source === 'none' ? '没有 key（判读会静默跳过；可在设置页填）' : `来源：${resolved.source}`)

  // 6) 可选：真跑一次判读
  if (args.judge === true) {
    if (resolved.source === 'none') {
      record('判读请求', false, '跳过（没有 key）')
    } else {
      const judge = createJudge({ getKey: () => resolveKeySource({ name: 'TYPESAFE_API_KEY', file: keyFile }).then((value) => value.key) })
      const state = {
        chat: { setting: 'informal internal company group chat', language: 'Simplified Chinese' },
        conversation: messages.slice(-5).map((message, index) => ({
          n: index + 1,
          minutes_ago: 0,
          speaker: message.name,
          is_our_account: message.from === uid,
          is_new: true,
          text: message.content,
        })),
        our_recent_messages: [],
      }
      const started = Date.now()
      const result = questions.ok === true ? await judge.runRound(state, questions.questions.round) : { ok: false, error: '问句集不可用' }
      record(
        '判读请求',
        result.ok === true,
        result.ok === true ? `model=${result.model} / ${Date.now() - started}ms / ${result.tokens ?? '?'} input tokens` : String(result.error),
      )
    }
  }

  // 汇总
  const failed = checks.filter((check) => check.ok !== true)
  if (args.json === true) {
    console.log(JSON.stringify({ group: args.group, checks, ok: failed.length === 0 }, null, 2))
  } else {
    console.log(`环境体检（群 ${args.group}）：`)
    for (const check of checks) console.log(`  ${check.ok === true ? '✅' : '⛔'} ${check.name}：${check.detail}`)
    console.log(failed.length === 0 ? '环境可用。' : `有 ${failed.length} 项没通过（不影响离线开发）。`)
  }
  if (args.strict === true && failed.length > 0) process.exitCode = 1
}

await main()
