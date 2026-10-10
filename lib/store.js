/**
 * 存储层：数据根定位、原子写、JSONL 追加、尾部读取、环形日志。**全部 never-throw**。
 *
 * 位置：`<home>/.dsh/popo-watcher/`（跟 DSH 一起备份/清理）。为什么不用宿主的 storage 服务：
 * 那个面要求 schemastery/zod schema，而本插件以 symlink 方式安装、裸 import 拿不到这些包
 * （见 README「宿主依赖与客户端打包边界」）。
 *
 * 纪律：任何失败都返回 `{ ok:false, error }`，绝不抛——宿主进程里一次未处理异常就可能
 * 让 `dsh web` 退出。
 *
 * @module dsh-popo-watcher/store
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** 读尾部时最多读进的字节数（避免把 20MB 的流水整个读进内存）。 */
const TAIL_MAX_BYTES = 512 * 1024

/**
 * 路径长度上限。
 * 为什么需要它：Windows 上 `mkdirSync(超长路径, { recursive: true })` 会为每一级前缀反复尝试创建，
 * 一个 10 万字符的单段路径能把**整个事件循环**卡住几十秒（模糊测试实测）。宿主进程主线程被卡住
 * 等于 GUI 与采集全停，而 `importLegacy` 的来源目录是用户从设置页填的，所以超长路径必须早点拒。
 */
const MAX_PATH_CHARS = 4096

/** 归一化错误为字符串。 */
function errText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 路径合法性检查。
 * @param value - 候选路径。
 * @param options - `{ absolute }`：是否必须绝对路径。
 * @returns 问题描述，或 null 表示可用。
 */
function pathProblem(value, options = {}) {
  if (typeof value !== 'string' || value.trim() === '') return '文件路径为空'
  if (value.length > MAX_PATH_CHARS) return `路径过长（${value.length} 字符，上限 ${MAX_PATH_CHARS}）`
  if (options.absolute === true && !isAbsolute(value)) return `拒绝写入相对路径: ${value.slice(0, 80)}`
  return null
}

/**
 * 解析宿主 home。
 * @param env - 环境对象。
 * @returns home 路径（useroverride → HOME → os.homedir）。
 */
export function resolveHome(env = process.env) {
  try {
    const candidate = env?.USERPROFILE || env?.HOME
    if (typeof candidate === 'string' && candidate !== '') return candidate
    return homedir()
  } catch {
    return '.'
  }
}

/**
 * 数据根：`<home>/.dsh/popo-watcher`。
 * @param env - 环境对象。
 * @returns 绝对路径。
 */
export function dataRoot(env = process.env) {
  return join(resolveHome(env), '.dsh', 'popo-watcher')
}

/**
 * 某个群的目录。
 * @param root - 数据根。
 * @param group - 群 ID。
 * @returns 目录路径。
 */
export function groupDir(root, group) {
  // root 不可用时返回空串（绝不返回相对路径：那会让下游把数据写进进程 CWD）。
  const base = typeof root === 'string' ? root.trim() : ''
  if (base === '') return ''
  return join(base, String(group ?? ''))
}

/**
 * 写盘目标的合法性检查：只接受绝对路径（相对路径在宿主进程里含义不确定）。
 * @param file - 目标路径。
 * @returns 问题描述，或 null 表示可写。
 */
function targetProblem(file) {
  return pathProblem(file, { absolute: true })
}

/**
 * 本地时间戳 `YYYY-MM-DD HH:mm:ss`。
 * @param date - 时间，默认现在。
 * @returns 时间戳字符串。
 */
export function nowStamp(date = new Date()) {
  try {
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  } catch {
    return ''
  }
}

/**
 * 确保目录存在（递归）。
 * @param dir - 目录路径。
 * @returns `{ ok, error? }`。
 */
export function ensureDir(dir) {
  try {
    const problem = pathProblem(dir)
    if (problem !== null) return { ok: false, error: problem }
    if (existsSync(dir)) return { ok: true }
    mkdirSync(dir, { recursive: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

/**
 * 写文本（UTF-8，覆盖写；目录不存在就建）。
 * @param file - 目标文件。
 * @param text - 内容。
 * @returns `{ ok, error? }`。
 */
export function writeText(file, text) {
  try {
    const problem = targetProblem(file)
    if (problem !== null) return { ok: false, error: problem }
    const ready = ensureDir(dirname(file))
    if (!ready.ok) return ready
    writeFileSync(file, typeof text === 'string' ? text : String(text ?? ''), 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

/**
 * 删除文件（不存在也算成功：调用方要的是"结束状态"）。
 * @param file - 目标文件。
 * @returns `{ ok, error? }`。
 */
export function removeFile(file) {
  try {
    const problem = targetProblem(file)
    if (problem !== null) return { ok: false, error: problem }
    unlinkSync(file)
    return { ok: true }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true }
    return { ok: false, error: errText(error) }
  }
}

/**
 * 读文本（UTF-8）。
 * @param file - 文件路径。
 * @returns `{ ok, value?, error?, code? }`。
 */
export function readText(file) {
  try {
    const problem = pathProblem(file)
    if (problem !== null) return { ok: false, error: problem, code: 'INVALID_PATH' }
    return { ok: true, value: readFileSync(file, 'utf8') }
  } catch (error) {
    return { ok: false, error: errText(error), ...(typeof error?.code === 'string' ? { code: error.code } : {}) }
  }
}

/**
 * 读 JSON；解析失败或文件缺失时返回 fallback。
 * @param file - 文件路径。
 * @param fallback - 失败时的回落值。
 * @returns `{ ok, value, error?, code? }`（`value` 始终可用）。
 */
export function readJson(file, fallback) {
  const text = readText(file)
  if (!text.ok) return { ...text, value: fallback }
  try {
    return { ok: true, value: JSON.parse(text.value) }
  } catch (error) {
    return { ok: false, value: fallback, error: `JSON 解析失败: ${errText(error)}`, code: 'JSON_PARSE_ERROR' }
  }
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename 替换。
 * @param file - 目标文件。
 * @param value - JSON 可序列化值。
 * @returns `{ ok, error? }`。
 */
export function writeJsonAtomic(file, value) {
  try {
    const text = JSON.stringify(value, null, 2)
    if (typeof text !== 'string') return { ok: false, error: '值无法序列化为 JSON' }
    return writeTextAtomic(file, text)
  } catch (error) {
    return { ok: false, error: `序列化失败: ${errText(error)}` }
  }
}

/** 同目录临时文件 + rename；日志裁剪也不能留下半个文件。 */
export function writeTextAtomic(file, text) {
  let tmp = ''
  try {
    const problem = targetProblem(file)
    if (problem !== null) return { ok: false, error: problem }
    const dir = dirname(file)
    const ready = ensureDir(dir)
    if (!ready.ok) return ready
    if (typeof text !== 'string') return { ok: false, error: '文本必须为字符串' }
    tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    if (tmp !== '') {
      try {
        unlinkSync(tmp)
      } catch {
        // 临时文件清理失败不影响结果
      }
    }
    return { ok: false, error: errText(error) }
  }
}

/**
 * 追加一行 JSONL。
 * @param file - 目标文件。
 * @param value - JSON 可序列化值。
 * @returns `{ ok, error? }`。
 */
export function appendJsonl(file, value) {
  try {
    const problem = targetProblem(file)
    if (problem !== null) return { ok: false, error: problem }
    const ready = ensureDir(dirname(file))
    if (!ready.ok) return ready
    const line = `${JSON.stringify(value)}\n`
    writeFileSync(file, line, { encoding: 'utf8', flag: 'a' })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

/**
 * 读文件的尾部字节（最多 TAIL_MAX_BYTES）。
 * @param file - 文件路径。
 * @returns 文本，失败返回 null。
 */
function readTailText(file, maxBytes = TAIL_MAX_BYTES) {
  let fd = -1
  try {
    const size = statSync(file).size
    const start = size > maxBytes ? size - maxBytes : 0
    const readStart = Math.max(0, start - 1)
    const length = size - readStart
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    fd = openSync(file, 'r')
    readSync(fd, buffer, 0, length, readStart)
    const text = buffer.subarray(start - readStart).toString('utf8')
    if (start > 0 && buffer[0] !== 10) {
      const newline = text.indexOf('\n')
      return newline < 0 ? '' : text.slice(newline + 1)
    }
    return text
  } catch {
    return null
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败忽略
      }
    }
  }
}

/** 把尾部文本切成行（丢掉被截断的首行）。 */
function tailLines(file) {
  const text = readTailText(file)
  if (text === null) return null
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 读 JSONL 的尾部若干行（解析失败的行跳过）。
 * @param file - 文件路径。
 * @param limit - 最多返回多少行。
 * @returns `{ ok, rows, error? }`。
 */
export function readJsonlTail(file, limit) {
  try {
    const lines = tailLines(file)
    if (lines === null) return { ok: false, rows: [], error: '读取失败' }
    const picked = limit > 0 ? lines.slice(Math.max(0, lines.length - limit)) : lines
    const rows = []
    for (const line of picked) {
      if (line === '') continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // 跳过坏行（例如被截断的首行）
      }
    }
    return { ok: true, rows }
  } catch (error) {
    return { ok: false, rows: [], error: errText(error) }
  }
}

/**
 * 读文本文件的尾部若干行。
 * @param file - 文件路径。
 * @param limit - 最多返回多少行。
 * @returns `{ ok, lines, error? }`。
 */
export function readLineTail(file, limit) {
  try {
    const lines = tailLines(file)
    if (lines === null) return { ok: false, lines: [], error: '读取失败' }
    const picked = limit > 0 ? lines.slice(Math.max(0, lines.length - limit)) : lines
    return { ok: true, lines: picked.filter((line) => line !== '') }
  } catch (error) {
    return { ok: false, lines: [], error: errText(error) }
  }
}

/**
 * 原子追加 JSONL，始终满足行数与 UTF-8 字节双上限。
 * 超大单条保存带标记的摘要；读盘最多 maxBytes，读取失败不覆盖已有日志。
 *
 * @param file - 目标文件。
 * @param value - JSON 可序列化值。
 * @param options - `{ maxLines, maxBytes }`。
 * @returns `{ ok, trimmed?, error? }`。
 */
export function appendJsonlCapped(file, value, options = {}) {
  try {
    // 上限在 try 里读：`null` 与"读属性就抛"的对象都不能把这里带崩（默认参数只兜 undefined）。
    const maxLines = readPositiveInt(options?.maxLines, 5000)
    const maxBytes = readPositiveInt(options?.maxBytes, 4 * 1024 * 1024)
    const problem = targetProblem(file)
    if (problem !== null) return { ok: false, error: problem }
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') return { ok: false, error: '值无法序列化为 JSON' }
    const line = boundedAuditLine(serialized, maxBytes)
    if (line === null) return { ok: false, error: '字节上限过小，无法保存审计摘要' }
    const existing = readTailText(file, maxBytes)
    if (existing === null && existsSync(file)) return { ok: false, error: '读取已有日志失败，未覆盖' }
    const before = (existing ?? '').split(/\r?\n/).filter(Boolean)
    const lines = [...before, line].slice(-maxLines)
    let bytes = lines.reduce((sum, row) => sum + Buffer.byteLength(row) + 1, 0)
    let first = 0
    while (bytes > maxBytes && first < lines.length - 1) bytes -= Buffer.byteLength(lines[first++]) + 1
    const kept = lines.slice(first)
    const written = writeTextAtomic(file, `${kept.join('\n')}\n`)
    if (!written.ok) return written
    const trimmed = kept.length < before.length + 1 || line !== serialized
    return { ok: true, ...(trimmed ? { trimmed: true } : {}) }
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

function boundedAuditLine(serialized, maxBytes) {
  if (Buffer.byteLength(serialized) + 1 <= maxBytes) return serialized
  const value = JSON.parse(serialized)
  const summary = { truncated: true, originalBytes: Buffer.byteLength(serialized) + 1 }
  // 保留消息/回执身份与时间，正文只保留摘要；真实发送文本不经过这里。
  for (const key of ['at', 'now', 'time', 'atMs', 't_msg', 'group', 'msgId', 'from', 'name', 'opening', 'verdict']) {
    const field = value?.[key]
    if (typeof field === 'string') summary[key] = field.slice(0, 128)
    else if (typeof field === 'number' || typeof field === 'boolean') summary[key] = field
  }
  const bodyKey = ['content', 'draft', 'detail'].find(key => typeof value?.[key] === 'string') ?? 'preview'
  summary[bodyKey] = String(value?.[bodyKey] ?? serialized).slice(0, 2048)
  while (true) {
    const line = JSON.stringify(summary)
    if (Buffer.byteLength(line) + 1 <= maxBytes) return line
    const longest = Object.keys(summary).filter(key => typeof summary[key] === 'string' && summary[key].length)
      .sort((a, b) => summary[b].length - summary[a].length)[0]
    if (longest === undefined) return null
    summary[longest] = summary[longest].slice(0, Math.floor(summary[longest].length / 2))
  }
}

/** 读一个正整数上限（坏值回落默认；`null`/抛错对象都算坏值）。 */
function readPositiveInt(value, fallback) {
  try {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
  } catch {
    return fallback
  }
}

/**
 * 追加一行日志；超过 maxLines 时整体重写，只保留最后 maxLines 行。
 * @param file - 日志文件。
 * @param line - 一行文本（不含换行）。
 * @param maxLines - 行数上限。
 * @returns `{ ok, error? }`。
 */
export function appendLineCapped(file, line, maxLines = 500) {
  try {
    const problem = targetProblem(file)
    if (problem !== null) return { ok: false, error: problem }
    const ready = ensureDir(dirname(file))
    if (!ready.ok) return ready
    const text = typeof line === 'string' ? line : String(line)
    writeFileSync(file, `${text}\n`, { encoding: 'utf8', flag: 'a' })
    const count = (readLineTail(file, maxLines + 1).lines ?? []).length
    if (count > maxLines) {
      const kept = readLineTail(file, maxLines).lines ?? []
      writeFileSync(file, `${kept.join('\n')}\n`, 'utf8')
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}
