/**
 * API key 解析：**设置页存的 key** → Process 环境变量 → Windows 用户作用域环境变量（HKCU\Environment）。
 *
 * 为什么需要后两档：本机把 `TYPESAFE_API_KEY` 设在 **User 作用域**，会话早于 `setx` 启动时
 * `process.env` 里根本没有它（skill 的 PowerShell 实现也踩过同一个坑）。注册表读取是一次性的
 * 只读查询，绝不打印 key 内容。
 *
 * 为什么还需要第一档：没有环境变量的机器上，用户只能改系统环境变量才能用判读；
 * 设置页存一份 `<数据根>/secret.json` 就能直接开工（写入由 watcher 负责，见 docs/interfaces.md §7）。
 *
 * 纪律：
 * - never-throw：读不到返回空串，读注册表失败返回空串；
 * - **绝不把 key 写进日志、错误信息或返回值**（`resolveKeySource` 只多给一个"来源"标签）；
 * - 模块级无副作用：import 不读盘、不读环境变量、不查注册表。
 *
 * @module dsh-popo-watcher/key-source
 */

import { execFile } from 'node:child_process'

import { readJson } from './store.js'

/** 设置页存的 key 在 `secret.json` 里的字段名。 */
export const STORED_KEY_FIELD = 'typesafeApiKey'

/** key 的长度上限（超了直接当非法，避免把一坨文件内容当 key）。 */
const MAX_KEY_CHARS = 512

/** 用户作用域环境变量的读取结果缓存（成功才缓存，避免 key 装好后仍读不到）。 */
const userScopeCache = new Map()

/**
 * 设置页存的 key 文件路径。
 * @param root - 数据根（`lib/store.js` 的 `dataRoot()`）。
 * @returns 绝对路径；数据根不可用时为空串。
 */
export function storedKeyFile(root) {
  const base = typeof root === 'string' ? root.trim() : ''
  return base === '' ? '' : `${base}/secret.json`
}

/**
 * 清洗一个候选 key：去掉首尾空白与包裹引号，非法（含换行、过长、非字符串）返回空串。
 * @param value - 候选值。
 * @returns 可用的 key，或空串。
 */
export function normalizeKey(value) {
  if (typeof value !== 'string') return ''
  let key = value.trim()
  if (key.length >= 2) {
    const first = key[0]
    const last = key[key.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) key = key.slice(1, -1).trim()
  }
  if (key === '' || key.length > MAX_KEY_CHARS) return ''
  if (/[\r\n\t]/.test(key)) return ''
  return key
}

/**
 * 读设置页存的 key（never-throw）。
 * @param file - `storedKeyFile()` 的返回值；空串直接返回空串。
 * @param readJsonImpl - 可选读实现（默认 `lib/store.js` 的 `readJson`；注入便于测试）。
 * @returns key，或空串。
 */
export function readStoredKey(file, readJsonImpl) {
  if (typeof file !== 'string' || file === '') return ''
  try {
    const read = typeof readJsonImpl === 'function' ? readJsonImpl(file, undefined) : readJson(file, undefined)
    if (read?.ok !== true) return ''
    return normalizeKey(read.value?.[STORED_KEY_FIELD])
  } catch {
    return ''
  }
}

/**
 * 从 `HKCU\Environment` 读取一个用户作用域环境变量。
 * @param name - 变量名（只允许字面量名字，避免注入 `reg` 参数）。
 * @returns Promise<string>：读不到时为空串。
 */
export function readUserScopeEnv(name) {
  return new Promise((resolve) => {
    try {
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return resolve('')
      if (process.platform !== 'win32') return resolve('')
      if (userScopeCache.has(name)) return resolve(userScopeCache.get(name))
      execFile('reg', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true }, (error, stdout) => {
        if (error) return resolve('')
        const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)\s*$/m.exec(String(stdout))
        const value = match ? match[1].trim() : ''
        if (value !== '') userScopeCache.set(name, value)
        resolve(value)
      })
    } catch {
      resolve('')
    }
  })
}

/**
 * 按优先级取一个 key，并说明它是从哪来的（**不返回 key 之外的任何东西**）。
 * @param args - `{ name, explicit, env, file }`。
 * @returns Promise<`{ key: string, source: 'explicit'|'file'|'env'|'user-env'|'none' }`>，永不 reject。
 */
export async function resolveKeySource(args = {}) {
  try {
    const { name = 'TYPESAFE_API_KEY', explicit = '', env = process.env, file = '' } = args
    const direct = normalizeKey(explicit)
    if (direct !== '') return { key: direct, source: 'explicit' }

    const stored = readStoredKey(file)
    if (stored !== '') return { key: stored, source: 'file' }

    const fromProcess = normalizeKey(env?.[name])
    if (fromProcess !== '') return { key: fromProcess, source: 'env' }

    const fromUser = normalizeKey(await readUserScopeEnv(name))
    if (fromUser !== '') return { key: fromUser, source: 'user-env' }

    return { key: '', source: 'none' }
  } catch {
    return { key: '', source: 'none' }
  }
}

/**
 * 按优先级取一个 key：显式值 → 数据根里的 key 文件 → Process 环境变量 → User 作用域环境变量。
 * @param args - `{ name, explicit, env, file }`。
 * @returns Promise<string>：读不到时为空串。
 */
export async function resolveKey(args = {}) {
  const resolved = await resolveKeySource(args)
  return typeof resolved?.key === 'string' ? resolved.key : ''
}
