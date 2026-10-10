/**
 * 判读阈值复验（移植自 skill 的 popo-judge-replay.ps1）。
 *
 * 两件事：
 * 1) **真实发言回放**：拿历史 `sends.jsonl` 里每条真发过的内容，重建"发言前一刻"的会话切片，
 *    跑真判读的 draft 模式——**必须 0 误拦**（误拦一条就是技能在正常接话时闭嘴）。
 * 2) **坏草稿正例**：`tools/judge-draft-cases.json` 里每条标注草稿，必须命中它 `expect` 里写的问题。
 *
 * 需要 TYPESAFE_API_KEY（Process → User 作用域自动兜底）与网络；没有 key 时打印提示并以 0 退出
 * （CI/离线不该因此红）。
 *
 * 用法：node tools/replay.mjs --group <group-id> --legacy <history-directory> [--limit 40]
 *
 * @module dsh-popo-watcher/tools/replay
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildState, createJudge, decideDraft, loadQuestions } from '../lib/judge.js'
import { resolveKey } from '../lib/key-source.js'
import { validateGroup } from '../lib/config.js'

/** 解析命令行参数（够用即可，不引依赖）。 */
function parseArgs(argv) {
  const out = { group: '', legacy: '', limit: 40, cases: null, allowUnavailable: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--group' && value) out.group = value
    else if (key === '--legacy' && value) out.legacy = value
    else if (key === '--limit' && value) out.limit = Number(value)
    else if (key === '--cases' && value) out.cases = value
    else if (key === '--allow-unavailable') out.allowUnavailable = true
  }
  return out
}

/** 逐行读 JSONL（坏行跳过）。 */
function readJsonl(path) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 整文件读 JSON（失败返回 null）。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 本地时间字符串 → 毫秒（失败返回 null）。 */
function parseStamp(text) {
  if (typeof text !== 'string') return null
  const parsed = Date.parse(text.replace(' ', 'T'))
  return Number.isNaN(parsed) ? null : parsed
}

const args = parseArgs(process.argv.slice(2))
if (!validateGroup(args.group) || args.legacy.trim() === '') {
  console.error('请用 --group 和 --legacy 指定群 ID 与历史数据目录；未读取数据或调用模型。')
  process.exit(1)
}
const key = await resolveKey({ name: 'TYPESAFE_API_KEY' })
if (key === '') {
  console.log('跳过：没有 TYPESAFE_API_KEY（Process 与用户作用域都没有）。')
  process.exit(0)
}

const questions = loadQuestions()
if (questions.ok !== true) {
  console.log(`无法读取问句集：${questions.error}`)
  process.exit(1)
}

const judge = createJudge({ getKey: () => key, timeoutMs: 15000, model: 'jev-latest' })
const available = await judge.available()
if (available.ok !== true) {
  console.log(`判读不可用：${available.error}`)
  process.exit(1)
}

const runDir = join(args.legacy, args.group)
const messages = readJsonl(join(runDir, 'messages.jsonl'))
const sends = readJsonl(join(runDir, 'sends.jsonl')).filter((entry) => typeof entry?.content === 'string')
/** state.json 是格式化 JSON（多行），必须整文件解析，不能按行。 */
const stateFile = readJson(join(runDir, 'state.json'))
const selfUid = typeof stateFile?.selfUid === 'string' ? stateFile.selfUid : ''

/** 单条通道默认回溯的上下文条数（与源脚本 `$Tail` 默认一致）。 */
const TAIL = 14

console.log(`数据来源：${runDir}`)
console.log(`消息 ${messages.length} 条，历史发言 ${sends.length} 条，selfUid=${selfUid === '' ? '未知' : '已知'}`)

/**
 * 构造"某个时刻之前的夹具"（等价于源脚本的 New-Fixture）：
 * - 会话切片 = 该时刻之前的消息取最后 TAIL 条；
 * - 发言历史 = 该时刻之前的发言内容（喂给 our_recent_messages，repeats_existing 靠它）；
 * - is_new 水位 = 切片倒数第二条（源脚本把 agent 游标停在那里，于是最后一条是"新的"）。
 * @param beforeMs - 截止时刻（毫秒）。
 * @returns System One 的 state 对象。
 */
function fixtureState(beforeMs) {
  const slice = messages
    .filter((message) => typeof message?.t_msg === 'number' && message.t_msg > 0)
    .filter((message) => {
      const at = parseStamp(message.time)
      return at !== null && at < beforeMs
    })
    .slice(-TAIL)
  const priorSends = sends
    .filter((entry) => {
      const at = parseStamp(entry.at)
      return at !== null && at < beforeMs
    })
    .map((entry) => entry.content)
  const sinceMs = slice.length >= 2 ? slice[slice.length - 2].t_msg : 0
  return buildState({ messages: slice, selfUid, sinceMs, newMark: slice.length, sentMessages: priorSends, chat: {} })
}

// ---------------------------------------------------------------- 1) 真实发言回放
let blocked = 0
let checked = 0
/** 判读没跑成的次数：全都失败时这一轮复验**等于没验**，不能报"通过"。 */
let unavailable = 0
for (const send of sends.slice(-args.limit)) {
  const at = parseStamp(send.at)
  if (at === null) continue
  const state = fixtureState(at)
  if (state.conversation.length < 3) continue
  state.our_draft = send.content
  const result = await judge.runDraft(state, questions.questions.draft)
  checked += 1
  if (result.ok !== true) {
    unavailable += 1
    if (unavailable <= 3) console.log(`  判读不可用：${result.error}`)
    continue
  }
  const decision = decideDraft(result.answers, send.content)
  if (decision.decision === 'block') {
    blocked += 1
    console.log(`  [误拦] ${JSON.stringify(send.content).slice(0, 60)} → ${decision.blocks.map((b) => b.question).join(',')}`)
  }
}
console.log(`真实发言回放：检查 ${checked} 条，误拦 ${blocked} 条（要求 0），判读不可用 ${unavailable} 条`)

// ---------------------------------------------------------------- 2) 坏草稿正例
const casesPath = args.cases ?? fileURLToPath(new URL('./judge-draft-cases.json', import.meta.url))
let caseTotal = 0
let caseHit = 0
/** 判读没跑成的用例（同样让复验失去意义）。 */
let caseUnavailable = 0
/** 漏掉坏草稿 = 硬失败（把不该发的发出去了）。 */
const missed = []
/** 拦掉标注为"可放行"的草稿 = 记录但不硬失败：标注偏乐观的边界样本允许存在，见下方说明。 */
const overBlocked = []
const MAX_OVER_BLOCKED = Number.isFinite(args.maxOverBlocked) ? Number(args.maxOverBlocked) : 1
let cases = []
try {
  cases = JSON.parse(readFileSync(casesPath, 'utf8')).cases ?? []
} catch (error) {
  console.log(`无法读取坏草稿用例：${error instanceof Error ? error.message : String(error)}`)
}
for (const item of cases) {
  if (typeof item?.draft !== 'string') continue
  // 用例的 `p` 是"对话截止的消息下标"（源脚本语义）；缺省则用最后一条。
  const pivotIndex = Number.isInteger(item.p) && item.p >= 0 && item.p < messages.length ? item.p : messages.length - 1
  const pivotAt = parseStamp(messages[pivotIndex]?.time)
  const state = pivotAt === null ? null : fixtureState(pivotAt)
  if (state === null) continue
  state.our_draft = item.draft
  const result = await judge.runDraft(state, questions.questions.draft)
  caseTotal += 1
  if (result.ok !== true) {
    caseUnavailable += 1
    continue
  }
  const decision = decideDraft(result.answers, item.draft)
  const hits = decision.blocks.map((entry) => entry.question)
  const wanted = typeof item.expect === 'string' && item.expect !== '' ? item.expect : null
  if (wanted === null) {
    if (hits.length === 0) caseHit += 1
    else overBlocked.push(`${item.id} → ${hits.join(',')}`)
  } else if (hits.includes(wanted)) caseHit += 1
  else missed.push(`${item.id}（期望 ${wanted}，实际 ${hits.join(',') || '放行'}）`)
}
console.log(`坏草稿用例：${caseHit}/${caseTotal} 符合标注（漏拦 ${missed.length}，边界假阳性 ${overBlocked.length}，判读不可用 ${caseUnavailable}）`)
for (const line of missed) console.log(`  [漏拦] ${line}`)
for (const line of overBlocked) console.log(`  [边界假阳性] ${line}`)
console.log('说明：假阳性只记录不判失败（标注偏乐观的边界样本），漏拦必须为 0——放出去的代价比闭嘴大。')

// 判读一次都没成功 = 这一轮什么都没验出来。**不能报通过**（以前这里会在网络故障时假绿）。
const judged = checked - unavailable + (caseTotal - caseUnavailable)
const nothingJudged = judged === 0 && (checked > 0 || caseTotal > 0)
if (nothingJudged) {
  console.log(unavailable + caseUnavailable > 0
    ? '判读全部不可用：这一轮复验没有生效（不是通过）。检查网络/代理或 TYPESAFE_API_KEY 后重跑；确实要离线跑就加 --allow-unavailable。'
    : '没有可复验的样本：检查 --legacy 指向的 run 目录里有没有 sends.jsonl / messages.jsonl。')
  if (args.allowUnavailable !== true) {
    console.log('阈值复验未通过')
    process.exit(1)
  }
  console.log('（--allow-unavailable：按"离线不红"处理）')
  process.exit(0)
}

const ok = blocked === 0 && caseTotal > 0 && missed.length === 0 && overBlocked.length <= MAX_OVER_BLOCKED
console.log(ok ? `阈值复验通过（实际判读 ${judged} 次）` : '阈值复验未通过')
process.exit(ok ? 0 : 1)
