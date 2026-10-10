/** Fast orchestration fixture. Disk failure/retention tests use the real store. */
import { nowStamp } from '../../lib/store.js'

export function memoryStore(seed = {}, root = 'C:/fake/.dsh/popo-watcher') {
  const json = new Map(Object.entries(seed.json ?? {}))
  const jsonl = new Map(Object.entries(seed.jsonl ?? {}))
  const text = new Map(Object.entries(seed.text ?? {}))
  const writes = []
  const sizes = new WeakMap()
  const clone = value => JSON.parse(JSON.stringify(value))
  const bytes = value => {
    if (value && typeof value === 'object' && sizes.has(value)) return sizes.get(value)
    const size = Buffer.byteLength(JSON.stringify(value)) + 1
    if (value && typeof value === 'object') sizes.set(value, size)
    return size
  }
  return {
    json, jsonl, text, writes, nowStamp,
    dataRoot: () => root,
    groupDir: (base, group) => `${base}/${group}`,
    readJson: (file, fallback) => json.has(file) ? { ok: true, value: clone(json.get(file)) } : { ok: false, value: fallback, code: 'ENOENT', error: 'ENOENT' },
    writeJsonAtomic(file, value) { const saved = clone(value); writes.push({ file, value: saved }); json.set(file, saved); return { ok: true } },
    appendJsonl(file, value) { jsonl.set(file, [...(jsonl.get(file) ?? []), clone(value)]); return { ok: true } },
    appendJsonlCapped(file, value, { maxLines = 5000, maxBytes = 4 * 1024 * 1024 } = {}) {
      const rows = [...(jsonl.get(file) ?? []), clone(value)].slice(-maxLines)
      let size = rows.reduce((sum, row) => sum + bytes(row), 0)
      let first = 0
      while (size > maxBytes && first < rows.length - 1) size -= bytes(rows[first++])
      jsonl.set(file, rows.slice(first))
      return { ok: true }
    },
    readJsonlTail: (file, limit = 20) => ({ ok: true, rows: (jsonl.get(file) ?? []).slice(-limit) }),
    appendLineCapped(file, line, maxLines = 500) { text.set(file, [...(text.get(file) ?? []), String(line)].slice(-maxLines)); return { ok: true } },
    readLineTail: (file, limit = 50) => ({ ok: true, lines: (text.get(file) ?? []).slice(-limit) }),
    readText: file => text.has(file) ? { ok: true, value: text.get(file) } : { ok: false, error: 'ENOENT', code: 'ENOENT' },
    writeText(file, value) { text.set(file, String(value)); return { ok: true } },
    removeFile(file) { json.delete(file); jsonl.delete(file); text.delete(file); return { ok: true } },
  }
}
