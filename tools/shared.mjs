/**
 * 命令行工具的公共零件：宿主 subprocess seam 的本地实现、打码、参数解析。
 *
 * 为什么要有这个文件：`tools/*.mjs` 是**独立 node 进程**，没有宿主的 `subprocess` 服务，
 * 但 `lib/popo.js` 的传输层是按那个 seam 的形状写的。本地实现只是把 `node:child_process`
 * 包成同一个形状（`{ done, collected: { stdout/stderr: { readFrom } }, terminate }`），
 * 这样离线验证跑的就是**同一份生产代码路径**。
 *
 * @module dsh-popo-watcher/tools/shared
 */

import { spawn } from 'node:child_process'

/**
 * 用 `node:child_process` 冒充宿主 subprocess seam。
 * 句柄形状必须与宿主一致（见 `lib/popo.js` 的 `run()`）。
 * @param spec - `{ argv, cwd, stdio, graceMs }`。
 * @returns 句柄。
 */
export function localSpawn(spec) {
  const [command, ...args] = spec.argv ?? []
  const child = spawn(command, args, { cwd: spec.cwd, windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ exitCode: null, error }))
    child.on('close', (exitCode) => resolve({ exitCode }))
  })
  return {
    done,
    collected: {
      stdout: { readFrom: (offset) => ({ text: stdout.slice(Number(offset) || 0) }) },
      stderr: { readFrom: (offset) => ({ text: stderr.slice(Number(offset) || 0) }) },
    },
    terminate: () => {
      try {
        child.kill()
      } catch {
        // 忽略
      }
    },
  }
}

/** 掩码敏感串（uid / key 只露前 3 后 2）。 */
export function mask(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (value.length <= 6) return `${value.slice(0, 1)}***`
  return `${value.slice(0, 3)}***${value.slice(-2)}`
}

/**
 * 解析 `--key value` / `--flag` 形式的参数。
 * @param argv - `process.argv.slice(2)`。
 * @param defaults - 默认值对象。
 * @returns 解析结果（默认值 + 覆盖）。
 */
export function parseFlags(argv, defaults = {}) {
  const out = { ...defaults }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== 'string' || !token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else {
      out[name] = next
      index += 1
    }
  }
  return out
}

/** 睡眠（毫秒）。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
