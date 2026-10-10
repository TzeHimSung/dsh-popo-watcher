/** TypeSafe HTTP 调用；策略与输入构造由调用方提供。 */
import { withDeadline } from './deadline.js'
import { prop, formatAnswers } from './judge-policy.js'
const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone'
/**
 * 创建判读调用器（只做 HTTP，不写盘、不打 console）。
 * @param options - 注入点。
 * @param options.fetchImpl - fetch 实现（默认 `globalThis.fetch`）。
 * @param options.getKey - `() => string | Promise<string>`，取 API key（可以是异步的服务调用）。
 * @param options.timeoutMs - 单次超时（默认 8000）。
 * @param options.model - 模型名（默认 `jev-latest`）。
 * @param options.logger - 失败时的日志回调（可选）。
 * @param options.now - 取当前毫秒时间（默认 `Date.now`）。
 * @returns `{ available, listModels, runRound, runDraft }`，全部 never-throw。
 */
export function createJudge(options = {}) {
  const {
    fetchImpl,
    getKey,
    timeoutMs = 8000,
    model = 'jev-latest',
    logger,
    now = () => Date.now(),
  } = options
  const fetchFn = fetchImpl ?? globalThis.fetch

  /** 取 key（异步容忍；失败返回空串）。 */
  async function apiKey() {
    try {
      const value = await getKey?.()
      return typeof value === 'string' ? value.trim() : ''
    } catch (error) {
      logger?.(`judge: 读取 key 失败 ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /** 判读是否可用（无 key / 无 fetch 时先告诉调用方，避免白跑一轮）。 */
  async function available() {
    try {
      if (typeof fetchFn !== 'function') return { ok: false, error: '环境里没有可用的 fetch' }
      const key = await apiKey()
      if (key === '') return { ok: false, error: '没有 TYPESAFE_API_KEY（可在设置页填入，或设成用户环境变量）' }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 只读取账户可选模型；不做判读、不改变配置，错误不带响应正文或凭证。 */
  async function listModels() {
    let timer
    let key = ''
    const controller = new AbortController()
    const waitMs = Math.max(1000, Number(timeoutMs) || 8000)
    try {
      if (typeof fetchFn !== 'function') return { ok: false, models: [], error: '环境里没有可用的 fetch' }
      key = await apiKey()
      if (!key) return { ok: false, models: [], error: '未配置 TypeSafe 凭证，请先配置后刷新模型列表' }
      timer = setTimeout(() => controller.abort(), waitMs)
      const response = await fetchFn('https://api.typesafe.ai/v1/models', {
        method: 'GET', headers: { authorization: `Bearer ${key}` }, signal: controller.signal,
      })
      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403 ? 'TypeSafe 凭证无效或无权限' : 'TypeSafe 模型列表请求失败'
        return { ok: false, models: [], error: `${reason}（HTTP ${response.status}）` }
      }
      let body
      try { body = JSON.parse(await response.text()) } catch (error) {
        if (controller.signal.aborted) throw error
        return { ok: false, models: [], error: 'TypeSafe 模型列表响应不是 JSON' }
      }
      if (!Array.isArray(body?.models) || body.models.some(item => !item || typeof item.name !== 'string'
        || !item.name.trim() || item.name.length > 64)) {
        return { ok: false, models: [], error: 'TypeSafe 模型列表格式不正确' }
      }
      const models = body.models.map(item => ({
        id: item.name.trim(), name: item.name.trim(),
        description: typeof item.description === 'string' ? item.description : '',
      }))
      return { ok: true, models: [...new Map(models.map(item => [item.id, item])).values()] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, models: [], error: controller.signal.aborted
        ? `TypeSafe 模型列表读取超时（${waitMs}ms）`
        : `TypeSafe 模型列表读取失败：${key ? message.replaceAll(key, '[redacted]') : message}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 发一次判读请求。 */
  async function ask(mode, state, questions, override = {}) {
    try {
      if (typeof fetchFn !== 'function') return { ok: false, error: '环境里没有可用的 fetch' }
      const key = await apiKey()
      if (key === '') return { ok: false, error: '没有 TYPESAFE_API_KEY' }
      if (state === null || typeof state !== 'object') return { ok: false, error: 'state 不是对象' }
      if (questions === null || typeof questions !== 'object') return { ok: false, error: 'question set 不可用' }

      const modelName = typeof override.model === 'string' && override.model !== '' ? override.model : model
      const started = now()
      return await withDeadline(async signal => {
        let response
        try {
          response = await fetchFn(SYSTEMONE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ state, model: modelName, questions }),
            signal,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const cause = error?.cause?.message ? `${message}（${error.cause.message}）` : message
          logger?.(`judge: 请求失败 ${cause}`)
          return { ok: false, error: `请求失败: ${cause}` }
        }

        if (response === null || typeof response !== 'object') return { ok: false, error: '响应不可用' }
        if (response.ok !== true) {
          let detail = ''
          try {
            detail = String(await response.text()).slice(0, 200)
          } catch {
            // 读正文失败不影响判定
          }
          return { ok: false, error: `HTTP ${response.status ?? '?'}${detail === '' ? '' : ` ${detail}`}` }
        }

        let parsed
        try {
          parsed = JSON.parse(await response.text())
        } catch (error) {
          return { ok: false, error: `响应不是 JSON: ${error instanceof Error ? error.message : String(error)}` }
        }
        const answers = prop(parsed, 'answers')
        if (answers === null || typeof answers !== 'object') return { ok: false, error: '响应里没有 answers' }
        const usage = prop(parsed, 'usage')
        return {
          ok: true,
          mode,
          model: String(prop(parsed, 'model') ?? modelName),
          ms: Math.max(0, now() - started),
          tokens: Number(prop(usage, 'input_tokens') ?? 0) || 0,
          answers,
          formatted: formatAnswers(answers),
        }
      }, Math.max(1000, Number(timeoutMs) || 8000), '判读')
    } catch (error) {
      logger?.(`judge: 判读异常 ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    available,
    listModels,
    runRound: (state, questions, override) => ask('round', state, questions, override),
    runDraft: (state, questions, override) => ask('draft', state, questions, override),
  }
}
