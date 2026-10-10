/**
 * POPO 传输层：通过 `popo-cli`（Fabric Gateway 的代理）搜索群消息、发送群消息。
 *
 * 为什么走子进程而不是自己发 HTTP：真正做认证的是 `fabric`（OpenID 凭证在 `~/.fabric/credentials`，
 * 过期由 CLI 自己续），插件复用它最稳；自己实现认证等于把长期凭证照看搬到插件里。
 *
 * CLI 响应约定（合成样本见 `test/fixtures/popo-search.json`）：
 * - 回应体是 `ok/code` + `data.data.data.data.{uid,result_list}`（更外层还有一层 envelope）；
 * - 行字段：`t_msg / nfrom / memberName / msg_id / content`；
 * - CLI 会往 **stderr** 打 Node 警告，而且**也会往 stdout 打 markdown 提示**（实测 `> [!WARNING]`），
 *   所以解析必须是"从噪声里捞出 JSON"，不能直接 `JSON.parse(stdout)`（见 `parseJson`）；
 * - 中文只经 UTF-8 文件传参（`message=@text:<file>`），绝不过命令行。
 *
 * 纪律：全部 never-throw，失败返回 `{ ok:false, kind, error }`；超时必须 `terminate()` 子进程树
 * （旧实现里一次卡死的 poll 会让监控彻底失明，watchdog 就是为它写的）。
 *
 * @module dsh-popo-watcher/popo
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** popo-cli 的 node 入口（npm 全局安装布局）。 */
const CLI_RELATIVE = ['npm', 'node_modules', '@popo', 'cli', 'bin', 'popo.js']

/** stdout 收集上限（消息列表很小，给足余量）。 */
const STDOUT_MAX_BYTES = 4 * 1024 * 1024

/** stderr 收集上限（只需要诊断信息）。 */
const STDERR_MAX_BYTES = 64 * 1024

/** 单次子进程的宽限期（毫秒）。 */
const GRACE_MS = 2000

/** 官方 CLI 的认证失败码；其他失败不能一律要求重新登录。 */
const LOGIN_REQUIRED_CODES = new Set([
  'FABRIC_AUTH_REQUIRED', 'FABRIC_AUTH_LOGIN_REQUIRED', 'FABRIC_AUTH_RELOGIN_REQUIRED',
  'FABRIC_NOT_AUTHENTICATED', 'FABRIC_AUTH_ERROR', 'FABRIC_UNAUTHORIZED',
  'FABRIC_OPENID_EXPIRED', 'FABRIC_OPENID_TIMEOUT', 'FABRIC_OPENID_NO_PENDING_LOGIN',
  'FABRIC_LOGIN_ERROR', 'FABRIC_INVALID_SK',
])

/**
 * 定位 popo-cli 的入口与 node 可执行文件。
 * @param args - 注入点。
 * @param args.explicit - 显式指定的 popo.js 路径（配置项 `popoCliJs`）。
 * @param args.env - 环境对象（默认 `process.env`）。
 * @param args.exists - 存在性判断（默认 `existsSync`）。
 * @param args.nodePath - node 可执行文件（默认 `process.execPath`）。
 * @returns `{ ok, nodePath, cliJs?, error? }`。
 */
export function resolveCli(args = {}) {
  const { explicit = '', env = process.env, exists = existsSync, nodePath = process.execPath } = args
  try {
    if (typeof explicit === 'string' && explicit !== '' && exists(explicit)) {
      return { ok: true, nodePath, cliJs: explicit }
    }
    const appData = env?.APPDATA ?? env?.AppData ?? ''
    if (typeof appData === 'string' && appData !== '') {
      const candidate = join(appData, ...CLI_RELATIVE)
      if (exists(candidate)) return { ok: true, nodePath, cliJs: candidate }
    }
    const home = env?.USERPROFILE ?? env?.HOME ?? ''
    if (typeof home === 'string' && home !== '') {
      const candidate = join(home, 'AppData', 'Roaming', ...CLI_RELATIVE)
      if (exists(candidate)) return { ok: true, nodePath, cliJs: candidate }
    }
    return {
      ok: false,
      nodePath,
      error: '找不到 popo-cli（期望 %APPDATA%\\npm\\node_modules\\@popo\\cli\\bin\\popo.js，可用配置 popoCliJs 指定）',
    }
  } catch (error) {
    return { ok: false, nodePath, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 本地时间戳（与 store.nowStamp 同格式，保持流水一致）。 */
function stamp(ms) {
  try {
    const date = new Date(ms)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  } catch {
    return ''
  }
}

/**
 * 从 CLI 回应里取出有效载荷（`data.data.data.data`，兼容 `data.data.data`）。
 * @param json - 已解析的回应体。
 * @returns 有效载荷对象，或 undefined。
 */
function payloadOf(json) {
  const candidates = [json?.data?.data?.data?.data, json?.data?.data?.data]
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object') return candidate
  }
  return undefined
}

/** 一次搜索回应里的消息行 → 归一化记录。 */
function toMessage(row, fallbackMs) {
  const raw = typeof row?.t_msg === 'number' ? row.t_msg : Number(row?.t_msg ?? 0)
  // 缺时间戳的行不能伪造 1970（下游按 t_msg 做水位比较，1970 会被当成"很早的消息"混进判断）。
  const valid = Number.isFinite(raw) && raw > 0
  return {
    t_msg: valid ? raw : 0,
    time: stamp(valid ? raw : fallbackMs),
    from: typeof row?.nfrom === 'string' ? row.nfrom : '',
    name: typeof row?.memberName === 'string' ? row.memberName : '',
    msgId: typeof row?.msg_id === 'string' ? row.msg_id : '',
    content: typeof row?.content === 'string' ? row.content : '',
  }
}

/**
 * 创建传输层。
 * @param options - 依赖注入。
 * @param options.spawn - `ctx.subprocess.spawn`（必需；缺失时所有操作返回 `cli-missing`）。
 * @param options.resolve - CLI 解析函数（默认 `resolveCli`）。
 * @param options.timeoutMs - 单次调用超时（默认 15000）。
 * @param options.tmpDir - 临时文件目录（默认 `os.tmpdir()`）。
 * @param options.logger - 日志回调（可选）。
 * @param options.now - 取当前毫秒时间（默认 `Date.now`）。
 * @returns Transport。
 */
export function createTransport(options = {}) {
  const {
    spawn,
    resolve = resolveCli,
    timeoutMs = 20000,
    tmpDir = tmpdir(),
    logger,
    now = Date.now,
  } = options

  /** 解析结果缓存：**只缓存成功**——装好 CLI 之后必须能自愈，不该要求重载插件。 */
  let resolved = null

  /** 取 CLI 解析结果（成功缓存、失败每次重探）。 */
  function resolveInfo() {
    if (resolved?.ok === true) return resolved
    const info = resolve()
    if (info?.ok === true) resolved = info
    return info
  }

  /** 描述当前传输可用性（供 status / 页面显示）。 */
  function describe() {
    try {
      if (typeof spawn !== 'function') return { ok: false, error: '宿主未提供 subprocess 服务' }
      const info = resolveInfo()
      if (info?.ok !== true) return { ok: false, error: info?.error ?? '找不到 popo-cli' }
      return { ok: true, cliPath: info.cliJs, nodePath: info.nodePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 错误摘要不回显凭据或 URL 参数；先脱敏再截断。 */
  function safeDetail(value) {
    return String(value ?? '')
      .replace(/https?:\/\/[^\s<>"']+/gi, (address) => {
        try {
          const url = new URL(address)
          url.username = ''
          url.password = ''
          url.search = ''
          url.hash = ''
          return url.toString()
        } catch { return '[url]' }
      })
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[redacted]')
      .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=][^\r\n]*/gi, '[redacted]')
      .replace(/\b(?:[\w-]*token|[\w-]*secret|api[_-]?key|password|credential\w*|sk)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi, '[redacted]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 400)
  }

  /** 只标记可重试性；重试由采集器负责，发送绝不在传输层重试。 */
  function fail(kind, error, { code = null, retryable = kind === 'timeout' } = {}) {
    return { ok: false, kind, error: safeDetail(error), code, retryable }
  }

  function loginRequired(detail) {
    return fail('upstream', `POPO CLI 未登录或登录已失效（${detail}）。请在终端运行 popo-cli auth login，完成浏览器登录后重新检查。`, { code: detail })
  }

  /** 搜索、发送和手动检查共用认证错误提示，保留上游错误码。 */
  function upstreamFailure(json, diagnostic = '') {
    const code = String(json?.code ?? '')
    if (LOGIN_REQUIRED_CODES.has(code)) return loginRequired(code)
    const detail = typeof json?.message === 'string' ? safeDetail(json.message) : ''
    return fail('upstream', `popo-cli 返回失败：${code || '未知'}${detail && detail !== code ? `：${detail}` : ''}${diagnostic ? `（${diagnostic}）` : ''}`, {
      code: code || null,
      retryable: code === 'FABRIC_NETWORK_ERROR',
    })
  }

  /**
   * 建临时工作目录。
   * @returns 新建的目录路径；建不出来时返回空串（**绝不回落成 tmpDir 本身**——那会让
   *          finally 里的清理把整个系统临时目录删掉）。
   */
  function makeScratch() {
    try {
      return mkdtempSync(join(tmpDir, 'dsh-popo-watcher-'))
    } catch {
      return ''
    }
  }

  /** 删目录（只删我们自己 mkdtemp 出来的目录；失败忽略）。 */
  function dropScratch(dir) {
    if (typeof dir !== 'string' || dir === '') return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结果
    }
  }

  /**
   * 跑一次 CLI：收集 stdout / stderr，拿退出码，超时杀进程树。
   * @param argv - 完整 argv（argv[0] 为 node）。
   * @param cwd - 工作目录。
   * @returns `{ ok, stdout?, stderr?, exitCode?, diagnostic?, kind?, error? }`。
   */
  async function run(argv, cwd) {
    if (typeof spawn !== 'function') return fail('cli-missing', '宿主未提供 subprocess 服务')
    const info = resolveInfo()
    if (info?.ok !== true) return fail('cli-missing', info?.error ?? '找不到 popo-cli')

    let handle
    try {
      handle = spawn({
        argv: [info.nodePath, info.cliJs, ...argv],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STDOUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: GRACE_MS,
      })
    } catch (error) {
      return fail('spawn', error instanceof Error ? error.message : String(error))
    }
    if (handle === null || typeof handle !== 'object' || handle.done === undefined) {
      return fail('spawn', '子进程句柄不可用')
    }

    let timer
    let outcome = null
    const timedOut = await Promise.race([
      Promise.resolve(handle.done).then(
        (value) => {
          outcome = value ?? null
          return false
        },
        (error) => {
          logger?.(`popo-cli 退出异常：${error instanceof Error ? error.message : String(error)}`)
          return false
        },
      ),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(true), timeoutMs)
      }),
    ]).catch(() => false)
    clearTimeout(timer)

    // stdout 与 stderr 都是偏移式读取：失败时 stderr + 退出码是唯一能看出"认证过期/网络断"的线索。
    const collect = (stream) => {
      try {
        const read = handle.collected?.[stream]?.readFrom?.(0)
        return typeof read?.text === 'string' ? read.text : ''
      } catch (error) {
        logger?.(`读取 ${stream} 失败：${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    }
    const text = collect('stdout')
    const stderrText = collect('stderr')
    const diagnostic = `exit=${outcome?.exitCode ?? '?'}${stderrText.trim() === '' ? '' : ` stderr=${stderrText.trim().slice(0, 200)}`}`

    if (timedOut === true) {
      try {
        handle.terminate?.()
      } catch {
        // 终止失败也要返回失败结果
      }
      return fail('timeout', `popo-cli 超过 ${timeoutMs}ms 未返回，已终止（${diagnostic}）`)
    }
    if (text.trim() === '') return fail('empty', `popo-cli 没有输出（${diagnostic}）`)
    return { ok: true, stdout: text, stderr: stderrText, exitCode: outcome?.exitCode ?? null, diagnostic }
  }

  /**
   * 解析 stdout 为 JSON，**容忍 CLI 的噪声前缀/后缀**。
   *
   * 为什么要容忍：实测 popo-cli 会把形如 `> [!WARNING] ...` 的提示直接打到 **stdout**
   * （不是 stderr），JSON 被夹在中间；只 `JSON.parse(stdout)` 会整轮采集判成 `parse` 失败。
   * 策略：先整串解析；不行就逐行倒着找；再不行从第一个 `{`/`[` 起做括号配对截取。
   *
   * @param text - CLI 的 stdout。
   * @param diagnostic - 失败时要带上的诊断串（退出码/stderr）。
   * @returns `{ ok:true, value, noise? }` 或 `{ ok:false, kind:'parse', error }`。
   */
  function parseJson(text, diagnostic = '') {
    const raw = typeof text === 'string' ? text : ''
    const trimmed = raw.trim()
    if (trimmed === '') return fail('parse', `popo-cli 没有输出${diagnostic === '' ? '' : `（${diagnostic}）`}`)

    const direct = tryParse(trimmed)
    if (direct.ok === true) return { ok: true, value: direct.value }

    // 逐行倒着找：噪声通常在前面，真 JSON 在最后一行。
    const lines = raw.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim()
      if (line === '' || (!line.startsWith('{') && !line.startsWith('['))) continue
      const parsed = tryParse(line)
      if (parsed.ok === true) return { ok: true, value: parsed.value, noise: noiseOf(raw, line) }
    }

    // 兜底：从第一个括号起做配对扫描（JSON 跨多行、前后都有噪声时走这条路）。
    for (const marker of ['{', '[']) {
      const start = raw.indexOf(marker)
      if (start === -1) continue
      const slice = balancedSlice(raw, start)
      if (slice === null) continue
      const parsed = tryParse(slice)
      if (parsed.ok === true) return { ok: true, value: parsed.value, noise: noiseOf(raw, slice) }
    }

    // 旧版 CLI 的升级门禁只打印提示并 exit(0)，没有执行请求；不能算成功或普通 JSON 损坏。
    // 必须放在所有有效 JSON 解析之后：警告夹带有效回应时仍按回应处理。
    if (raw.includes('POPO CLI') && raw.includes('有新版本') && raw.includes('popo-cli update')) {
      return fail('upstream', 'POPO CLI 要求升级，当前命令未执行。请在终端运行 popo-cli update，升级后重新检查。')
    }

    const detail = direct.ok === false ? direct.error : '解析失败'
    return fail(
      'parse',
      `popo-cli 输出不是 JSON：${detail}${diagnostic === '' ? '' : `（${diagnostic}）`}｜输出开头：${raw.trim().slice(0, 120)}`,
    )
  }

  /** 试解析一段文本（never-throw）。 */
  function tryParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 噪声描述（去掉 JSON 本身之后剩下的部分，截断）。 */
  function noiseOf(raw, jsonText) {
    const before = raw.slice(0, raw.indexOf(jsonText)).trim()
    const after = raw.slice(raw.indexOf(jsonText) + jsonText.length).trim()
    const parts = []
    if (before !== '') parts.push(`前：${before.slice(0, 200)}`)
    if (after !== '') parts.push(`后：${after.slice(0, 200)}`)
    return parts.join('；')
  }

  /** 从 `start` 处的括号开始做配对扫描，返回完整的一段（找不到闭合返回 null）。 */
  function balancedSlice(text, start) {
    const open = text[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === open) depth += 1
      else if (char === close) {
        depth -= 1
        if (depth === 0) return text.slice(start, index + 1)
      }
    }
    return null
  }

  /**
   * 从发送回应里找消息 ID：把**已知的几种可能位置**都试一遍。
   *
   * 为什么这么宽：发送成功的真实形状没有样本（我们的调试能力只到"本地校验失败"那一层，
   * CLI 没有 dry-run），而"认不出 id 就报发送失败"的代价是**重发**——比丢一个 id 危险得多。
   * 所以策略是：能读出 id 就报 id；读不出但信封像成功 → 报成功 + `unrecognized` 标记。
   * @param json - 已解析的回应体。
   * @returns id，或空串。
   */
  function findMessageId(json) {
    const payload = payloadOf(json)
    const candidates = [
      payload?.data?.msgId, payload?.data?.msg_id, payload?.msgId, payload?.msg_id, payload?.messageId,
      json?.data?.msgId, json?.data?.msg_id, json?.msgId, json?.msg_id, json?.messageId,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return ''
  }

  return {
    describe,

    /** 检查 CLI 启动与登录状态；不采集消息、不改窗口、不自动登录。 */
    async checkAuth() {
      try {
        const result = await run(['auth', 'status'], tmpDir)
        if (result.ok !== true) return result
        const parsed = parseJson(result.stdout, result.diagnostic)
        if (parsed.ok !== true) {
          // auth status 的原始正文可能含凭证元数据，只返回明确的诊断，不回显正文。
          return parsed.kind === 'parse' ? fail('parse', 'POPO CLI 未返回有效的登录状态，请检查 CLI 版本或网络后重试。') : parsed
        }
        const json = parsed.value
        if (json?.ok === false) return upstreamFailure(json, result.diagnostic)
        const status = json?.data?.status
        if (['no_credentials', 'expired', 'idle_locked', 'pending_browser'].includes(status)) return loginRequired(status)
        if (result.exitCode !== 0) return fail('upstream', `POPO CLI 登录检查未正常退出（${result.diagnostic}）`)
        const uid = typeof json?.data?.uid === 'string' ? json.data.uid : ''
        if (json?.ok !== true || !(status === 'ok' || (status == null && uid !== ''))) {
          return fail('parse', 'POPO CLI 返回了无法确认的登录状态，请检查 CLI 版本后重试。')
        }
        return { ok: true, value: { uid } }
      } catch (error) {
        return fail('spawn', error instanceof Error ? error.message : String(error))
      }
    },

    /**
     * 搜索群消息。
     * @param params - `{ group, pageSize?, sessionFile? }`。
     * @returns `{ ok:true, value:{ uid, messages } }` 或失败结果。
     */
    async search(params = {}) {
      let scratch = ''
      try {
        const group = String(params.group ?? '')
        if (group === '') return fail('upstream', '缺少群 ID')
        const pageSize = Number.isFinite(params.pageSize) ? Number(params.pageSize) : 15
        scratch = makeScratch()
        if (scratch === '') return fail('spawn', '无法创建 POPO 临时目录')
        const sessionFile = typeof params.sessionFile === 'string' && params.sessionFile !== ''
          ? params.sessionFile
          : join(scratch, 'session.json')
        try {
          writeFileSync(sessionFile, JSON.stringify([group]), 'utf8')
        } catch (error) {
          return fail('spawn', `无法写 session 文件：${error instanceof Error ? error.message : String(error)}`)
        }

        const runResult = await run([
          'popo', 'message_search',
          'query=', 'type=1', 'page=0', `pageSize=${pageSize}`, 'msgType=0',
          `sessionList=@file:${sessionFile}`,
        ], scratch)
        if (runResult.ok !== true) return runResult

        const parsed = parseJson(runResult.stdout, runResult.diagnostic)
        if (parsed.ok !== true) return parsed
        const json = parsed.value
        if (json?.ok === false) return upstreamFailure(json, runResult.diagnostic)

        const payload = payloadOf(json)
        if (payload === undefined) return fail('parse', '回应里找不到 data.data.data.data')
        if (!Array.isArray(payload.result_list)) return fail('parse', 'POPO 回应里缺少有效的 result_list 消息列表')
        const list = payload.result_list
        const fallbackMs = now()
        return {
          ok: true,
          value: {
            uid: typeof payload.uid === 'string' ? payload.uid : '',
            messages: list.map((row) => toMessage(row, fallbackMs)),
            // CLI 的噪声（例如 `> [!WARNING]` 提示）不丢：页面/日志里能看出"输出不干净"。
            ...(typeof parsed.noise === 'string' && parsed.noise !== '' ? { noise: parsed.noise } : {}),
          },
        }
      } catch (error) {
        return fail('spawn', error instanceof Error ? error.message : String(error))
      } finally {
        if (scratch !== '') dropScratch(scratch)
      }
    },

    /**
     * 发送群消息（中文经 UTF-8 文件传参）。
     * @param params - `{ group, text }`。
     * @returns `{ ok:true, value:{ msgId } }` 或失败结果。
     */
    async send(params = {}) {
      let scratch = ''
      try {
        const group = String(params.group ?? '')
        const text = typeof params.text === 'string' ? params.text : ''
        if (group === '') return fail('upstream', '缺少群 ID')
        if (text.trim() === '') return fail('upstream', '消息为空')

        scratch = makeScratch()
        if (scratch === '') return fail('spawn', '无法创建 POPO 临时目录')
        const messageFile = join(scratch, 'message.txt')
        try {
          writeFileSync(messageFile, text, 'utf8')
        } catch (error) {
          return fail('spawn', `无法写消息文件：${error instanceof Error ? error.message : String(error)}`)
        }

        const runResult = await run([
          'popo', 'message_send_team',
          `message=@text:${messageFile}`,
          `receiver=${group}`,
          'source=AGENT',
        ], scratch)
        if (runResult.ok !== true) return runResult

        // 先看 JSON：`ok:false` 是权威失败信号（失败响应里回显 msgId 时不能再报成功）。
        // 成功形状见 docs/interfaces.md §4：没样本 → 宁可报"已发送但 id 未知"，也不报失败（重发比丢 id 危险）。
        const parsed = parseJson(runResult.stdout, runResult.diagnostic)
        if (parsed.ok === true) {
          const json = parsed.value
          if (json?.ok === false) {
            return upstreamFailure(json, runResult.diagnostic)
          }
          const msgId = findMessageId(json)
          if (msgId !== '') return { ok: true, value: { msgId } }
          // 结构上像成功（有 data 信封或 ok:true）却读不到 id：报成功 + 标记形状没认出来。
          if (payloadOf(json) !== undefined || json?.ok === true) {
            return { ok: true, value: { msgId: '', unrecognized: true } }
          }
        }
        // JSON 解析不了（例如中文导致的结构损坏）时，退回 ASCII 的 id 正则：它是可靠的成功信号。
        const matched = /"(?:msgId|msg_id|messageId)"\s*:\s*"([0-9A-Za-z_-]+)"/.exec(runResult.stdout)
        if (matched !== null) return { ok: true, value: { msgId: matched[1], unrecognized: true } }
        if (parsed.ok !== true) return parsed
        return fail('upstream', `发送未确认：${String(parsed.value?.code ?? runResult.stdout.slice(0, 200))}（${runResult.diagnostic}）`)
      } catch (error) {
        return fail('spawn', error instanceof Error ? error.message : String(error))
      } finally {
        if (scratch !== '') dropScratch(scratch)
      }
    },

    /** 供诊断：当前毫秒时间（保持注入点被使用，便于测试替换）。 */
    nowMs() {
      try {
        return now()
      } catch {
        return Date.now()
      }
    },
  }
}
