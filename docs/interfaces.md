# 模块接口约定（0.1.3）

本文件是 `lib/` 下各模块之间的**契约**。任何实现都必须先满足这里的签名与纪律；改契约要先改本文件（由 Lead 维护）。

## 0. 全局纪律（违反即视为缺陷）

1. **绝不向调用方抛错**。所有对外函数要么返回普通值，要么返回 `Result`：`{ ok: true, value }` / `{ ok: false, kind, error }`。异步入口**必须解析**，不许 reject（宿主进程里一个未处理的 rejection 会直接杀掉 `dsh web`）。
2. **宿主半零 bare import**：只能 `import ... from 'node:fs'` 这类内置模块，或相对路径 `./x.js`。禁止 `@deepseek-ai/*`、`zod`、`schemastery`（symlink 安装下解析不到，会 fail loud 导致宿主拉不起来）。
3. **模块级无副作用**：import 一个模块不得读盘、起定时器、发网络、写日志。所有 IO 发生在函数调用里，且可注入依赖。
4. **依赖注入**：需要时间/随机/子进程/fetch/文件系统的模块，都从参数或工厂参数拿（`now`、`spawn`、`fetchImpl`、`readText`），便于单测且不在 import 期摸环境。
5. **日志不打印秘密**：任何日志、`Result.error`、工具返回值都不得包含 token / auth key / 完整请求头。
6. **`dispose()` 幂等**：可被调用 0..n 次；调用后停止调度、作废旧轮次，不提交新的自动发送；已经提交的发送若随后获得成功回执，仍补记账并保留最新窗口状态。
7. **客户端 bundle 单文件自包含**：源码在 `src/client/`，esbuild 生成的 `lib/client.js` 只能 require 静态 seed（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/dsh-client-ui-primitives`），不能 require 兄弟文件；`id` 必须等于包名 `dsh-popo-watcher`。
8. **测试**：`npm test` 和 `npm run test:desktop` 都先校验客户端产物，再完整枚举 `test/*.test.js`（包含 fuzz）。外部服务为桩，IO 落临时目录；普通 Node 仅跳过明确标记的宿主专属测试。

## 1. `lib/config.js`（纯函数，无 IO）

```js
export const DEFAULTS                 // 见 §5
export function defaultConfig(): Config
export function normalizeConfig(raw: unknown): { config: Config, warnings: string[] }   // 未知字段忽略；非法值回落默认并给 warning
export function applyPatch(current: Config, patch: unknown): { config: Config, warnings: string[] }  // RPC config.set 用；只接受已知字段
export function validateGroup(value: unknown): string | undefined   // 纯数字群 ID（如 '1234567'）
```

`applyPatch` 按当前已知字段递归合并普通对象，包含 `judge.thresholds`；未提供及 `undefined` 字段不变，未知字段忽略并报告完整路径，显式非法值仍走规范化。输入和默认配置不会被就地修改。

字段（`Config`）：

| 字段 | 默认 | 约束 |
|---|---|---|
| `group` | `''` | 默认未配置；开始监控、读取消息和发送前必须设置有效的纯数字群 ID |
| `intervalSec` | `20` | 5..600 |
| `windowHours` | `24` | 1..720 |
| `minGapSec` | `20` | 5..3600 |
| `maxChars` | `50` | 10..500（软上限，只告警） |
| `hardMaxChars` | `120` | 20..1000（硬上限，拒发） |
| `dryRun` | `false` | 布尔；仅影响自动发送和自动开场白，手动发送始终提交 |
| `autoResume` | `true` | 布尔 |
| `replyOnlyWhenMentioned` | `false` | 布尔；仅限制普通自动回复，开场白及手动发送豁免 |
| `opening` | `{ enabled: true, text: '大家好，我是群聊助手，有合适的话题时会参与讨论。' }` | text 1..200 字 |
| `quietHours` | `{ enabled: false, start: '23:00', end: '09:00' }` | `HH:MM` |
| `hourlyCap` | `{ enabled: false, max: 6 }` | 1..60 |
| `judge` | `{ enabled: true, model: 'jev-latest', timeoutMs: 8000, unavailablePolicy: 'quiet', thresholds: <§6 默认> }` | unpaid: `unavailablePolicy ∈ {quiet, llm}` |
| `llm` | `{ provider: '', model: '', temperature: 0.9, maxTokens: 200 }` | 空字符串 = 用 `ctx.agentDefaultModel` 的当前档 |
| `prompt` | `{ system: <默认 prompt> }` | 1..4000 字 |
| `popoCliJs` | `''` | 空 = 自动探测 |

## 2. `lib/store.js`（文件系统，全部 never-throw）

```js
export function resolveHome(env = process.env): string                 // env.USERPROFILE ?? env.HOME ?? os.homedir()
export function dataRoot(env = process.env): string                    // <home>/.dsh/popo-watcher
export function groupDir(root: string, group: string): string
export function nowStamp(now = new Date()): string                     // 'YYYY-MM-DD HH:mm:ss'（本地时区）
export function readText(file: string): { ok: boolean, value?: string, error?: string, code?: string }
export function writeTextAtomic(file: string, text: string): { ok: boolean, error?: string }
export function writeText(file: string, text: string): { ok: boolean, error?: string }
export function removeFile(file: string): { ok: boolean, error?: string }   // 不存在也算成功
export function readJson(file: string, fallback: unknown): { ok: boolean, value: unknown, error?: string, code?: string }
export function writeJsonAtomic(file: string, value: unknown): { ok: boolean, error?: string }
export function appendJsonl(file: string, value: unknown): { ok: boolean, error?: string }
export function appendJsonlCapped(file: string, value: unknown, { maxLines, maxBytes }?): { ok: boolean, trimmed?: boolean, error?: string }
export function readJsonlTail(file: string, limit: number): { ok: boolean, rows: unknown[], error?: string }
export function appendLineCapped(file: string, line: string, maxLines = 500): { ok: boolean, error?: string }
export function readLineTail(file: string, limit: number): { ok: boolean, lines: string[], error?: string }
export function ensureDir(dir: string): { ok: boolean, error?: string }
```

读取路径必须为非空字符串，数字文件描述符和超长路径返回 `INVALID_PATH`。读取错误的 `code` 保留文件系统代码（例如 `ENOENT`、`EACCES`），JSON 解析失败为 `JSON_PARSE_ERROR`；原有 `error` 文本继续保留。

约定：写盘用 `tmp + rename` 原子替换；`readJson` 解析失败返回 `{ok:false}` 并给调用方默认值，**不抛**；`readJsonlTail` 只读文件尾部，行数有上限；`appendLineCapped` 超过 `maxLines` 时整体重写（保留最后 `maxLines` 行）；`appendJsonlCapped` 同时执行 `maxLines` 和 UTF-8 `maxBytes` 上限，最多读取 `maxBytes` 的文件尾部，再以临时文件和 rename 原子替换；超大单条保存 `truncated:true` 与 `originalBytes` 审计摘要，不能改变发送正文；目录不可写时返回 `{ok:false, error}`。

路径布局（`root/<group>/`）：`state.json`、`poller.json`、`cursor.json`、`messages.jsonl`、`sends.jsonl`、`judge.jsonl`、`round.jsonl`、`poll.log`；根下有 `config.json` 与 `secret.json`（设置页存的判读 key）。

**上限（长期开窗不会无限涨）**：`messages.jsonl` ≤ 5000 行 / 2MB（`appendJsonlCapped`）、`round.jsonl` ≤ 2000 行 / 1MB、`sends.jsonl`、`judge.jsonl` 均 ≤ 2000 行 / 1MiB、`poll.log` ≤ 500 行、`state.json.sentMessages` ≤ 1000 条（`sentCount` 仍是累计值，不受上限影响）。1000 这个数是算过的：`hourlyCap` 按"最近一小时"数条数，最密的情况是 `minGapSec=5`（720 条/小时），1000 条才够覆盖一小时而不漏算。`test/soak.test.js` 用假时钟把 2100/2500 轮压进几秒里，验证这些上限与守卫在长时间尺度上仍然成立。

## 3. `lib/singleton.js`（Lead 所有）

```js
export const SINGLETON_KEY = '__dshPopoWatcher'
export function claimSingleton(target, instance): () => void
// 语义：若 target[KEY] 已存在，先调用它的 dispose()（吞掉异常）；再把 instance 放上去；
// 返回 release()：仅当当前实例仍是自己时清空，幂等。
```

## 4. `lib/popo.js`（传输层，子进程 + 解析）

```js
export function resolveCli(args?): { ok: boolean, nodePath: string, cliJs?: string, error?: string }
export function createTransport({ spawn, resolve = resolveCli, timeoutMs = 20000, tmpDir, logger }): Transport
```

`Transport`：

```js
{
  describe(): { ok: boolean, cliPath?: string, nodePath?: string, error?: string },
  checkAuth(): Promise<Result<{ uid: string }>>,
  currentUser(): Promise<Result<{ uid: string, names: string[] }>>,
  search({ group, pageSize = 15, sessionFile, atMembers?, timeStart?, timeEnd? }): Promise<Result<{ uid: string, messages: Message[] }>>,
  send({ group, text }): Promise<Result<{ msgId: string }>>,
}
```

- `Message = { t_msg: number, time: string, from: string, name: string, msgId: string, content: string }`（`time` 用本地 `YYYY-MM-DD HH:mm:ss`）。
- `currentUser` 调用 `popo team_current_user_info`，只返回 UID 与非空、去重的 `name`/`nickname`。`atMembers` 必须为非空账号数组，使用 UTF-8 临时 JSON 文件传参；`timeStart`/`timeEnd` 为非负安全整数毫秒时间戳，始终保留群范围。
- 失败结果为 `{ok:false, kind, error, code, retryable}`：`code` 保留上游错误码，否则为 `null`；只有 `FABRIC_NETWORK_ERROR` 与本地调用超时标记 `retryable:true`。错误摘要脱敏后截断，不回显凭据与 URL 参数。传输层所有调用仍只执行一次，只有采集循环重试，发送不重试。
- argv（**不经 shell**）：`[nodePath, cliJs, 'popo', 'message_search', 'query=', 'type=1', 'page=0', 'pageSize=<n>', 'msgType=0', 'sessionList=@file:<sessionFile>']`；发送：`[..., 'popo', 'message_send_team', 'message=@text:<tmpFile>', 'receiver=<group>', 'source=AGENT']`，中文只走 UTF-8 文件，绝不进 argv 之外的命令行。
- 解析（合成样本见 `test/fixtures/popo-search.json`）：`json.ok`、`json.code`、`json.data.data.data.data.uid`、`json.data.data.data.data.result_list[]`；行字段 `t_msg / nfrom / memberName / msg_id / content`。
- **stdout 里可能有噪声**：实测 CLI 会把 `> [!WARNING] …` 打到 stdout（见 §9.2），所以解析是"从噪声里捞出 JSON"（整串 → 逐行 → 括号配对）。
- 发送成功判定（按"宁可丢 id，不可重发"排序）：
  1. 任一已知位置能读到 id（`msgId` / `msg_id` / `messageId`，含 `data.data.data.data` 与顶层）→ `{ok:true, value:{msgId}}`；
  2. 读不到 id 但信封**像成功**（有 `data…` 信封或 `ok:true`，且 `ok !== false`）→ `{ok:true, value:{msgId:'', unrecognized:true}}`，`lib/send.js` 会把警告写进结果与 `round.jsonl.sendWarnings`；
  3. 坏 JSON 时退回 ASCII 正则 `"(?:msgId|msg_id|messageId)"`，命中同样标 `unrecognized`；
  4. `json.ok === false`（实测形状：`{ok:false, code:'POPO_VALIDATION_FAILED', errors:[…], exitCode:2}`）→ `kind:'upstream'` 失败。
- **只看 stdout**（CLI 会往 stderr 打 Node 警告）；`kind ∈ {'cli-missing','spawn','timeout','parse','upstream','empty'}`；超时必须 `handle.terminate()`。
- `checkAuth()` 复用宿主 subprocess 执行 `popo-cli auth status`，只确认 CLI 可启动与登录状态；不采集、不发送，不代表群搜索或网络已通过。只返回账号，不透传凭证元数据。认证错误提示 `popo-cli auth login`；纯升级提示提示 `popo-cli update`，归入 `upstream`，有效 JSON 优先于附带警告。

## 5. 判读兼容入口、纯策略与 HTTP 调用

`lib/judge.js` 保留既有导出；`judge-policy.js` 只包含纯策略，`judge-client.js` 负责 HTTP。草稿发送和手动诊断共用 `buildDraftState(state, text)`，显式带上准确的 `our_draft`；两条路径都使用 `judge.thresholds`。`deadline.js` 将总时限覆盖请求、正文读取和解析，即使适配器忽略取消信号也会按时返回。

```js
export const DEFAULT_THRESHOLDS           // §6
export const GO_KINDS / STOP_KINDS        // ['question','technical_topic','joke_or_tease'] / ['venting_or_conflict','logistics','closed']
export function loadQuestions(readText?): { ok: boolean, questions?: { round: object, draft: object }, error?: string }   // 懒惰读 ./judge-questions.json，绝不抛
export function formatAnswers(raw): object
export function buildState({ messages, selfUid, sinceMs, newMark, sentMessages, chat?, replyTargets? }): object
export function decideRound(answers, thresholds = DEFAULT_THRESHOLDS): { action: 'opening'|'quiet'|'unsure', kind: string, guidance: string, reasons: string[], advisories: string[] }
export function decideDraft(answers, draft, thresholds = DEFAULT_THRESHOLDS): { decision: 'pass'|'block', blocks: Array<{question,noul,reason}>, warnings: Array<{question,noul}>, chars: number }
export function composeRound(view, judgement): view     // 语义层只能加拒绝/加 advisory，绝不放开机械 blocker
export function createJudge({ fetchImpl, getKey, timeoutMs, logger }): { available(): Promise<{ok,error?}>, runRound(state, questions), runDraft(state, questions) }
export function createRound({ judgeClient, draftWriter, logger, now }): { plan(input): Promise<Plan> }   // 见 §5.1
```

- 端点：`POST https://api.typesafe.ai/v1/systemone`，头 `authorization: Bearer <key>`，体 `{ state, model, questions }`；解析 `model / answers / usage.input_tokens`。
- 失败（无 key/网络/HTTP/超时/坏 JSON）→ `{ ok:false, error }`，**不抛**，由调用方降级。
- `runRound/runDraft` 只在上游可用时被调用；`judge.jsonl` 的写入由 watcher 负责，judge 模块不写盘。
- 策略以本仓库 `lib/judge-policy.js` 和对应测试为准：filler 只看新消息，保留 `open_question_for_us` 否决条件，`repeats_existing` 默认阈值为 0.85。

### 5.1 `lib/round.js`（一轮的编排：判读 → 结论 → 文案）

```js
export function buildDraftPrompt({ conversation, ourRecent, guidance, maxChars, onlyReplyTargets? }): string
export function createRound({ judgeClient, draftWriter, logger, now }): { plan(input): Promise<Plan> }
// input = { messages, newCount, selfUid, sentMessages, config, questions, replyTargets?, selfDisplayName?, mentionReason? }
// Plan   = { verdict: 'speak'|'quiet', view, judgement, draft, reason }
```

顺序与纪律：

开启 `replyOnlyWhenMentioned` 时，watcher 在机械检查通过后按本轮消息时间范围搜索 `atMembers=[selfUid]`，与本轮消息 ID 求交，再用当前姓名/昵称匹配正文 @ 标记。搜索 UID、当前用户 UID 必须与采集身份一致；失败、空结果或身份未知均返回 quiet 并记录原因。额外查询不写采集水位。搜索接口不返回原始 @ 成员清单，因此接受手打/引用同名 @ 的误判边界；混合 @所有人和直接 @ 我不排除。

时间范围前后各放宽一秒，避免服务端时间精度使极窄毫秒区间漏查；最终消息 ID 交集保证范围内的旧消息不能触发回复。

`replyTargets` 会补回上下文切片之外的本轮目标，只有这些目标标记为 `is_new`；判读使用当前显示名及回复范围，生成提示明确其余消息仅作背景。普通自动发送必须携带内部确认目标，公开 `sendNow` 传入同名字段不能豁免；开场白与手动发送不受此限制。关闭开关不增加搜索或用户信息调用。

1. **机械层先跑**：`roundView()` 出 blocker（`noNewMessages` / `lastFromSelf` / `lastMessageHasNoText`），挡住就 `quiet` 且**不调判读**（不浪费请求）；
2. **语义层**：`judgeClient.available()` → `runRound()` → `decideRound()` → `composeRoundView()`（只做加法，绝不放开机械 blocker）。判读不可用 → `judgeUnavailable` advisory；
3. **写文案**只在两种情况下发生：判读说 `opening`；或判读整个不可用且 `judge.unavailablePolicy='llm'`。**判读可用但拿不准（judgeUnsure）一律安静**——插件里没有 agent 在环，错误闭嘴比错误发言便宜；
4. 文案为空 / `SKIP` / 文案层缺失或失败 → 一律 `quiet`；
5. 本模块**不写盘、不发送、不碰 transport**（唯一写者是 watcher）；任何异常都退化成 `quiet`。

## 5.2 `lib/llm.js`（文案层：宿主 LLM 写一句话）

```js
export const SKIP_MARKER = 'SKIP'
export function isSkipLine(text): boolean         // 只认「skip」本体（含引号/句号/大小写）
export function cleanDraft(text): string          // 取第一行、剥围栏与引号
export function createDraftWriter({ getLlm, getRoute, logger, now, timeoutMs }): { available(), write({system, prompt, maxTokens}) }
```

- 走宿主的 `llm` 服务：`llm.stream({ provider, model, messages, system, maxTokens, signal })`，只读 `text-delta`，必须收到 `finish/stop`；缺少结束标记、超时、中断或超过文本上限均失败。默认总超时 20s，通过共享 deadline 同时取消并结束等待；
- 消息形状照抄 `@deepseek-ai/dsh-llm` 的 `createUserMessage`（`{ id, role:'user', content:[{type:'text',text}], source:{kind:'plugin',plugin:'dsh-popo-watcher'} }`）——插件不能 import 那个包；
- 路由：`resolveDraftRoute` 供生成调用和状态展示共用；配置 `llm.provider/model` 都非空时优先，缺任意一项则整组回落 `agentDefaultModel.currentSelection()`，返回 `source: 'plugin' | 'host'`；
- `listDraftModels` 使用宿主 `llm.listProviders()` / `llm.listModels(provider)`，按提供方隔离错误，只返回目录显示字段；读取超时默认 8 秒。目录只服务选项展示，不改变调用路由；
- **零 bare import、never-throw、不往 console 打日志**。

## 6. 默认阈值（`DEFAULT_THRESHOLDS`）

```
roundFiller .80 / roundHeated .80 / roundKindStrong .70 / roundKindConf .55 / roundKindGo .50 /
roundKindGoConf .60 / roundAimedAtUs .60 / roundAimedHeated .70 / roundOpenVeto .70 / roundOpenGo .85 /
roundScreen .85 / draftRepeat .85 / draftSelfClaim .70 / draftConflict .70 / draftFiller .70 /
draftLeak .60 / draftWarn .50 / draftWarnLeak .40
```

## 7. 宿主半装配与状态所有权

`watcher.js` 协调轮次、单飞和串行发送；`watcher-settings.js` 管理配置与凭证；`watcher-history.js` 管理只补缺的历史导入和本地读取；`session-state.js` 管理窗口、记账、内存待写状态与回执恢复。公开方法和 RPC 通道不变。

```js
// watcher.js
export function createWatcher({ store, config, transport, judge, compose, logger, now, env,
                                getTransport, schedule, autoRound, judgeClient, sender, draftWriter, keyResolver }): Watcher
// Watcher = { status(), checkCli(), getConfig({reload?}), updateConfig(patch), startWindow({hours}), stop({mode,reason}),
//             resume(), sendNow({text, opening?, manual?}), judgeNow({draft?}), runRound(newMessages), messages(limit),
//             sends(limit), log(limit), keyStatus(), setKey(key), clearKey(), importLegacy({from?}), dispose() }
// 删掉过的"死接口"（没人调用，2026-09 清理）：paths() / markDegraded() / clearDegraded() / internals。
// degraded 和 poll.consecutiveFailures 只表示本实例的故障；当前故障停用后保留告警。
// 重启后的 state.json.collectionError/collectionFailures/stoppedAt 仅作为 window 中的历史记录，
// 不将新实例标为 degraded，不产生新的采集；显式重开清除旧窗口错误。
// startWindow 重算窗口并等待首轮采集；成功才尝试开场白（守卫放行条件见 guards.js）。
// 首轮可重试故障返回 ok:true/recovering:true，不发送或补发开场白；不可重试故障返回 ok:false。
// poller.start() 为 Promise，调用方必须 await。
// stop 支持 stop/mute；sendNow/judgeNow/runRound 都走内部串行队列，全部 never-throw。
// 采集前后调用 shouldStop()；可重试故障最多连续失败 5 次（包含首轮），成功即清零。
// 20 秒间隔下等待 40/80/160/300 秒后重试；不可重试故障立即停止。
// 停止时保存 stopped/stoppedAt/stoppedReason/collectionError/collectionFailures，重启不恢复已停止窗口。
// 落盘失败也立即在内存停用，并记录错误；采集写盘失败不推进水位；远端已确认发送的计数在内存保留。
// poll 快照增加 recovering:boolean、failureLimit:5、nextRetryAt:number|null（Unix 毫秒，重试请求执行时为 null）。
// 重试期间停自动发言；递增故障序号让旧草稿失效，sender 提交前再次核对；在途回执记账保留最新停止标记。
// 手动停止、卸载或窗口到期后不再请求；mute 仅停发言，采集仍遵守同一重试策略。

// rpc.js
export const CHANNEL = '/popo-watcher'
export function createRpcHandler({ watcher, judge }): (endpoint: string, payload: unknown) => Promise<RpcResult>
export function registerRpc(ctx, handler): void     // ctx.inject(['connection', 'webServer'], …)；等待连接和 HTTP 服务均就绪
```

DSH 0.2.0-rc.2 的 `connection.rpc.handle(channel, handler)` 会立即访问 `webServer`，Cordis 会检查 Connection 提供者上下文的依赖声明。`cordis.patch.yml` 为宿主 `connection` 行补充 `webServer` 依赖，保留原有 `webRuntime`；插件自身也同时惰性等待两个服务。非 Web 组合没有 `connection` 行时不新增该行，RPC 保持等待，不影响宿主插件激活。

RPC 结果信封：`{ ok:true, value }` / `{ ok:false, error:{ code, message, details } }`；统一错误码为 `popo-watcher/error`，`details` 默认 `{}`。三个错误字段均为宿主 Connection 必需；缺少 `code` 或 `details` 会让浏览器报 `invalid server-response failure`，遮住真实原因。`status` 的内部失败也通过同一错误信封转换。

**端点表（客户端与宿主共同契约）**

| endpoint | payload | 状态 |
|---|---|---|
| `status` | – | 快照新增 `persistence: {ok:boolean, error:string|null}`，并含 `round`、`judge.keyStored`、`configState`、`llm.resolved: {provider, model, source} \| null`；只读当前路由，不查询模型目录 |
| `cli.check` | – | 返回 `{healthy, message}`；只在用户点击时检查 CLI 与登录，不开窗、不改水位、不自动登录；检查完成但 CLI 异常时 RPC 仍 `ok:true`，`healthy:false` |
| `config.get` | `{reload?: boolean}` | 返回 `{config, warnings, configState}`；显式 `reload:true` 重新读盘 |
| `config.set` | `{patch}` | 返回 `{config, warnings, written, configState}`；只改明确字段 |
| `models.list` | `{scope?: 'all'\|'judge'}` | 默认返回 `{llm, judge}`，`scope:'judge'` 仅返回 `{judge}`；目录失败分别携带错误，不阻断其他目录 |
| `start` | `{hours?}` | 返回 `{window, polling, recovering, opening}`；首轮可重试故障时 `polling:true/recovering:true`，保持窗口并跳过开场白；不可重试故障返回错误信封并关闭窗口 |
| `stop` | `{mode:'stop'\|'mute', reason?}` | 实现 |
| `messages` | `{limit?}` | 异步实时查询当前有效群的服务端消息；默认 30、整数范围 1..200；返回 `{rows, limit, group, fetchedAt}`，按 `t_msg` 倒序 |
| `sends` / `log` | `{limit?}` | 本地记录（分别读 sends.jsonl / judge+round+poll 合并） |
| `judge.now` | `{draft?}` | 实现（draft → 草稿模式；无 draft → 一轮判读） |
| `send.now` | `{text, opening?}` | 返回值透传可选 `stateWritten`；`false` 仍为发送成功，需展示记账失败。RPC 设置 `manual:true`，跳过全部自动守卫、判读与演练；手动消息按普通发言记账，旧 `opening` 入参不标记开场白。仅校验正文非空与生效目标群有效；自动轮次不传 manual |
| `key.status` | – | 实现（`{configured, source, stored}`；`source ∈ file\|env\|user-env\|explicit\|none`） |
| `key.set` | `{key}` | 实现（清洗后写 `<数据根>/secret.json`；**返回值与日志都不含 key**） |
| `key.clear` | – | 实现（删文件；环境变量/注册表那两档不受影响，返回值说明剩余来源） |
| `importLegacy` | `{from}` | 必须显式提供源目录；自动认 `<from>/<group>/`；只补缺、不覆盖、不导窗口；返回 `{group, from, imported, skipped}` |

**配置状态与读写约束**：

- `watcher.messages(limit)` 返回 Promise，通过现有 `transport.search({group, pageSize})` 查询，不传采集器的 `sessionFile`，由传输层创建并清理独立临时文件。`fetchedAt` 是成功查询完成时的完整本地时间。缺失或无效的消息列表视为失败；成功空列表保持为空，不拼入本地旧消息。查询不进写操作队列，不写监控文件、不推进水位、不启动采集、判读或发送，失败也不修改采集失败计数。查询期间换群或释放实例会作废结果。
- 群消息页可见时立即查询并每 20 秒刷新；手动与自动刷新共享请求锁。隐藏窗口时不查询，恢复可见时立即查询；切换页签、记录类型或卸载时清理定时器。按有效群与连接隔离缓存，忽略旧响应；错误保留上次成功结果与获取时间并标记缓存。已发送和判读日志保持按需读取。

- 模型目录：`llm = {ok, providers:[{id,name,models:[{id,name}],error?}], defaultSelection:{provider,model}|null, error?}`；`judge = {ok, models:[{id,name,description}], error?}`。TypeSafe 使用 `GET /v1/models`，复用当前 key 与判读超时，仅在服务端发送凭证。模型以 `(provider,id)` 标识；目录不含连接设置或凭证。
- 设置页仅提供目录下拉选择；生成配置成对更新或成对清空，判读写入 `judge.model`，共用原有保存/撤销流程。旧值未出现在目录中仅作保留展示，不自动改写；目录错误不会阻止其他配置保存。首次进入设置页加载，手动刷新可重试，更新/清除 key 仅刷新判读；迟到的旧响应不能覆盖新的列表或配置草稿。

- `default`：配置文件缺失（`ENOENT`），使用默认配置且不生成读取失败告警；空 patch 可以保存默认配置。
- `saved`：配置正常从文件读取，或本次写盘成功。
- `unsaved`：配置仅在内存生效，原因是写盘失败，或文件中的非法值经规范化修正但尚未写回。`written:false` 仍是成功信封，必须说明未持久化。
- `error`：文件权限、解析、数据根等读取异常；保留详情并禁止 `updateConfig` 覆盖。显式 `reload:true` 可在修复后重新读取；普通 get/status 不重复读配置文件。
- 正在采集或有未停止的有效窗口时，禁止修改 `group`/`intervalSec`，也禁止 reload；相同值不算修改，拒绝时整个 patch 不生效。临时配置处于 `unsaved` 时拒绝 reload，避免丢弃尚未持久化的值。
- 前端遇到缺少 `configState` 的旧响应显示未知，不据此推断保存成功；已有 `written:true/false` 仍可用于确认本次保存结果。
- 概览页的“只回复 @ 我的消息”复用监控滑块样式，使用 `config.set({patch:{replyOnlyWhenMentioned}})` 即时保存，运行期间也可切换。保存共用单飞锁，只更新基线并保留其他表单草稿；写盘失败显示实际临时值，可在概览中单独重试保存。`status` 同时返回当前 `replyOnlyWhenMentioned`。

**密钥纪律（贯穿 RPC / 快照 / 日志）**：`key.set` / `key.clear` / `key.status` / `status` 的返回值里**只有"有没有 + 从哪来"**，绝不出现 key 本身；watcher 也只有 `keySource()`（取值给判读用）与 `hasStoredKey()`（给快照用的布尔）两条路径碰它。`keyStatus()` 里 `configured` 由"文件在不在"与"解析器怎么说"共同决定（不一致时以"能用"为准），所以页面不会出现"文件在、却显示未配置"这种自相矛盾。

## 8. 客户端契约（`lib/client.js`）

- `window.__ModuleLoader__.load({ id: 'dsh-popo-watcher', factory })`；导出 `name` / `inject`（`['slots','connection']`）/ `apply`。
- `apply(ctx)`：`const connection = ctx.get('connection')`；没有就静默返回（不注册任何东西）。注册 `settings.section`（`id: 'popo-watcher'`、`order: 50`、`label: 'POPO自动水群'`），保留现有导航图标补丁（`data-dsh-popo-icon`，幂等 + 自愈）。
- 页面通过 `connection.rpc.call('/popo-watcher', '<endpoint>', payload)` 取数，返回 `{ok,value}` / `{ok:false,error:{code,message,details}}`；打开页面时每 2s 轮询 `status`。
- **渲染纪律**：对 payload 全防御（`?.` + 默认值）；整树包一层错误边界（class 组件，`componentDidCatch` 渲染一行错误文案）；缺失 seed 导出（`React.createElement` 不存在等）时跳过注册并 `console.warn`。
- **当前页面**：概览／设置／记录三个页签，切换只隐藏内容，保留草稿、手动输入和已加载记录。手动发言、判读凭证和历史导入始终展开；运行详情与诊断、错误详情及配置详情保留折叠行为。
- **页面纪律**：`Page` 保持无 hook，错误边界覆盖整树；`Panel` 通过 `panel-state.js` 管理完整配置基线和唯一状态轮询。状态失败保留旧快照并标记过期；动作后的在途旧响应不覆盖新结果；卸载后不更新状态。
- **参数提交**：只提交编辑过且启用的字段。关闭开场白或每小时上限时只提交开关，服务端保留原文案/数值；空数字、非有限数字和越界值显示字段错误并阻止保存。保存期间锁住表单；失败保留草稿。
- **操作约束**：未保存参数阻止开始，不妨碍停止；窗口仍有效且未停止、或采集仍运行时锁住群和间隔。时长取配置默认值，显式临时覆盖保持独立。重新开始仍建立新窗口，不提供旧窗口恢复。手动发送只依赖非空正文、有效的生效群 ID 和当前请求是否结束；不依赖采集身份、历史消息、窗口、状态刷新成功或其他参数草稿。
- **手动路径**：`deliverText` 不读取消息历史、不加载问句、不构建判读上下文；`manual:true` 在发送器中跳过自动守卫、判读及 `dryRun`。正文原样交给已有 CLI 传输和回执处理，不分段、不改写、不重试；成功沿用串行记账，保留原窗口及静音/停止状态；记账失败另行暂停自动流程，手动发送仍可用。界面明确标注自动规则和自动演练；三个页签共用的页头仅显示标题，生效群 ID 仍可在运行详情中查看。
- **准确反馈**：静音/停止/到期依据窗口与采集字段显示；发言数量是累计值。开窗后采集或开场白失败属于部分成功，演练不表述为已发送。凭证的“已配置”不等于可用性验证；只允许清除存在的本地副本。
- **布局**：单层根容器；以内容区 520px 为单双列断点，开场白整行；页签栏和保存栏在宿主滚动区吸附，不另建整页滚动。保存栏覆盖宿主设置区底部的 24px 留白。

## 9. 测试注入点与固件

| 模块 | 注入点 | 固件 |
|---|---|---|
| `config` | 无（纯函数） | 无 |
| `store` | `root` 参数指向 `os.tmpdir()` 临时目录 | 无 |
| `popo` | `spawn`（假句柄：`collected`/`done`/`terminate`）、`resolve`、`now` | `test/fixtures/popo-search.json`（保持响应结构的合成样本） |
| `judge` | `fetchImpl`、`getKey`、`now` | 内联合成答案（`test/judge-policy.test.js`） |
| `round` | `judgeClient`、`draftWriter`、`now` | 内联合成答案 + 桩文案层（`test/round.test.js`） |
| `llm` | `getLlm`（假 `stream()` 异步生成器）、`getRoute`、`now`、`timeoutMs` | 无（chunk 形状按 `@deepseek-ai/dsh-llm` 的 `text-delta`/`finish` 手写） |
| `client` | 注入 `window/document/MutationObserver`、React hooks 与定时器；浏览器预览加载实际组件及 Desktop 的 React/主题 | `test/fixtures/ui-preview.html`，通过 `node tools/preview-ui.mjs` 启动 |
| `watcher` / `poller` | `store`/`getTransport`/`judgeClient`/`draftWriter`/`now`/`schedule` 全桩；`test/watcher-round.test.js` 里用**真的** sender+guards+poller，只桩三处外部世界（传输/判读/文案） | 无 |
| `key-source` / watcher 的 key 接口 | `env`、`file`、`readJson` 注入；watcher 用 `keyResolver` 桩（不读本机注册表） | 临时目录里的真 `secret.json` |
| `importLegacy` | 桩 store（**统一文本表**：json 与文本读同一批文件，与真 store 同语义） | 内联的 skill 侧真实字段形状（`msg_id` / `poller-state.json` / `sentMessages`） |
| `key-source` | `env`、`name` | 无（注册表读取只在 win32 上走） |

**已知缺口（诚实记录）**：`send` 的**成功回应形状至今没有样本**——源实现只留了 `"msgId"` 正则在 PS 里；
本轮把能查的都查了：CLI bundle 里 `msgId` 只出现一次（还是别处的 schema），`explain-schema message_send_team`
只有入参没有应答样例，CLI **没有 dry-run**，所以"不真发一条"就永远看不到成功信封。
为此把判定改成**保守**的（见 §4 的四级规则）：认不出 id 也报成功（标 `unrecognized`），
因为"认不出就报失败"会让 watcher 不记账、下一轮**重发**——比丢一个 id 危险得多。
首次真发之后要核对 `round.jsonl.sendWarnings`：出现 `unrecognized` 就说明形状与假设不同，按实际形状收紧 `findMessageId`。

### 9.1 阈值复验（P2 门禁）

```powershell
node tools/replay.mjs --group <group-id> --legacy <history-directory>
```

- **真实发言回放**：每条历史发言重建"发言前一刻"夹具（会话切片 14 条、带 `our_recent_messages`、`is_new` 水位停在倒数第二条），跑真判读的 draft 模式 → **误拦必须为 0**；
- **坏草稿正例**：`tools/judge-draft-cases.json` 只包含合成示例；每条按 `p`（对话截止下标）构造夹具，需结合自己的回放上下文调整，或用 `--cases` 指定本地样本。漏拦必须为 0；可放行样本被拦只记录，不判硬失败。
- 没有 key 时打印提示并以 0 退出（离线不红）。key 取值顺序：显式 → `process.env` → `HKCU\Environment`（见 `lib/key-source.js`）。

### 9.2 真实环境验证（不吃宿主也能跑）

```powershell
node tools/smoke.mjs --group <group-id>             # 只读体检，包含真实消息搜索
node tools/smoke.mjs --group <group-id> --judge     # 额外调用一次 TypeSafe
node tools/smoke.mjs --group <group-id> --strict    # 任一检查失败则退出 1
node tools/live.mjs --group <group-id>             # 临时数据目录内干跑，不发送
```

用 `node:child_process` 冒充 subprocess seam 直接驱动 `lib/popo.js`（seam 的实现在 `tools/shared.mjs`，
与宿主里的句柄形状一致）。这些工具会读取指定群的数据，不能代替离线测试；所有入口都要求显式指定群 ID。

**`tools/live.mjs`（真机演练）**：把 watcher + poller + 真 CLI 真跑几十秒，验证"采集 → 落盘 → 触发一轮 →
出结论 → 落流水"整条链路。三重安全边界：数据根在**临时目录**、`dryRun: true`（`lib/send.js` 在传输层前
短路）、开场白关掉；结束还会断言"一条都没发"，发现发了就以 1 退出。结果取决于显式选择的群、认证和当前网络。

**能问到 CLI 的边界（实测）**：`popo explain-schema <命令>` 能打印**入参** schema（本插件传的
`message=@text:<file>` / `receiver=<tid>` / `source=AGENT` 与它逐条对得上，且它明确要求"发纯文本不要传
`msgType=0`"——我们正是省略的）；用缺参数调用 `message_send_team` 能在**不联网**的情况下拿到真实的失败
信封（`{ok:false, code:'POPO_VALIDATION_FAILED', errors:[…]}`，退出码 2）。**CLI 没有 dry-run，也没有成功
应答样例**，所以成功形状仍是未知的（见 §9 的已知缺口）。

> **它抓到的真 bug（已修）**：poller 原先自己算数据根（`store.dataRoot()` 读 `process.env`），
> 和 watcher 注入的 `env` 不是同一个 home——演练里消息被写进了**真实 home**。现在群目录由 watcher
> 通过 `resolveDir(group)` 传给 poller（路径只有一个主人），并有专门的单测钉住这条。

**实测漂移（已修）**：popo-cli 会把 `> [!WARNING] …` 这类提示**直接打到 stdout**（不是只有 stderr），
JSON 被夹在中间。原先"stdout 就是 JSON"的假设会让每一轮采集都判成 `parse` 失败——现在 `parseJson`
会整串→逐行→括号配对地"从噪声里捞出 JSON"，并把噪声作为 `noise` 带进结果（`poll.log` 只记一次）。

**网络与代理**：判读（api.typesafe.ai）与文案（宿主 LLM）需要访问对应服务。代理配置由运行环境提供，
独立 `tools/*.mjs` 进程不会自动继承宿主进程的全局 dispatcher；需要代理时应为独立进程配置网络。
这时 `tools/replay.mjs` 会明确报"判读全部不可用 → 这一轮复验没有生效"，并以 1 退出（**不再假绿**）；
要离线跑就加 `--allow-unavailable`。插件本身在这种环境下的行为是**安静不发**（判读不可用 → `quiet`）。

## 10. 明确不做（当前版本）

多群、slash 命令、给宿主半加构建步骤、动其它插件。判读不可用时的默认行为是**安静不发**（可配 `judge.unavailablePolicy='llm'`，把"要不要开口"交给模型）。`key.set` / `key.clear` / `importLegacy` 均已实现；凭证优先级为设置页文件、进程环境变量、Windows 用户环境变量。

## 11. 下一步（已知缺口，按优先级）

1. agent 侧工具还只有只读的 `popo_watch_status`：要不要放开"让模型开窗/发言"是个安全取向问题（群消息是素材不是指令），当前刻意只给只读工具；`lib/tools.js` 里留了扩展位；
2. `lib/judge-questions.json` 是仓库内独立维护的问句集，修改时应同步验证判读策略和测试。

发布文件中的群号、账号与消息样本均为合成数据；历史本机截图、日志和验收资料保留在本地，不作为公开测试证据。

## 12. 故障一致性

停止立即作废旧请求并写停止状态，不等待慢判读释放队列；较早的开始请求不能覆盖较晚的停止。采集消息和水位全部写入成功后才触发轮次，重试写入以消息 ID 避免重复追加。

已确认发送始终返回成功。状态或发送流水写入失败会保留内存记录、暂停自动流程，并返回警告；`start` 先补写，再建立新窗口。重启通过已成功写入的一侧重建另一侧，恢复期间不自动开窗、不重发消息。若状态和流水均未成功写入且进程终止，内存回执没有耐久性保证。
