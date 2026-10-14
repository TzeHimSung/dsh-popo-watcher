/**
 * 文案层（llm）：把「这一轮该说什么」交给宿主的 LLM 服务写成一句话。
 *
 * 为什么需要它：skill 版本里写文案的是 agent（模型自己），插件版本跑在宿主进程里、没有 agent，
 * 所以这一步必须借宿主的 `llm` 服务（`ctx.get('llm')`）。路由（provider/model）优先用配置里的
 * `llm.provider/model`，留空则回落到宿主的默认档（`agentDefaultModel.currentSelection()`）。
 *
 * 纪律（docs/interfaces.md §0）：
 * - **零 bare import**：只碰注入进来的服务对象，不 import 任何东西（symlink 安装下 import 不到宿主闭包）；
 * - `write()` 绝不抛错、绝不 reject：失败回落 `{ok:false, error}`，由 watcher 决定"安静不发"；
 * - 不打日志到 console（宿主终端的日志由插件装配层负责），只调用注入的 `logger`；
 * - 只读 chunk 流里的 `text-delta` 文本；`finish` 不是 `stop` 就当失败，别把半句话发出去。
 *
 * @module dsh-popo-watcher/llm
 */

import { isAborted, withAbort, withDeadline } from './deadline.js'

/** 模型说"这轮不开口"时约定的输出（大小写不敏感，允许前后引号/句号）。 */
export const SKIP_MARKER = 'SKIP'

/** 收集文本的硬上限：模型跑飞时到此为止，绝不无限增长。 */
const MAX_TEXT_CHARS = 2000

const RETRYABLE_FAILURES = new Set(['TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE', 'STREAM_CLOSED'])
const FATAL_FAILURES = new Set(['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'INVALID_REQUEST', 'MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE', 'QUOTA_EXCEEDED', 'CONTEXT_WINDOW_EXCEEDED'])
const FAILURE_TEXT = {
  TRANSPORT: '模型连接中断', TIMEOUT: '模型连接或读取超时', RATE_LIMIT: '模型服务暂时限流', SERVER: '模型服务暂时不可用',
  EMPTY_RESPONSE: '模型没有输出文本', STREAM_CLOSED: '模型流未正常结束（缺少 finish/stop）',
  AUTH: '模型服务认证或权限失败', MISSING_CREDENTIAL: '模型凭证未配置', INVALID_CREDENTIAL: '模型凭证无效',
  INVALID_REQUEST: '模型请求配置无效', MODEL_NOT_FOUND: '模型或提供方不存在', MODEL_UNAVAILABLE: '宿主模型服务或模型档不可用',
  QUOTA_EXCEEDED: '模型服务额度耗尽', CONTEXT_WINDOW_EXCEEDED: '模型上下文超过上限',
  MAX_TOKENS: '模型输出达到宿主上限，已拒绝截断草稿', OUTPUT_LIMIT: '模型输出超过 2000 字，已拒绝截断草稿',
  ABORTED: '模型生成已取消', UNKNOWN: '模型请求失败，错误类型未识别',
}

export function isFatalGenerationError(code) {
  return FATAL_FAILURES.has(code)
}

/** Keep host error codes and retry hints, never provider response bodies or credentials. */
function generationFailure(value) {
  let code = 'UNKNOWN', status = null, retryAfterMs = null, message = ''
  try {
    let cause = value
    for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
      const detail = cause.failure ?? cause
      const candidate = String(detail.code ?? cause.code ?? '').toUpperCase()
      const normalized = ['QUOTA', 'ACCOUNT_QUOTA'].includes(candidate) ? 'QUOTA_EXCEEDED'
        : /^(?:ECONN\w*|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET)$/.test(candidate) ? 'TRANSPORT'
        : /^(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(candidate) ? 'TIMEOUT'
        : /^(?:UNKNOWN_MODEL|UNKNOWN_PROVIDER|PROVIDER_NOT_FOUND|NO_ADAPTER)$/.test(candidate) ? 'MODEL_NOT_FOUND'
        : /^(?:INVALID_CONFIG|INVALID_MODEL_\w+|UNSUPPORTED_(?:OPTION|REASONING_EFFORT|CONTENT))$/.test(candidate) ? 'INVALID_REQUEST' : candidate
      if (code === 'UNKNOWN' && Object.hasOwn(FAILURE_TEXT, normalized)) code = normalized
      if (status === null && Number.isInteger(detail.status)) status = detail.status
      const delay = detail.providerRetryAfterMs ?? detail.retryAfterMs
      if (retryAfterMs === null && typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) retryAfterMs = delay
      if (!message && typeof detail.message === 'string') message = detail.message
    }
    if (status === 401 || status === 403) code = 'AUTH'
    else if (code === 'UNKNOWN') {
      if (status === 402 || /\b(?:insufficient_quota|quota exceeded|quota_exceeded)\b/i.test(message)) code = 'QUOTA_EXCEEDED'
      else if (status === 429) code = 'RATE_LIMIT'
      else if (status >= 500 && status <= 599) code = 'SERVER'
      else if (status >= 400 && status <= 499) code = 'INVALID_REQUEST'
      else if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) code = 'TIMEOUT'
      else if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|premature close/i.test(message)) code = 'TRANSPORT'
    }
  } catch { /* Malformed foreign errors remain classified as unknown. */ }
  return { ok: false, error: `${FAILURE_TEXT[code]}（${code}）`, errorCode: code,
    retryable: RETRYABLE_FAILURES.has(code), retryAfterMs }
}

/** 生成与状态展示共用同一套路由规则；配置缺一项就整组跟随宿主。 */
export function resolveDraftRoute(config, defaultSelection) {
  const text = value => typeof value === 'string' ? value.trim() : ''
  const provider = text(config?.llm?.provider)
  const model = text(config?.llm?.model)
  return provider && model
    ? { provider, model, source: 'plugin' }
    : { provider: text(defaultSelection?.provider), model: text(defaultSelection?.model), source: 'host' }
}

/** Only return classified diagnostics: host errors may contain credentials or response bodies. */
function connectionFailure(error) {
  let cause = error
  for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
    if (cause.code === 'ECONNREFUSED') return '连接被拒绝（ECONNREFUSED）'
    if (cause.code === 'ENOTFOUND' || cause.code === 'EAI_AGAIN') return '无法解析接口地址'
    if (cause.code === 'ECONNRESET') return '连接被重置（ECONNRESET）'
    if (cause.code === 'ETIMEDOUT' || cause.code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
    if (cause.code === 'MISSING_CREDENTIAL' || cause.code === 'INVALID_CREDENTIAL') return '宿主凭证不可用，请检查 CodeMaker 凭证设置'
  }
  const message = typeof error?.message === 'string' ? error.message : ''
  if (message.startsWith('CodeMaker 接口检查超时')) return '检查超时（5 秒）'
  const status = /answered ([1-5]\d{2})\b/.exec(message)?.[1]
  if (status) return `HTTP ${status}${status === '401' || status === '403' ? '，请检查 CodeMaker 凭证设置' : ''}`
  if (message.includes('did not answer with JSON')) return '响应不是合法 JSON'
  if (message.includes('model listing')) return '模型列表响应格式错误'
  if (error?.code === 'NO_DISCOVERY' || error?.code === 'DISCOVERY_UNSUPPORTED') return '宿主不支持此接口的模型列表检查'
  return '模型列表请求失败，请检查接口连接和宿主配置'
}

/**
 * Probe the effective CodeMaker endpoint before monitoring. Discovery performs a real GET
 * using the host's live profile and credentials; listModels only reads the local catalog.
 * No generation, configuration writes, retries, or cached success. Never throws.
 */
export async function checkCodeMakerConnection({ getRoute, getLlm, getSettings } = {}) {
  let endpoint = ''
  const fail = reason => ({ ok: false, error: `CodeMaker 接口检查失败${endpoint ? `（${endpoint}）` : ''}：${reason}` })
  try {
    return await withDeadline(async signal => {
      if (getRoute?.()?.provider !== 'codemaker') return { ok: true }
      const llm = getLlm?.()
      const settings = getSettings?.()
      if (typeof llm?.listConfigurableProviders !== 'function' || typeof llm?.discoverModels !== 'function'
        || typeof settings?.describe !== 'function') return fail('宿主未提供接口检查能力')

      const providers = await llm.listConfigurableProviders()
      const provider = Array.isArray(providers) ? providers.find(entry => entry?.provider === 'codemaker') : null
      if (!provider || typeof provider.settingsNs !== 'string' || !provider.settingsNs
        || !Array.isArray(provider.settingsPath) || provider.settingsPath.some(key => typeof key !== 'string')) {
        return fail('无法读取 CodeMaker 提供方配置')
      }
      const views = await settings.describe({ redactSecrets: true })
      const view = Array.isArray(views) ? views.find(entry => entry?.ns === provider.settingsNs) : null
      const profile = provider.settingsPath.reduce((value, key) => value?.[key], view?.value)
      if (typeof profile?.baseURL !== 'string' || !profile.baseURL.trim()) return fail('未配置 CodeMaker 接口地址')
      let url
      try { url = new URL(profile.baseURL.trim()) } catch { return fail('CodeMaker 接口地址无效') }
      if (!['http:', 'https:'].includes(url.protocol)) return fail('CodeMaker 接口地址必须使用 HTTP 或 HTTPS')
      // Diagnostic URLs must never expose URL credentials or query parameters.
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      endpoint = url.href.replace(/\/+$/, '')
      if (profile.api !== undefined && (typeof profile.api !== 'string' || !profile.api.trim())) return fail('CodeMaker 接口协议无效')
      if (signal.aborted) throw signal.reason
      const models = await llm.discoverModels(provider.settingsNs, {
        provider: 'codemaker',
        baseURL: profile.baseURL.trim(),
        ...(profile.api === undefined ? {} : { api: profile.api }),
      }, signal)
      if (!Array.isArray(models) || models.some(model => typeof model?.id !== 'string' || !model.id.trim())) {
        return fail('模型列表响应格式错误')
      }
      return { ok: true }
    }, 5000, 'CodeMaker 接口检查')
  } catch (error) {
    return fail(connectionFailure(error))
  }
}

/** 宿主目录查询没有 signal 参数，限时等待，迟到结果不进入本次目录。 */
async function readCatalog(operation, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('模型目录读取超时')), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 只读宿主已注册的模型目录；提供方失败互不影响，不返回连接信息或凭证。 */
export async function listDraftModels({ getLlm, getDefaultSelection, timeoutMs = 8000 } = {}) {
  let defaultSelection = null
  try {
    const route = resolveDraftRoute(null, getDefaultSelection?.())
    if (route.provider && route.model) defaultSelection = { provider: route.provider, model: route.model }
  } catch { /* 宿主未提供默认模型时仍可列出其他模型。 */ }
  try {
    const llm = getLlm?.()
    if (typeof llm?.listProviders !== 'function' || typeof llm?.listModels !== 'function') {
      return { ok: false, providers: [], defaultSelection, error: '宿主模型目录服务不可用' }
    }
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000
    const providers = await readCatalog(() => llm.listProviders(), waitMs)
    if (!Array.isArray(providers) || providers.some(item => !item || typeof item.id !== 'string' || !item.id.trim()
      || typeof item.name !== 'string' || !item.name.trim())) throw new Error('宿主提供方列表格式不正确')
    const results = await Promise.allSettled(providers.map(async provider => {
      const models = await readCatalog(() => llm.listModels(provider.id), waitMs)
      if (!Array.isArray(models) || models.some(item => !item || item.provider !== provider.id
        || typeof item.id !== 'string' || !item.id.trim() || typeof item.name !== 'string' || !item.name.trim())) {
        throw new Error('宿主模型列表格式不正确')
      }
      return models.map(({ id, name }) => ({ id, name }))
    }))
    return {
      ok: true,
      defaultSelection,
      providers: providers.map(({ id, name }, index) => results[index].status === 'fulfilled'
        ? { id, name, models: results[index].value }
        : { id, name, models: [], error: String(results[index].reason?.message ?? '模型目录读取失败') }),
    }
  } catch (error) {
    return { ok: false, providers: [], defaultSelection, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 判断模型输出是否等于"不开口"标记（对齐 system prompt 里的约定）。
 * @param text - 模型输出。
 * @returns 布尔；非字符串一律 false。
 */
export function isSkipLine(text) {
  if (typeof text !== 'string') return false
  // 先剥掉整行外壳的引号，再认「skip」本体（模型爱回 '「SKIP。」' 这种）。
  return /^skip[.!。！]?$/i.test(stripQuotes(text.trim()))
}

/**
 * 清洗模型输出：去掉包裹引号、Markdown 代码块、多余空行，只留第一行。
 * @param text - 原始文本。
 * @returns 单行文本（无内容时为空串）。
 */
export function cleanDraft(text) {
  if (typeof text !== 'string') return ''
  let value = text.replace(/\r\n?/g, '\n').trim()
  // ```text ... ``` 这类围栏：只取里面的内容
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(value)
  if (fenced !== null) value = fenced[1].trim()
  const firstLine = value.split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? ''
  return stripQuotes(firstLine)
}

/** 去掉整行被引号包住的外壳（只剥一层，不动中间的内容）。 */
function stripQuotes(line) {
  const pairs = [['"', '"'], ["'", "'"], ['「', '」'], ['『', '』'], ['“', '”']]
  for (const [open, close] of pairs) {
    if (line.length >= 2 && line.startsWith(open) && line.endsWith(close)) return line.slice(1, -1).trim()
  }
  return line
}

/**
 * 创建文案写入器。
 * @param options - 注入点。
 * @param options.getLlm - `() => LlmService | undefined`：惰性取宿主 llm 服务（服务可能后到）。
 * @param options.getRoute - `() => { provider, model }`：当前档位（空串表示"用宿主默认档"）。
 * @param options.logger - 日志回调 `(message) => void`。
 * @param options.now - 取当前毫秒时间。
 * @returns `{ available, write }`，两者都 never-throw。
 */
export function createDraftWriter(options = {}) {
  const {
    getLlm,
    getRoute,
    logger,
    now = () => Date.now(),
  } = options

  /** 取一次宿主 llm 服务（never-throw）。 */
  function llmService() {
    try {
      const value = typeof getLlm === 'function' ? getLlm() : getLlm
      return value !== null && typeof value === 'object' && typeof value.stream === 'function' ? value : null
    } catch (error) {
      logger?.('llm: 取宿主模型服务失败')
      return null
    }
  }

  /** 取一次档位（never-throw；空串表示没配）。 */
  function route() {
    try {
      const value = typeof getRoute === 'function' ? getRoute() : getRoute
      if (value === null || typeof value !== 'object') return { provider: '', model: '' }
      return {
        provider: typeof value.provider === 'string' ? value.provider.trim() : '',
        model: typeof value.model === 'string' ? value.model.trim() : '',
      }
    } catch {
      return { provider: '', model: '' }
    }
  }

  /** 能不能写文案（先问再跑，避免白跑一轮）。 */
  function available() {
    try {
      if (llmService() === null) return { ok: false, error: '宿主 llm 服务不可用' }
      const { provider, model } = route()
      if (provider === '' || model === '') return { ok: false, error: '没有可用的模型档（配置里 llm.provider/model 为空，宿主也没给默认档）' }
      return { ok: true, provider, model }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 写一条文案。
   * @param params - `{ system, prompt, temperature?, signal? }`；预算与断流检测由宿主管理。
   * @returns Promise<`{ok:true, text, model, ms, truncated}` | `{ok:false, error}`>，永不 reject。
   */
  async function write(params = {}) {
    const started = safeNow()
    let signal
    let model = ''
    try {
      signal = params?.signal
      if (signal?.aborted) throw signal.reason ?? new Error('模型生成已取消')
      const llm = llmService()
      if (llm === null) return generationFailure({ code: 'MODEL_UNAVAILABLE' })
      const selected = route()
      const provider = selected.provider
      model = selected.model
      if (provider === '' || model === '') return generationFailure({ code: 'MODEL_UNAVAILABLE' })

      const system = typeof params.system === 'string' ? params.system : ''
      const prompt = typeof params.prompt === 'string' ? params.prompt : ''
      if (prompt.trim() === '') return generationFailure({ code: 'INVALID_REQUEST' })
      // 温度：配置里有就传给宿主（`llm.stream` 支持并会进调用配置比对），非法值直接不发。
      // 注意 `Number('')` 与 `Number(null)` 都是 0 —— 那种"看起来没填"的值必须当没给，而不是当 0 度。
      const rawTemperature = params.temperature
      const temperature = rawTemperature === null || rawTemperature === undefined
        || (typeof rawTemperature === 'string' && rawTemperature.trim() === '')
        ? Number.NaN
        : Number(rawTemperature)
      const callTemperature = Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? temperature : undefined

      let text = ''
      let truncated = false
      let failure = null
      let finished = false
      let finishReason = null

      await withAbort(async () => {
        // 消息形状照抄 @deepseek-ai/dsh-llm 的 createUserMessage（插件不能 import 它）：
        // role + content 块数组 + source 标记，id 用一个本地唯一串即可。
        const messages = [{
          id: `dsh-popo-watcher-${started}-${Math.random().toString(36).slice(2, 10)}`,
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-popo-watcher' },
        }]

        for await (const chunk of llm.stream({
          provider,
          model,
          messages,
          system,
          ...(callTemperature === undefined ? {} : { temperature: callTemperature }),
          signal,
        })) {
          if (signal?.aborted) throw signal.reason ?? new Error('模型生成已取消')
          if (chunk === null || typeof chunk !== 'object') continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text
            if (text.length > MAX_TEXT_CHARS) {
              truncated = true
              break
            }
            continue
          }
          if (chunk.type === 'finish') {
            const kind = chunk.reason?.kind ?? chunk.reason
            finishReason = typeof kind === 'string' ? kind : null
            finished = kind === 'stop'
            if (!finished) {
              failure = generationFailure(kind === 'max-tokens' ? { code: 'MAX_TOKENS' }
                : kind === 'aborted' ? { code: 'ABORTED' } : chunk.reason?.failure)
            }
            break
          }
        }
      }, signal)

      const cleaned = cleanDraft(text)
      if (failure !== null) return { ...failure, error: `模型中断：${failure.error}`, raw: cleaned, model, finishReason }
      if (truncated) return { ...generationFailure({ code: 'OUTPUT_LIMIT' }), truncated: true, model, finishReason }
      if (!finished) return { ...generationFailure({ code: 'STREAM_CLOSED' }), model, finishReason }
      if (cleaned === '') {
        return { ...generationFailure({ code: 'EMPTY_RESPONSE' }), model, finishReason }
      }
      return {
        ok: true,
        text: cleaned.slice(0, MAX_TEXT_CHARS),
        model,
        finishReason,
        ms: Math.max(0, safeNow() - started),
        truncated,
      }
    } catch (error) {
      if (isAborted(signal)) return { ...generationFailure({ code: 'ABORTED' }), cancelled: true, model }
      const failure = generationFailure(error)
      logger?.(`llm: 写文案失败 ${failure.error}`)
      return { ...failure, model }
    }
  }

  /** 当前时间（注入值抛错时回落 `Date.now`）。 */
  function safeNow() {
    try {
      const value = now()
      const ms = value instanceof Date ? value.getTime() : Number(value)
      return Number.isFinite(ms) ? ms : Date.now()
    } catch {
      return Date.now()
    }
  }

  return { available, write }
}
