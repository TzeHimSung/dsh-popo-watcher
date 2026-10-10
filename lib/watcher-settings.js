/** 配置与凭证管理。写操作由 watcher 的串行队列调用。 */
import { normalizeKey, readStoredKey, resolveKeySource, storedKeyFile, STORED_KEY_FIELD } from './key-source.js'

export function createSettings({ store, config, root, env, keyResolver = resolveKeySource, record, stamp, isLocked, logger }) {
  let current = null
  let configWarnings = []
  let configState = 'default'
  function secretPath() {
    try {
      return storedKeyFile(root())
    } catch (error) {
      record('key.path', error)
      return ''
    }
  }

  async function keySource() {
    const resolve = typeof keyResolver === 'function' ? keyResolver : resolveKeySource
    return await resolve({ name: 'TYPESAFE_API_KEY', env, file: secretPath() })
  }

  function hasStoredKey() {
    try {
      const file = secretPath()
      if (file === '') return false
      const reader = store?.readJson ? (target, fallback) => store.readJson(target, fallback) : undefined
      return readStoredKey(file, reader) !== ''
    } catch (error) {
      record('key.stored', error)
      return false
    }
  }

  function ensureConfig() {
    if (current !== null) return current
    try {
      const base = root()
      if (base === '') {
        // 数据根不可用（例如 store 桩全抛）：直接用默认配置，不做任何路径拼接。
        current = config.defaultConfig()
        configState = 'error'
        configWarnings = ['数据根不可用，使用默认配置']
        return current
      }
      const file = `${base}/config.json`
      const read = store?.readJson ? store.readJson(file, undefined) : { ok: false, value: undefined, error: 'store 不可用' }
      const normalized = config.normalizeConfig(read?.value)
      current = normalized.config
      configWarnings = normalized.warnings ?? []
      configState = read?.ok === true ? (configWarnings.length ? 'unsaved' : 'saved') : read?.code === 'ENOENT' ? 'default' : 'error'
      if (configState === 'error') configWarnings = [...configWarnings, `读取 config.json 失败，已用默认值：${read?.error ?? '未知错误'}`]
    } catch (error) {
      record('config.load', error)
      try {
        current = config.defaultConfig()
      } catch {
        current = {}
      }
      configState = 'error'
      configWarnings = [`读取配置失败，已用默认值：${error instanceof Error ? error.message : String(error)}`]
    }
    return current
  }

  function persistConfig() {
    try {
      const base = root()
      // 数据根不可用时绝不落盘：空串会变成 `/config.json`（盘符根目录）这种危险目标。
      if (base === '') return { ok: false, error: '数据根不可用，跳过写入' }
      const file = `${base}/config.json`
      const result = store?.writeJsonAtomic ? store.writeJsonAtomic(file, current) : { ok: false, error: 'store 不可用' }
      return result
    } catch (error) {
      record('config.persist', error)
      return { ok: false, error: String(error) }
    }
  }
  function getConfig(options = {}) {
    try {
      const reload = options?.reload === true
      if (reload === true && current !== null) {
        if (configState === 'unsaved') return { ok: false, error: '当前配置尚未保存，请先重试保存' }
        if (isLocked(current)) return { ok: false, error: '请先停止监控，再重新读取配置' }
        current = null
      }
      return { ok: true, config: { ...ensureConfig() }, warnings: [...configWarnings], configState }
    } catch (error) {
      record('config.get', error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function updateConfig(patch) {
    const before = ensureConfig()
    if (configState === 'error') return { ok: false, error: '配置读取失败，请修复配置并重新读取后再保存' }
    const result = config.applyPatch(before, patch)
    if ((result.config.group !== before.group || result.config.intervalSec !== before.intervalSec) && isLocked(before)) {
      return { ok: false, error: '请先停止监控，再修改群 ID 或轮询间隔' }
    }
    current = result.config
    configWarnings = result.warnings ?? []
    const written = persistConfig()
    configState = written?.ok === true ? 'saved' : 'unsaved'
    if (configState === 'unsaved') configWarnings.push(`写入 config.json 失败：${written?.error ?? '未知错误'}`)
    return { ok: true, config: { ...current }, warnings: [...configWarnings], configState, written: written?.ok === true }
  }

  async function keyStatus() {
    // `stored`（文件在不在）与 `source`（解析器怎么说）都算数：两者不一致时以"能用"为准，
    // 免得页面显示"未配置"而判读其实读得到 key。
    const stored = hasStoredKey()
    const resolved = await keySource().catch(() => ({ key: '', source: 'none' }))
    const source = resolved?.source !== undefined && resolved.source !== 'none' ? resolved.source : (stored ? 'file' : 'none')
    return { ok: true, configured: source !== 'none', source, stored }
  }

  async function setKey(key) {
    const cleaned = normalizeKey(key)
    if (cleaned === '') return { ok: false, error: 'key 不合法（空串、含换行，或超过 512 字）' }
    const file = secretPath()
    if (file === '') return { ok: false, error: '数据根不可用' }
    const written = store?.writeJsonAtomic
      ? store.writeJsonAtomic(file, { [STORED_KEY_FIELD]: cleaned, savedAt: stamp() })
      : { ok: false, error: 'store 不可用' }
    if (written?.ok !== true) return { ok: false, error: `写入 secret.json 失败：${written?.error ?? '未知'}` }
    logger?.('watcher: 判读 key 已保存到 secret.json')
    return { ok: true, configured: true, source: 'file' }
  }

  async function clearKey() {
    const file = secretPath()
    if (file === '') return { ok: false, error: '数据根不可用' }
    const removed = store?.removeFile ? store.removeFile(file) : { ok: false, error: 'store 不可用' }
    if (removed?.ok !== true) return { ok: false, error: `删除 secret.json 失败：${removed?.error ?? '未知'}` }
    const resolved = await keySource().catch(() => ({ key: '', source: 'none' }))
    logger?.(`watcher: 判读 key 文件已清除（当前来源：${resolved.source}）`)
    return { ok: true, configured: resolved.source !== 'none', source: resolved.source, stored: false }
  }
  return { ensureConfig, hasStoredKey, getConfig, updateConfig, keyStatus, setKey, clearKey, get warnings() { return configWarnings }, get state() { return configState } }
}
