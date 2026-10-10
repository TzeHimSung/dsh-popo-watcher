import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

test('readJson 拒绝数字路径：即使 stdin 保持开启也不会阻塞', { timeout: 5000 }, async () => {
  const source = `import { readJson } from ${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)};
    console.log(JSON.stringify(readJson(0, 'fallback')))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  let diagnostic = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { diagnostic += chunk })
  const timer = setTimeout(() => child.kill(), 2000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('close', resolve)
      child.once('error', reject)
    })
    assert.equal(code, 0, diagnostic || '读取数字文件描述符导致子进程超时')
    assert.deepEqual(JSON.parse(output), { ok: false, error: '文件路径为空', code: 'INVALID_PATH', value: 'fallback' })
  } finally {
    clearTimeout(timer)
    child.stdin.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
})
