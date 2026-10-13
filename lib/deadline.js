/** Error paths must also tolerate malformed signals at public boundaries. */
export function isAborted(signal) {
  try { return signal?.aborted === true } catch { return false }
}

/** Release the caller on cancellation, including adapters that ignore abort. */
export async function withAbort(operation, signal) {
  if (!signal) return operation()
  if (signal.aborted) throw signal.reason ?? new Error('操作已取消')
  let onAbort
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('操作已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
      Promise.resolve().then(() => {
        if (signal.aborted) throw signal.reason ?? new Error('操作已取消')
        return operation()
      }),
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** A fixed deadline for connectivity and TypeSafe calls, not text generation. */
export async function withDeadline(operation, timeoutMs, label) {
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}超时（${timeoutMs}ms，aborted）`)
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline])
  } finally {
    clearTimeout(timer)
  }
}
