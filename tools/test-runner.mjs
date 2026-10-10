import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export function runTests(executable = process.execPath, extraEnv = {}, flags = []) {
  const project = fileURLToPath(new URL('../', import.meta.url))
  const testHome = mkdtempSync(join(tmpdir(), 'dsh-compat-tests-'))
  try {
    const tests = readdirSync(join(project, 'test'))
      .filter(name => name.endsWith('.test.js')).sort()
      .map(name => join(project, 'test', name))
    const result = spawnSync(executable, [...flags, '--test', '--test-timeout=30000', ...tests], {
      cwd: project,
      env: { ...process.env, ...extraEnv, USERPROFILE: testHome, HOME: testHome },
      stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, timeout: 120000,
    })
    if (result.error) console.error(result.error.message)
    process.exitCode = result.status ?? 1
  } finally {
    const target = resolve(testHome)
    if (!target.toLowerCase().startsWith((resolve(tmpdir()) + sep).toLowerCase())
      || !basename(target).startsWith('dsh-compat-tests-')) throw new Error('Invalid test directory')
    rmSync(target, { recursive: true, force: true })
  }
}
