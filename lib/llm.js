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

import { withDeadline } from './deadline.js'

/** 模型说"这轮不开口"时约定的输出（大小写不敏感，允许前后引号/句号）。 */
export const SKIP_MARKER = 'SKIP'

/** 收集文本的硬上限：模型跑飞时到此为止，绝不无限增长。 */
const MAX_TEXT_CHARS = 2000

/** 生成与状态展示共用同一套路由规则；配置缺一项就整组跟随宿主。 */
export function resolveDraftRoute(config, defaultSelection) {
  const text = value => typeof value === 'string' ? value.trim() : ''
  const provider = text(config?.llm?.provider)
  const model = text(config?.llm?.model)
  return provider && model
    ? { provider, model, source: 'plugin' }
    : { provider: text(defaultSelection?.provider), model: text(defaultSelection?.model), source: 'host' }
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
 * @param options.timeoutMs - 单次超时（默认 20000；最小 1000）。
 * @returns `{ available, write }`，两者都 never-throw。
 */
export function createDraftWriter(options = {}) {
  const {
    getLlm,
    getRoute,
    logger,
    now = () => Date.now(),
    timeoutMs = 20000,
  } = options

  const waitMs = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : 20000

  /** 取一次宿主 llm 服务（never-throw）。 */
  function llmService() {
    try {
      const value = typeof getLlm === 'function' ? getLlm() : getLlm
      return value !== null && typeof value === 'object' && typeof value.stream === 'function' ? value : null
    } catch (error) {
      logger?.(`llm: 取服务失败 ${error instanceof Error ? error.message : String(error)}`)
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
   * @param params - `{ system, prompt, maxTokens? }`。
   * @returns Promise<`{ok:true, text, model, ms, truncated}` | `{ok:false, error}`>，永不 reject。
   */
  async function write(params = {}) {
    const started = safeNow()
    try {
      const llm = llmService()
      if (llm === null) return { ok: false, error: '宿主 llm 服务不可用' }
      const { provider, model } = route()
      if (provider === '' || model === '') return { ok: false, error: '没有可用的模型档' }

      const system = typeof params.system === 'string' ? params.system : ''
      const prompt = typeof params.prompt === 'string' ? params.prompt : ''
      if (prompt.trim() === '') return { ok: false, error: 'prompt 为空' }
      const maxTokens = Number.isFinite(Number(params.maxTokens)) ? Math.max(16, Number(params.maxTokens)) : 200
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

      await withDeadline(async signal => {
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
          maxTokens,
          ...(callTemperature === undefined ? {} : { temperature: callTemperature }),
          signal,
        })) {
          if (signal.aborted) throw signal.reason
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
            finished = kind === 'stop'
            if (!finished) {
              const detail = chunk.reason?.failure?.message ?? chunk.reason?.failure?.code ?? String(kind)
              failure = `模型中断（${String(kind)}）：${detail}`
            }
            break
          }
        }
      }, waitMs, '模型')

      const cleaned = cleanDraft(text)
      if (failure !== null) return { ok: false, error: failure, raw: cleaned }
      if (truncated) return { ok: false, error: `模型输出超过 ${MAX_TEXT_CHARS} 字，已拒绝截断草稿`, truncated: true }
      if (!finished) return { ok: false, error: '模型流未正常结束（缺少 finish/stop）' }
      if (cleaned === '') {
        return { ok: false, error: '模型没有输出文本' }
      }
      return {
        ok: true,
        text: cleaned.slice(0, MAX_TEXT_CHARS),
        model,
        ms: Math.max(0, safeNow() - started),
        truncated,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.(`llm: 写文案失败 ${message}`)
      return { ok: false, error: message }
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
