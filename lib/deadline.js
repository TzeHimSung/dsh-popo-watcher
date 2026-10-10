/** Bound the complete async operation, including adapters that ignore abort. */
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
