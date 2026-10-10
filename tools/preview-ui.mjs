/** 实际客户端 + 本机 Desktop 的 React/主题；全部 RPC 在 fixture 内存中执行。 */
import { createServer } from 'node:http'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const desktopPath = process.argv[2] ?? process.env.DSH_DESKTOP_DIR
if (!desktopPath) throw new Error('Provide the DSH Desktop directory as an argument or DSH_DESKTOP_DIR.')
const desktop = resolve(desktopPath)
const fd = openSync(join(desktop, 'resources', 'app.asar'), 'r')
const prefix = Buffer.alloc(16)
readSync(fd, prefix, 0, prefix.length, 0)
const headerBytes = Buffer.alloc(prefix.readUInt32LE(12))
readSync(fd, headerBytes, 0, headerBytes.length, 16)
const header = JSON.parse(headerBytes.toString())
const dataOffset = 8 + prefix.readUInt32LE(4)
const hostPackages = 'dsh/node_modules/@deepseek-ai/'
const assetRoot = `${hostPackages}dsh-web-frontend/dist/assets/`

function entry(path) {
  return path.split('/').reduce((node, name) => node?.files?.[name], header)
}

function readHost(path) {
  const item = entry(path)
  if (!item || item.files || item.link) throw new Error(`Missing host asset: ${path}`)
  if (item.unpacked) return readFileSync(join(desktop, 'resources', 'app.asar.unpacked', path))
  const bytes = Buffer.alloc(item.size)
  readSync(fd, bytes, 0, bytes.length, dataOffset + Number(item.offset))
  return bytes
}

const mainName = Object.keys(entry(assetRoot.slice(0, -1)).files).find(name => /^index-.*\.js$/.test(name))
const main = readHost(assetRoot + mainName).toString()
const seedFactory = /function ([\w$]+)\(\)\{return\{react:/.exec(main)?.[1]
const bootstrap = /const [\w$]+=globalThis\.dshDesktopBoot/.exec(main)?.index
if (!seedFactory || bootstrap === undefined) throw new Error('Unsupported Desktop seed layout; preview not started')
// 只在预览响应中截去应用启动入口，导出同一份宿主模块种子；不改安装目录。
const seeds = `${main.slice(0, bootstrap)}\nglobalThis.__POPO_QA_SEEDS__=${seedFactory}();\n`
const theme = readHost(`${hostPackages}dsh-client-ui-theme/lib/client.js`).toString()
const css = [...theme.matchAll(/(?:const css(?:\$\d+)?|var \w+_css_default) = ("(?:\\.|[^"\\])*");/g)].map(match => JSON.parse(match[1])).join('\n')
if (!css.includes('--dsw-alias-label-primary:')) throw new Error('Desktop theme tokens missing; preview not started')

const server = createServer((request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    let body
    let type = 'text/javascript; charset=utf-8'
    if (path === '/') {
      body = readFileSync(join(project, 'test', 'fixtures', 'ui-preview.html'))
      type = 'text/html; charset=utf-8'
    } else if (path === '/plugin.js') body = readFileSync(join(project, 'lib', 'client.js'))
    else if (path === '/config.js') body = readFileSync(join(project, 'lib', 'config.js'))
    else if (path === '/theme.css') { body = css; type = 'text/css; charset=utf-8' }
    else if (path === '/host/qa-seeds.js') body = seeds
    else if (path.startsWith('/host/') && !path.split('/').includes('..')) {
      const asset = path.slice('/host/'.length)
      body = readHost(assetRoot + asset)
      if (asset.endsWith('.css')) type = 'text/css; charset=utf-8'
    } else { response.writeHead(404); response.end(); return }
    response.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; base-uri 'none'",
    })
    response.end(body)
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(error.message)
  }
})
server.listen(0, '127.0.0.1', () => console.log(`Actual plugin UI preview (mock RPC only): http://127.0.0.1:${server.address().port}/`))
server.on('close', () => closeSync(fd))
process.once('SIGINT', () => server.close())
process.once('SIGTERM', () => server.close())
