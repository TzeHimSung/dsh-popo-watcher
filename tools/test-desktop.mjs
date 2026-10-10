import { join, resolve } from 'node:path'
import { runTests } from './test-runner.mjs'

const desktopPath = process.argv[2] ?? process.env.DSH_DESKTOP_DIR
if (!desktopPath) throw new Error('Provide the DSH Desktop directory as an argument or DSH_DESKTOP_DIR.')
const desktop = resolve(desktopPath)
console.log('DSH Desktop regression: complete suite, including fuzz tests')
runTests(join(desktop, 'DeepSeek Harness.exe'), {
  ELECTRON_RUN_AS_NODE: '1',
  DSH_TEST_RUNTIME: join(desktop, 'resources', 'app.asar', 'dsh'),
}, ['--expose-internals'])
