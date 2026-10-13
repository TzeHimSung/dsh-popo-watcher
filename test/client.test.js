/**
 * dsh-popo-watcher 浏览器半冒烟测试：不启动浏览器，用注入的 window / document /
 * MutationObserver 桩执行 `lib/client.js` 这个 bundle，覆盖五件事：
 *
 * 1) bundle 的注册契约（`id` 必须等于包名）与 package.json 的双面声明；
 * 2) Cordis 插件形状（`inject` 声明 `slots` + `connection`）与三条降级路径
 *    （没有 connection / 没有可用 react / require 直接抛）；
 * 3) 设置项的注册参数（section / id / order / label）与「正文留空」；
 * 4) 状态卡页面：RPC 调用参数、成功状态、失败与抛错都退化成错误卡、错误边界兜底；
 * 5) 导航图标补丁：只换本行、沿用 shell 的 class、幂等、自愈、卸载时断开观察器。
 *
 * bundle 是浏览器脚本（非 ESM），所以用 `new Function` 注入那两个浏览器全局：
 * 在浏览器里它们是全局，在测试里是形参覆盖。页面要真渲染，另外配了一副极简假 React
 * （见 createFakeReact）——只实现 bundle 用到的那几个 API，不做协调/批处理。
 *
 * 全程不联网、不写盘；唯一的全局改动是 apply 期间临时接管 console.warn，
 * try/finally 里立刻还原（要断言的就是这些降级日志）。
 *
 * @module dsh-popo-watcher/test/client
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { defaultConfig as freshConfig, applyPatch } from '../lib/config.js'

// Most UI scenarios represent an already configured installation.
const defaultConfig = () => ({ ...freshConfig(), group: '1234567' })

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

/** 与 lib/client.js 的常量对应（改一处两处都要改，测试就是这条约定）。 */
const ICON_ATTR = 'data-dsh-popo-icon'
const LABEL = 'POPO自动水群'
const RPC_CHANNEL = '/popo-watcher'

/** 单层选择器：`tag` / `tag[attr]` / `tag[attr="value"]` / `[attr]` / `[attr="value"]`。 */
const ATTR_TOKEN = /^([a-z]*)\[([a-z-]+)(?:="([^"]*)")?\]$/

/** `dataset.camelKey` ↔ `data-camel-key`（桩只做定向映射，够 bundle 的幂等检查用）。 */
const datasetAttr = (key) => `data-${String(key).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`

/** 匹配由 bundle 实际使用的那几种选择器语法。 */
function matchesSimple(node, token) {
  const attr = ATTR_TOKEN.exec(token)
  if (attr === null) return node.tagName === token
  if (attr[1] !== '' && node.tagName !== attr[1]) return false
  return attr[3] === undefined ? node.hasAttribute(attr[2]) : node.getAttribute(attr[2]) === attr[3]
}

/** 后代选择器：空格分隔，最后一个 token 必须命中节点本身，其余从近到远在祖先里找。 */
function matches(node, selector) {
  const tokens = selector.split(' ')
  if (!matchesSimple(node, tokens[tokens.length - 1])) return false
  let index = tokens.length - 2
  for (let parent = node.parent; parent !== null && index >= 0; parent = parent.parent) {
    if (matchesSimple(parent, tokens[index])) index -= 1
  }
  return index < 0
}

/** 桩节点：只实现 bundle 用到的那一小撮 DOM 方法。 */
class FakeNode {
  constructor(tagName) {
    this.tagName = tagName
    this.attributes = new Map()
    this.childNodes = []
    this.parent = null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  /** 桩 dataset：只实现 bundle 用到的「写 camelCase → 落到 data-* 属性」。 */
  get dataset() {
    const node = this
    return new Proxy({}, {
      set(target, key, value) {
        node.setAttribute(datasetAttr(key), value)
        return true
      },
      get(target, key) {
        const value = node.getAttribute(datasetAttr(key))
        return value === null ? undefined : value
      },
    })
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this
      this.childNodes.push(node)
    }
  }

  remove() {
    if (this.parent === null) return
    const index = this.parent.childNodes.indexOf(this)
    if (index !== -1) this.parent.childNodes.splice(index, 1)
    this.parent = null
  }

  get firstElementChild() {
    return this.childNodes.length === 0 ? null : this.childNodes[0]
  }

  replaceChild(next, previous) {
    const index = this.childNodes.indexOf(previous)
    if (index === -1) throw new Error('replaceChild: 目标不是本节点的子节点')
    previous.parent = null
    next.parent = this
    this.childNodes[index] = next
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (matches(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }
}

/** 桩文案 span：bundle 只读它的 textContent。 */
function labelSpan(textContent) {
  const node = new FakeNode('span')
  node.textContent = textContent
  return node
}

/** 桩导航行：首元素是 shell 渲染的图标 svg（带 navIcon class），其后是文案 span。 */
function navCell(label, viewBox) {
  const cell = new FakeNode('button')
  const icon = new FakeNode('svg')
  icon.setAttribute('class', 'navIcon')
  icon.setAttribute('viewBox', viewBox)
  cell.append(icon, labelSpan(label))
  return { cell, icon }
}

/**
 * 假 React + 极简渲染器：只实现客户端使用的 hooks；布局另外用真实 React 验收。
 *
 * - `createElement(type, props, ...children)` → 纯对象（`props.children` 是数组，可能嵌套）；
 * - `Component` 基类：`setState` 合并 state 后同步重渲染；
 * - `useState(initial)`：按渲染顺序存值，setter 更新后重渲染；
 * - `useEffect(fn, deps)`：提交渲染后执行，deps 浅比较与清理；`useRef` 保持同一引用；
 * - 错误边界：类组件的子树抛错且它的 `type.getDerivedStateFromError` 存在时，
 *   吃掉异常、合并 state 再重渲染一次（行为对齐 React 的 getDerivedStateFromError 路径）。
 *
 * 组件实例按「渲染位置」键控而不是元素对象身份：bundle 每次重渲染都会重建元素对象
 * （`() => Page({ connection })` 每跑一次就新造一棵树），只有位置稳定的缓存才留得住 state 与 hooks。
 * 渲染结果是纯数据树（组件已展开、只剩 `{ type, props }` 与字符串叶子），可直接 JSON.stringify 断言。
 *
 * @returns 假 React 模块，以及 render / tree / flush / unmount 四个测试把手。
 */
function createFakeReact() {
  /** 渲染位置 → 组件实例（函数组件宿主 / 类组件实例）。 */
  const instances = new Map()
  /** 当前正在渲染的函数组件宿主；hooks 按调用顺序挂在它上面。 */
  let host = null
  let hookIndex = 0
  let rootElement = null
  let tree = null
  let rendering = false
  let needsRender = false
  let effects = []
  let updates = 0

  function instanceAt(key, create) {
    let found = instances.get(key)
    if (found === undefined) {
      found = create()
      instances.set(key, found)
    }
    return found
  }

  function rerender() {
    if (rendering) { needsRender = true; return }
    do {
      needsRender = false
      rendering = true
      try {
        if (rootElement !== null) tree = renderNode(rootElement, 'root')
        const pending = effects
        effects = []
        for (const effect of pending) effect()
      } finally { rendering = false }
    } while (needsRender && rootElement !== null)
  }

  function hookHost(api) {
    if (host === null) throw new Error(`${api} 只能在组件渲染期间调用`)
    return host
  }

  function sameDeps(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false
    return before.every((value, index) => Object.is(value, after[index]))
  }

  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(update) {
      const patch = typeof update === 'function' ? update(this.state, this.props) : update
      this.state = { ...this.state, ...patch }
      rerender()
    }
  }

  function createElement(type, props, ...children) {
    return { type, props: { ...props, children } }
  }

  function useState(initial) {
    const owner = hookHost('useState')
    owner.hooks ??= []
    const index = hookIndex
    hookIndex += 1
    owner.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
    const slot = owner.hooks[index]
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      updates += 1
      slot.value = value
      rerender()
    }]
  }

  function useEffect(effect, deps) {
    const owner = hookHost('useEffect')
    owner.hooks ??= []
    const index = hookIndex
    hookIndex += 1
    const previous = owner.hooks[index]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return
    const slot = { deps, cleanup: null }
    owner.hooks[index] = slot
    effects.push(() => {
      previous?.cleanup?.()
      const cleanup = effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null
    })
  }

  function useRef(initial) {
    const owner = hookHost('useRef')
    const index = hookIndex++
    owner.hooks[index] ??= { ref: { current: initial } }
    return owner.hooks[index].ref
  }

  function flatten(children) {
    const out = []
    for (const child of children) {
      if (Array.isArray(child)) out.push(...flatten(child))
      else out.push(child)
    }
    return out
  }

  /** 类组件靠 prototype.render 认，函数组件（含箭头）没有。 */
  function isClassComponent(type) {
    return typeof type === 'function' && type.prototype !== undefined && typeof type.prototype.render === 'function'
  }

  function renderChildren(children, key) {
    const rendered = []
    const flat = flatten(children ?? [])
    for (let index = 0; index < flat.length; index += 1) {
      const child = renderNode(flat[index], `${key}/${index}`)
      if (child !== null) rendered.push(child)
    }
    return rendered
  }

  function renderNode(node, key) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    const { type, props } = node
    if (isClassComponent(type)) return renderClass(node, key)
    if (typeof type === 'function') return renderFunction(node, key)
    return { type, props: { ...props, children: renderChildren(props.children, key) } }
  }

  function renderClass(element, key) {
    const instance = instanceAt(key, () => new element.type(element.props))
    instance.props = element.props
    try {
      return renderNode(instance.render(), `${key}>`)
    } catch (error) {
      // 没有错误边界就继续往上抛：这里的 catch 本身就是「边界存在」的判据。
      if (typeof element.type.getDerivedStateFromError !== 'function') throw error
      instance.state = { ...instance.state, ...element.type.getDerivedStateFromError(error) }
      return renderNode(instance.render(), `${key}>`)
    }
  }

  function renderFunction(element, key) {
    const instance = instanceAt(key, () => ({ hooks: [] }))
    const previousHost = host
    const previousIndex = hookIndex
    host = instance
    hookIndex = 0
    let output
    try {
      output = element.type(element.props)
    } finally {
      host = previousHost
      hookIndex = previousIndex
    }
    return renderNode(output, `${key}>`)
  }

  return {
    React: { createElement, Component, useState, useEffect, useRef },
    updates: () => updates,
    createElement,
    /** 挂载（或重挂载）一棵树，返回求值后的纯数据树。 */
    render(element) {
      rootElement = element
      rerender()
      return tree
    },
    /** 最近一次渲染结果：setState 触发的重渲染会就地覆盖它。 */
    tree() {
      return tree
    },
    /** 让 `tick()` 这类 async 副作用走完（微任务队列 + 一轮 setImmediate）。 */
    flush() {
      return new Promise((resolve) => setImmediate(resolve))
    },
    /** 跑掉所有 effect 清理（模拟卸载），免得 setInterval 之类的句柄拖着测试进程。 */
    unmount() {
      for (const instance of instances.values()) {
        for (const slot of instance.hooks ?? []) {
          slot.cleanup?.()
          slot.cleanup = null
        }
      }
      rootElement = null
    },
  }
}

/** 桩宿主连接：记录每次 RPC，按用例决定回什么 / 怎么炸。 */
function connectionStub({ reply = { ok: true, value: {} }, failure = null } = {}) {
  const calls = []
  return {
    calls,
    rpc: {
      async call(channel, method, params) {
        calls.push([channel, method, params])
        if (failure !== null) throw failure
        return reply
      },
    },
  }
}

/** 断言渲染树里出现了某段文案（JSON 里的中文是原样输出的）。 */
function assertTreeHas(tree, text) {
  const json = JSON.stringify(tree)
  assert.ok(json.includes(text), `渲染树里应当出现「${text}」，实际：${json.match(/页面渲染失败[^"\\]+/)?.[0] ?? json.slice(0, 300)}`)
}

/**
 * 组装一次浏览器半挂载：桩 document（`body > div[role=dialog] > nav` 两行）+ 桩 ctx。
 * @param options.connection - `ctx.get('connection')` 的返回值；不传即「宿主没给 connection」。
 * @param options.react - `require('react')` 的返回值；不传且没给 reactError 时 require 抛错。
 * @param options.reactError - 让 `require('react')` 抛这个具体错误。
 * @returns 采集到的注册结果、effect、降级日志、require 记录、观察器与 DOM 引用。
 */
function mount(options = {}) {
  const document = new FakeNode('#document')
  const head = new FakeNode('head')
  const body = new FakeNode('body')
  const dialog = new FakeNode('div')
  dialog.setAttribute('role', 'dialog')
  const nav = new FakeNode('nav')
  const archived = navCell('已归档会话', '0 0 20 20')
  // 本行初始是 shell 的齿轮图标（未识别的 section id 一律回落 IconSettingsOutline16）。
  const popo = navCell(LABEL, '0 0 16 16')
  nav.append(archived.cell, popo.cell)
  dialog.append(nav)
  body.append(dialog)
  document.append(head, body)
  document.body = body
  document.head = head
  document.documentElement = document
  document.createElement = (tagName) => new FakeNode(tagName)
  document.createElementNS = (namespaceURI, tagName) => {
    const node = new FakeNode(tagName)
    node.namespaceURI = namespaceURI
    return node
  }

  const observers = []
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.target = null
      this.options = null
      this.disconnected = false
      observers.push(this)
    }

    observe(target, options) {
      this.target = target
      this.options = options
    }

    disconnect() {
      this.disconnected = true
    }

    /** 测试用：模拟一批 childList 变更。 */
    emit() {
      this.callback([], this)
    }
  }

  const source = readFileSync(CLIENT_PATH, 'utf8')
  const registrations = []
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  new Function('window', 'document', 'MutationObserver', 'setInterval', 'clearInterval', source)(window, document, FakeMutationObserver, options.timers?.setInterval ?? setInterval, options.timers?.clearInterval ?? clearInterval)
  assert.equal(registrations.length, 1, 'bundle 必须恰好注册一次')

  const injected = []
  const effects = []
  const requires = []
  const ctx = {
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
    },
    get(service) {
      return service === 'connection' ? options.connection : undefined
    },
    slots: {
      inject(slot, callback) {
        injected.push({ slot, entry: callback() })
      },
      register(meta, component) {
        return { meta, component }
      },
    },
  }
  const exports = registrations[0].factory((id) => {
    requires.push(id)
    if (id === 'react') {
      if (options.reactError !== undefined) throw options.reactError
      if (options.react !== undefined) return options.react
    }
    throw new Error(`本 bundle 不允许 require('${id}')`)
  })

  // 「跳过注册」是 bundle 的正常降级路径，不该把噪声漏进测试输出：临时接管收集，
  // finally 里还原（用例要断言的就是这些行）。
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    exports.apply(ctx)
  } finally {
    console.warn = originalWarn
  }

  return {
    registration: registrations[0],
    exports,
    ctx,
    injected,
    effects,
    warnings,
    requires,
    document,
    head,
    body,
    observer: observers[0],
    archivedCell: archived.cell,
    archivedIcon: archived.icon,
    popoCell: popo.cell,
    popoIcon: popo.icon,
  }
}

/** 一份真实形状的宿主状态快照（字段对齐 lib/watcher.js `status()` 经 lib/rpc.js 转发的 payload）。 */
const STATUS = {
  phase: 'running',
  group: '1234567',
  window: { active: true, startedAt: '12:00:00', endsAt: '12:30:00', remainingSec: 1830, stopped: false },
  poll: { running: true, intervalSec: 30, lagSec: 2, watchedMsgs: 128 },
  sends: { count: 2, lastSendAt: '12:05:00', lastSendContent: '这个坑我上周也踩过' },
  selfUid: 'gzhuangxiongbiao',
  judge: { enabled: true, model: 'deepseek-chat', unavailablePolicy: 'silent' },
  llm: { provider: 'netease', model: 'deepseek-v3' },
  dryRun: false,
  transport: { ok: true },
  warnings: [],
  errors: [],
  configState: 'saved',
}

const IDLE = { ...STATUS, phase: 'idle', window: { active: false, stopped: false }, poll: { ...STATUS.poll, running: false } }

test('bundle 的注册 id 等于包名，package.json 声明了 web 客户端半', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
  const bundle = mount()

  assert.equal(bundle.registration.id, 'dsh-popo-watcher')
  assert.equal(bundle.registration.id, pkg.name)
  assert.equal(typeof bundle.registration.factory, 'function')

  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(existsSync(CLIENT_PATH), 'exports["./client"] 指向的文件必须存在')
})

test('导出 Cordis 插件形状：inject 声明 slots 与 connection', () => {
  const bundle = mount()

  assert.equal(bundle.exports.name, 'popo-watcher')
  assert.deepEqual(bundle.exports.inject, ['slots', 'connection'])
  assert.equal(typeof bundle.exports.apply, 'function')
})

test('注册「POPO自动水群」设置项：section / id / order / label 与页面组件', () => {
  const harness = createFakeReact()
  const bundle = mount({ connection: connectionStub({}), react: harness.React })

  assert.deepEqual(bundle.requires, ['react'])
  assert.deepEqual(bundle.warnings, [], '依赖齐全时不该有任何降级告警')
  assert.equal(bundle.injected.length, 1)
  const [{ slot, entry }] = bundle.injected
  assert.equal(slot, 'settings.section')
  assert.equal(entry.meta.name, 'settings.section')
  assert.equal(entry.meta.id, 'popo-watcher')
  assert.equal(entry.meta.order, 50)
  assert.equal(entry.meta.label(), LABEL)
  assert.equal(typeof entry.component, 'function', '第二参数必须是可渲染的组件')
})

test('取不到 connection 时不注册 section、不抛，只留一行 console.warn', () => {
  const bundle = mount()

  assert.equal(bundle.injected.length, 0, '没有 connection 就不该注册设置项')
  assert.equal(bundle.warnings.length, 1)
  assert.match(bundle.warnings[0], /\[dsh-popo-watcher\]/)
  assert.match(bundle.warnings[0], /connection/)
  // 降级发生在 require 之前：既然注定不注册，就别去碰宿主模块表。
  assert.deepEqual(bundle.requires, [])

  // 导航图标与样式是独立的：面板少一项，不影响别的功能。
  assert.equal(bundle.effects.length, 2)
})

test("require('react') 拿不到可用实现时不注册 section、不抛", () => {
  // 1) 模块表给了个空壳
  const empty = mount({ connection: connectionStub({}), react: {} })
  assert.equal(empty.injected.length, 0)
  assert.deepEqual(empty.requires, ['react'])
  assert.equal(empty.warnings.length, 1)
  assert.match(empty.warnings[0], /react/)

  // 2) require 本身抛
  const thrown = mount({ connection: connectionStub({}), reactError: new Error('种子表里没有 react') })
  assert.equal(thrown.injected.length, 0)
  assert.equal(thrown.warnings.length, 1)
  assert.match(thrown.warnings[0], /种子表里没有 react/)
})

test('注册的组件渲染出状态卡：RPC 打 /popo-watcher status，页面显示阶段与群号', async (t) => {
  const harness = createFakeReact()
  t.after(() => harness.unmount())
  const connection = connectionStub({ reply: { ok: true, value: STATUS } })
  const bundle = mount({ connection, react: harness.React })

  const [section] = bundle.injected
  harness.render(harness.createElement(section.entry.component, { close: () => {} }))
  await harness.flush()

  assert.ok(connection.calls.length >= 1, '组件挂载后必须立刻拉一次状态')
  assert.deepEqual(connection.calls[0], [RPC_CHANNEL, 'status', {}])

  const json = JSON.stringify(harness.tree())
  assert.ok(json.includes('运行中'), `渲染树里应当出现阶段「运行中」：${json.slice(0, 300)}`)
  assert.ok(json.includes('1234567'), `渲染树里应当出现群号：${json.slice(0, 300)}`)
})

test('RPC 返回失败或通道直接抛错时渲染错误卡，不冒泡', async (t) => {
  // 1) 宿主回了 ok:false
  const failed = createFakeReact()
  t.after(() => failed.unmount())
  const failedBundle = mount({
    connection: connectionStub({ reply: { ok: false, error: { message: 'boom' } } }),
    react: failed.React,
  })
  failed.render(failed.createElement(failedBundle.injected[0].entry.component, {}))
  await failed.flush()
  assertTreeHas(failed.tree(), 'boom')

  // 2) RPC 通道本身抛错
  const thrown = createFakeReact()
  t.after(() => thrown.unmount())
  const thrownBundle = mount({
    connection: connectionStub({ failure: new Error('宿主 RPC 断线') }),
    react: thrown.React,
  })
  thrown.render(thrown.createElement(thrownBundle.injected[0].entry.component, {}))
  await thrown.flush()
  assertTreeHas(thrown.tree(), '宿主 RPC 断线')
})

test('页面根挂错误边界：子树抛错时渲染失败提示与重试按钮', (t) => {
  const harness = createFakeReact()
  t.after(() => harness.unmount())
  const bundle = mount({ connection: connectionStub({}), react: harness.React })

  // 页面根元素就是 Boundary：它的 type 上必须带 getDerivedStateFromError。
  const root = bundle.injected[0].entry.component({ close: () => {} })
  assert.equal(typeof root.type.getDerivedStateFromError, 'function')

  // 换一棵一定会炸的子树渲染它：异常被吃掉，退化成提示卡。
  function Boom() {
    throw new Error('子组件炸了')
  }
  const tree = harness.render(harness.createElement(root.type, null, harness.createElement(Boom, null)))
  assertTreeHas(tree, '页面渲染失败')
  assertTreeHas(tree, '子组件炸了')
  assertTreeHas(tree, '重试')
})

test('导航图标补丁：本行换成归档图标并沿用 shell 的 class，别行不动', () => {
  const bundle = mount()
  const icon = bundle.popoCell.firstElementChild

  assert.notEqual(icon, bundle.popoIcon)
  assert.equal(icon.tagName, 'svg')
  assert.equal(icon.getAttribute('viewBox'), '0 0 20 20')
  assert.equal(icon.getAttribute('width'), '16')
  assert.equal(icon.getAttribute('height'), '16')
  assert.equal(icon.getAttribute('fill'), 'none')
  assert.equal(icon.getAttribute('class'), 'navIcon')
  assert.equal(icon.hasAttribute(ICON_ATTR), true)

  const paths = icon.childNodes.filter((node) => node.tagName === 'path')
  assert.equal(paths.length, 2)
  for (const path of paths) assert.equal(path.getAttribute('fill'), 'currentColor')
  assert.match(paths[0].getAttribute('d'), /^M15\.8659 /)
  assert.equal(paths[0].getAttribute('fill-rule'), 'evenodd')
  assert.equal(paths[0].getAttribute('clip-rule'), 'evenodd')
  assert.equal(paths[1].getAttribute('d'), 'M12.7962 12.5661V11.0832H7.20548V12.5661L12.7962 12.5661Z')

  // 「已归档会话」那一行原样不动。
  assert.equal(bundle.archivedCell.firstElementChild, bundle.archivedIcon)
  assert.equal(bundle.archivedIcon.hasAttribute(ICON_ATTR), false)

  // 观察器挂在 body 上，等设置面板重新挂载时再扫。
  assert.equal(bundle.observer.target, bundle.body)
  assert.deepEqual(bundle.observer.options, { childList: true, subtree: true })
})

test('补丁幂等且自愈：已打过的不重复替换，被换回齿轮会自动补回', () => {
  const bundle = mount()
  const patched = bundle.popoCell.firstElementChild

  bundle.observer.emit()
  assert.equal(bundle.popoCell.firstElementChild, patched, '已打过标记的行不应重复替换')

  // 模拟 React 重建了该行图标节点（齿轮回来了）：下一批变更必须自愈。
  const gear = new FakeNode('svg')
  gear.setAttribute('class', 'navIcon')
  gear.setAttribute('viewBox', '0 0 16 16')
  bundle.popoCell.replaceChild(gear, patched)
  bundle.observer.emit()

  const healed = bundle.popoCell.firstElementChild
  assert.notEqual(healed, gear)
  assert.equal(healed.hasAttribute(ICON_ATTR), true)
  assert.equal(healed.getAttribute('viewBox'), '0 0 20 20')
})

test('effect 的清理函数会断开观察器', () => {
  const bundle = mount()

  assert.deepEqual(bundle.effects.map((effect) => effect.label), [
    'dsh-popo-watcher: settings nav icon',
    'dsh-popo-watcher: settings styles',
  ])
  const [nav, styles] = bundle.effects
  assert.equal(typeof nav.dispose, 'function')
  assert.equal(typeof styles.dispose, 'function')

  nav.dispose()
  assert.equal(bundle.observer.disconnected, true)

  // 样式同样随 effect 清理：注入的 <style> 挂在 head 上，清理时移除。
  const styleTag = bundle.head.firstElementChild
  assert.equal(styleTag.tagName, 'style')
  assert.equal(styleTag.hasAttribute('data-dsh-popo-css'), true)
  styles.dispose()
  assert.equal(bundle.head.firstElementChild, null)
})

/* -------------------------------------------------------------------------- */
/* 控制台页面：控制 / 参数 / 手动发言 / 流水                                    */
/* -------------------------------------------------------------------------- */

/** 按 endpoint 分派的桩连接（每个 endpoint 可以给固定回复或函数）。 */
function routedConnection(replies = {}) {
  replies = {
    status: { ok: true, value: IDLE },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    'key.status': { ok: true, value: { configured: true, source: 'env', stored: false } },
    ...replies,
  }
  const calls = []
  return {
    calls,
    rpc: {
      async call(channel, method, params) {
        calls.push([channel, method, params])
        const reply = replies[method]
        if (typeof reply === 'function') return reply(params)
        return reply ?? { ok: true, value: {} }
      },
    },
  }
}

/** 在渲染树里按条件找节点（树是纯数据，直接递归即可）。 */
function findNodes(tree, predicate, out = []) {
  if (tree === null || tree === undefined) return out
  if (Array.isArray(tree)) {
    for (const node of tree) findNodes(node, predicate, out)
    return out
  }
  if (typeof tree !== 'object') return out
  if (predicate(tree)) out.push(tree)
  for (const child of tree.props?.children ?? []) findNodes(child, predicate, out)
  return out
}

/** 按 `data-action` / `data-field` / `data-stream` 找控件。 */
const byAction = (tree, label) => findNodes(tree, (node) => node.props?.['data-action'] === label)[0]
const byField = (tree, key) => findNodes(tree, (node) => node.props?.['data-field'] === key)[0]
const byStream = (tree, kind) => findNodes(tree, (node) => node.props?.['data-stream'] === kind)[0]
const byTab = (tree, kind) => findNodes(tree, (node) => node.props?.['data-tab'] === kind)[0]

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function clockStub() {
  let sequence = 0
  const timers = new Map()
  return {
    setInterval: (fn, delay) => { assert.ok([2000, 20000].includes(delay)); timers.set(++sequence, { fn, delay }); return sequence },
    clearInterval: id => { timers.delete(id) },
    tick: (delay = 2000) => { for (const timer of [...timers.values()]) if (timer.delay === delay) timer.fn() },
    count: delay => [...timers.values()].filter(timer => timer.delay === delay).length,
    cleared: () => timers.size === 0,
  }
}

function savingConnection(extra = {}) {
  let config = defaultConfig()
  return routedConnection({
    'config.get': () => ({ ok: true, value: { config, warnings: [], configState: 'saved' } }),
    'config.set': ({ patch }) => {
      config = applyPatch(config, patch).config
      return { ok: true, value: { config, warnings: [], configState: 'saved', written: true } }
    },
    ...extra,
  })
}

/** 挂载页面并等首轮 RPC 落地。 */
async function mountPage(t, connection, options = {}) {
  const harness = createFakeReact()
  t.after(() => harness.unmount())
  const bundle = mount({ ...options, connection, react: harness.React })
  harness.render(harness.createElement(bundle.injected[0].entry.component, { close: () => {} }))
  await harness.flush()
  return { harness, bundle }
}

test('CLI 检查只在点击时发起，防重复提交，登录后可重新检查', async (t) => {
  const request = deferred()
  const clock = clockStub()
  let response = request.promise
  const connection = savingConnection({ status: { ok: true, value: IDLE }, 'cli.check': () => response })
  const { harness } = await mountPage(t, connection, { timers: clock })
  clock.tick()
  await harness.flush()
  assert.equal(connection.calls.some(([, method]) => method === 'cli.check'), false)
  const click = byAction(harness.tree(), '检查 POPO CLI').props.onClick
  click()
  click()
  assert.equal(byAction(harness.tree(), '检查 POPO CLI').props.disabled, true)
  assertTreeHas(harness.tree(), '检查中…')
  assert.equal(connection.calls.filter(([, method]) => method === 'cli.check').length, 1)
  request.resolve({ ok: true, value: { healthy: false, message: '请在终端运行 popo-cli auth login，完成浏览器登录后重新检查。' } })
  await harness.flush()
  assertTreeHas(harness.tree(), 'popo-cli auth login')
  assert.equal(byAction(harness.tree(), '检查 POPO CLI').props.disabled, false)
  byTab(harness.tree(), 'settings').props.onClick()
  byTab(harness.tree(), 'overview').props.onClick()
  assertTreeHas(harness.tree(), 'popo-cli auth login')
  response = { ok: true, value: { healthy: true, message: 'POPO CLI 可正常启动，登录状态正常。' } }
  byAction(harness.tree(), '检查 POPO CLI').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '登录状态正常')
  assert.equal(JSON.stringify(harness.tree()).includes('popo-cli auth login'), false)
  assert.deepEqual(connection.calls.filter(([, method]) => method === 'cli.check'), [[RPC_CHANNEL, 'cli.check', {}], [RPC_CHANNEL, 'cli.check', {}]])
  assert.equal(connection.calls.some(([, method]) => ['start', 'send.now', 'config.set', 'messages'].includes(method)), false)
})

test('CLI 检查拒绝无效成功结果，RPC 故障可重试，卸载后忽略迟到结果', async (t) => {
  let response = { ok: true, value: {} }
  const connection = savingConnection({ 'cli.check': () => response })
  const { harness } = await mountPage(t, connection)
  byAction(harness.tree(), '检查 POPO CLI').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '宿主未返回有效检查结果')
  response = { ok: false, error: { message: '连接断开' } }
  byAction(harness.tree(), '检查 POPO CLI').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '检查失败：连接断开')
  assert.equal(byAction(harness.tree(), '检查 POPO CLI').props.disabled, false)
  const pending = deferred()
  response = pending.promise
  byAction(harness.tree(), '检查 POPO CLI').props.onClick()
  harness.unmount()
  const updates = harness.updates()
  pending.resolve({ ok: true, value: { healthy: true, message: 'late' } })
  await harness.flush()
  assert.equal(harness.updates(), updates)
})

test('静音时采集失败也显示原因，恢复采集后移除故障提示', async (t) => {
  const clock = clockStub()
  let failed = true
  const connection = savingConnection({ status: () => ({ ok: true, value: {
    ...STATUS, window: { ...STATUS.window, stopped: true },
    poll: { ...STATUS.poll, consecutiveFailures: failed ? 2 : 0, lastError: failed ? '请运行 popo-cli auth login' : null },
  } }) })
  const { harness } = await mountPage(t, connection, { timers: clock })
  assertTreeHas(harness.tree(), '已静音')
  assertTreeHas(harness.tree(), '采集失败')
  const alerts = findNodes(harness.tree(), node => node.props?.role === 'alert')
  assert.ok(alerts.some(node => JSON.stringify(node).includes('popo-cli auth login')))
  failed = false
  clock.tick()
  await harness.flush()
  assert.equal(JSON.stringify(harness.tree()).includes('popo-cli auth login'), false)
  assert.equal(JSON.stringify(harness.tree()).includes('采集失败'), false)
})

test('控制卡：单个监控开关完成开启、关闭、再开启，按本次时长开窗', async (t) => {
  let status = IDLE
  const connection = routedConnection({
    status: () => ({ ok: true, value: status }),
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    start: () => {
      status = STATUS
      return { ok: true, value: { window: { endsAt: '2026-09-22 21:00:00' }, polling: true, opening: { ok: true, dryRun: false } } }
    },
    stop: () => {
      status = { ...IDLE, window: { ...STATUS.window, stopped: true } }
      return { ok: true, value: { mode: 'stop', stoppedAt: 'now' } }
    },
  })
  const { harness } = await mountPage(t, connection)

  const hours = byField(harness.tree(), 'hours')
  assert.equal(hours.props.value, '24', '使用配置里的默认 24 小时')
  assert.equal(byAction(harness.tree(), '开始').props['aria-checked'], false)

  byAction(harness.tree(), '开始').props.onClick()
  await harness.flush()

  const call = connection.calls.find(([, method]) => method === 'start')
  assert.deepEqual(call, [RPC_CHANNEL, 'start', { hours: 24 }])
  assertTreeHas(harness.tree(), '窗口到 2026-09-22 21:00:00')
  assertTreeHas(harness.tree(), '开场白已发')
  assert.equal(byAction(harness.tree(), '开始'), undefined)
  assert.equal(byAction(harness.tree(), '停止').props['aria-checked'], true)
  byAction(harness.tree(), '停止').props.onClick()
  await harness.flush()
  assert.equal(byAction(harness.tree(), '停止'), undefined)
  assert.equal(byAction(harness.tree(), '开始').props['aria-checked'], false)
  assertTreeHas(harness.tree(), '停止成功')
  byField(harness.tree(), 'hours').props.onChange({ target: { value: '6' } })
  byAction(harness.tree(), '开始').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.filter(([, method]) => ['start', 'stop'].includes(method)), [
    [RPC_CHANNEL, 'start', { hours: 24 }],
    [RPC_CHANNEL, 'stop', { mode: 'stop', reason: '设置页手动停止' }],
    [RPC_CHANNEL, 'start', { hours: 6 }],
  ])
  assert.equal(byAction(harness.tree(), '停止').props.disabled, false)
})

test('控制卡：开场白被守卫拦住时如实说出来，不假装发成功', async (t) => {
  const connection = routedConnection({
    status: { ok: true, value: IDLE },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    start: { ok: true, value: { window: { endsAt: '21:00:00' }, polling: true, opening: { ok: false, reason: 'opening already sent' } } },
  })
  const { harness } = await mountPage(t, connection)

  byAction(harness.tree(), '开始').props.onClick()
  await harness.flush()

  assertTreeHas(harness.tree(), '开场白未发')
  assertTreeHas(harness.tree(), 'opening already sent')
})

test('监控成功后采集失败：开关关闭、保留错误，移除旧成功提示和倒计时，再开启可恢复', async (t) => {
  const clock = clockStub()
  let status = IDLE
  const connection = savingConnection({
    status: () => ({ ok: true, value: status }),
    start: () => { status = STATUS; return { ok: true, value: { window: STATUS.window, polling: true } } },
  })
  const { harness } = await mountPage(t, connection, { timers: clock })
  byAction(harness.tree(), '开始').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '窗口已开启')
  status = { ...STATUS, phase: 'degraded', window: { ...STATUS.window, stopped: true, collectionError: 'popo-cli 没有输出（exit=0）' }, poll: { ...STATUS.poll, running: false, consecutiveFailures: 1, lastError: 'popo-cli 没有输出（exit=0）' } }
  clock.tick()
  await harness.flush()
  const tree = harness.tree()
  assert.equal(byAction(tree, '开始').props['aria-checked'], false)
  assert.equal(byAction(tree, '开始').props.disabled, false)
  assertTreeHas(tree, '采集异常，已停止')
  assertTreeHas(tree, '采集失败，已停止')
  assertTreeHas(tree, 'popo-cli 没有输出（exit=0）')
  assert.equal(/窗口已开启|正在重试|剩余 30/.test(JSON.stringify(tree)), false)
  byAction(tree, '开始').props.onClick()
  await harness.flush()
  assert.equal(byAction(harness.tree(), '停止').props['aria-checked'], true)
  assert.equal(JSON.stringify(harness.tree()).includes('popo-cli 没有输出'), false)
})

test('首轮不可重试故障的 start 回包立即刷新停止状态，不留下开启成功提示', async (t) => {
  let status = IDLE
  const connection = savingConnection({
    status: () => ({ ok: true, value: status }),
    start: () => {
      status = { ...IDLE, window: { ...STATUS.window, stopped: true, collectionError: '认证失效' } }
      return { ok: false, error: { message: '采集失败，已自动停止：认证失效' } }
    },
  })
  const { harness } = await mountPage(t, connection)
  byAction(harness.tree(), '开始').props.onClick()
  await harness.flush()
  assert.equal(byAction(harness.tree(), '开始').props['aria-checked'], false)
  assertTreeHas(harness.tree(), '采集异常，已停止')
  assertTreeHas(harness.tree(), '开始失败：采集失败，已自动停止：认证失效')
  assert.equal(JSON.stringify(harness.tree()).includes('窗口已开启'), false)
})

test('首轮进入重试时开关保持开启，显示次数与时间；恢复后清除错误和旧重试提示', async (t) => {
  const clock = clockStub()
  let status = IDLE
  const connection = savingConnection({
    status: () => ({ ok: true, value: status }),
    start: () => {
      status = {
        ...STATUS, phase: 'degraded',
        poll: { ...STATUS.poll, recovering: true, failureLimit: 5, consecutiveFailures: 1, lastError: 'FABRIC_NETWORK_ERROR', nextRetryAt: 1791619240000 },
      }
      return { ok: true, value: { window: STATUS.window, polling: true, recovering: true, opening: { ok: false, reason: '首次采集失败，本窗口不补发开场白' } } }
    },
  })
  const { harness } = await mountPage(t, connection, { timers: clock })
  byAction(harness.tree(), '开始').props.onClick()
  await harness.flush()
  assert.equal(byAction(harness.tree(), '停止').props['aria-checked'], true)
  assert.equal(byAction(harness.tree(), '停止').props.disabled, false)
  assertTreeHas(harness.tree(), '采集重试中（1/5）')
  assert.equal(byAction(harness.tree(), '停止').props['data-tone'], 'ok', '重试期间仍开启，开关保持绿色')
  assertTreeHas(harness.tree(), '下次重试：')
  assertTreeHas(harness.tree(), '监控已开启，采集正在重试')
  assertTreeHas(harness.tree(), '自动发言暂停')
  assert.equal(JSON.stringify(harness.tree()).includes('采集循环已启动'), false)
  status = { ...STATUS, poll: { ...STATUS.poll, recovering: false, failureLimit: 5, consecutiveFailures: 0, nextRetryAt: null, lastError: null } }
  clock.tick()
  await harness.flush()
  assertTreeHas(harness.tree(), '监控中')
  assert.equal(byAction(harness.tree(), '停止').props['aria-checked'], true)
  assert.equal(/FABRIC_NETWORK_ERROR|采集重试中|采集正在重试|下次重试/.test(JSON.stringify(harness.tree())), false)
})

test('重启后的旧停止错误仅在诊断中显示历史时间，不冒充当前采集异常或自动重试', async (t) => {
  const error = 'popo-cli 返回失败：FABRIC_NETWORK_ERROR（exit=0）'
  for (const legacy of [false, true]) {
    const clock = clockStub()
    const status = {
      ...IDLE, phase: legacy ? 'degraded' : 'idle',
      window: { ...STATUS.window, stopped: true, stoppedAt: '2026-10-09 23:11:49', collectionError: error, collectionFailures: 5 },
      poll: { ...IDLE.poll, lastError: null, consecutiveFailures: legacy ? 5 : 0, recovering: false, failureLimit: 5, nextRetryAt: null },
      degraded: { active: legacy, reason: legacy ? error : null, since: null },
    }
    const connection = savingConnection({ status: { ok: true, value: status } })
    const { harness } = await mountPage(t, connection, { timers: clock })
    clock.tick()
    await harness.flush()
    const tree = harness.tree()
    const summary = findNodes(tree, node => node.props?.['aria-label'] === '运行状态')[0]
    const details = findNodes(tree, node => node.props?.['aria-label'] === '运行详情与诊断')[0]
    assertTreeHas(summary, '已停止')
    assert.equal(JSON.stringify(summary).includes('FABRIC_NETWORK_ERROR'), false)
    assertTreeHas(details, '上次采集故障（历史记录，2026-10-09 23:11:49）')
    assertTreeHas(details, error)
    assert.equal(findNodes(tree, node => node.props?.role === 'alert').length, 0)
    assert.equal(byAction(tree, '开始').props['aria-checked'], false)
    assert.equal(/采集失败，已停止|采集异常，已停止|连续失败 5 次，已停止|正在重试/.test(JSON.stringify(tree)), false)
    assert.equal(connection.calls.some(([, endpoint]) => ['start', 'cli.check', 'judge.now', 'send.now'].includes(endpoint)), false)
  }
})

test('重试请求执行中显示正在重试；第五次失败关闭开关且保留错误', async (t) => {
  const clock = clockStub()
  let status = {
    ...STATUS, phase: 'degraded',
    poll: { ...STATUS.poll, recovering: true, failureLimit: 5, consecutiveFailures: 4, lastError: 'FABRIC_NETWORK_ERROR', nextRetryAt: null },
  }
  const connection = savingConnection({ status: () => ({ ok: true, value: status }) })
  const { harness } = await mountPage(t, connection, { timers: clock })
  assertTreeHas(harness.tree(), '采集重试中（4/5）')
  assertTreeHas(harness.tree(), '正在重试…')
  assert.equal(findNodes(harness.tree(), node => node.props?.role === 'switch' && node.props['aria-label'] === '监控').length, 1)
  status = {
    ...status, window: { ...STATUS.window, stopped: true, collectionError: 'FABRIC_NETWORK_ERROR' },
    poll: { ...status.poll, running: false, recovering: false, consecutiveFailures: 5 },
  }
  clock.tick()
  await harness.flush()
  assertTreeHas(harness.tree(), '连续失败 5 次，已停止')
  assertTreeHas(harness.tree(), 'FABRIC_NETWORK_ERROR')
  assert.equal(byAction(harness.tree(), '开始').props['aria-checked'], false)
  assert.equal(byAction(harness.tree(), '开始').props.disabled, false)
  assert.equal(/下次重试|采集重试中|正在重试/.test(JSON.stringify(harness.tree())), false)
})

test('控制卡：启停请求期间防重复提交，失败后保留原动作并允许重试', async (t) => {
  for (const [label, endpoint, status] of [['开始', 'start', IDLE], ['停止', 'stop', STATUS]]) {
    const pending = deferred()
    const connection = routedConnection({ status: { ok: true, value: status }, [endpoint]: () => pending.promise })
    const { harness } = await mountPage(t, connection)
    const click = byAction(harness.tree(), label).props.onClick
    click()
    click()
    byAction(harness.tree(), label).props.onClick()
    assert.equal(connection.calls.filter(([, method]) => method === endpoint).length, 1)
    assert.equal(byAction(harness.tree(), label).props.disabled, true)
    assert.equal(byAction(harness.tree(), label).props['aria-checked'], endpoint === 'stop')
    assert.equal(byAction(harness.tree(), label).props['aria-busy'], true)
    assertTreeHas(harness.tree(), `${label}中…`)
    assert.equal(JSON.stringify(harness.tree()).includes(`${label}成功`), false)
    pending.resolve({ ok: false, error: { message: '数据根不可用' } })
    await harness.flush()
    assertTreeHas(harness.tree(), `${label}失败：数据根不可用`)
    assert.equal(byAction(harness.tree(), label).props.disabled, false)
    assert.equal(byAction(harness.tree(), label).props['aria-checked'], endpoint === 'stop')
    assert.equal(byAction(harness.tree(), label).props['aria-busy'], false)
    byAction(harness.tree(), label).props.onClick()
    await harness.flush()
    assert.equal(connection.calls.filter(([, method]) => method === endpoint).length, 2)
  }
})

test('控制卡：当前状态决定唯一开关，历史开始时间不生成重开或静音入口', async (t) => {
  const expired = { ...IDLE, window: { ...STATUS.window, active: false, remainingSec: 0 } }
  const cases = [
    [IDLE, '开始'],
    [{ ...IDLE, window: { ...STATUS.window, stopped: true } }, '开始'],
    [expired, '开始'],
    [STATUS, '停止'],
    [{ ...STATUS, phase: 'idle', window: { ...STATUS.window, stopped: true } }, '停止'],
    [{ ...expired, poll: STATUS.poll }, '停止'],
    [{ ...STATUS, poll: { running: false } }, '停止'],
    [{ ...STATUS, phase: 'degraded' }, '停止'],
  ]
  for (const [value, label] of cases) {
    const { harness } = await mountPage(t, routedConnection({ status: { ok: true, value } }))
    const buttons = findNodes(harness.tree(), node => node.props?.role === 'switch' && node.props['aria-label'] === '监控')
    assert.equal(buttons.length, 1)
    assert.equal(buttons[0].props['data-action'], label)
    assert.equal(buttons[0].props['aria-label'], '监控')
    assert.equal(buttons[0].props['aria-checked'], label === '停止')
    assert.equal(buttons[0].props['data-unknown'], false)
    assert.equal(buttons[0].props.disabled, false)
    assert.equal(JSON.stringify(harness.tree()).includes('重新开始'), false)
    assert.equal(JSON.stringify(harness.tree()).includes('静音只暂停'), false)
    assertTreeHas(harness.tree(), '停止会同时停止采集和自动发言')
  }
})

test('控制卡：加载和卸载期间不能执行，状态错误仍可尝试停止', async (t) => {
  for (const [reply, label, disabled] of [
    [deferred().promise, '开始', true],
    [{ ok: true, value: { ...STATUS, phase: 'disposed' } }, '停止', true],
    [{ ok: false, error: { message: 'offline' } }, '停止', false],
  ]) {
    const connection = routedConnection({ status: () => reply })
    const { harness } = await mountPage(t, connection)
    const button = byAction(harness.tree(), label)
    assert.equal(button.props.disabled, disabled)
    assert.equal(button.props.role, 'switch')
    assert.equal(button.props['aria-checked'], false, '未知或卸载状态不显示已经开启')
    assert.equal(button.props['data-unknown'], reply?.ok === false)
    button.props.onClick()
    await harness.flush()
    const calls = connection.calls.filter(([, method]) => ['start', 'stop'].includes(method))
    assert.deepEqual(calls, disabled ? [] : [[RPC_CHANNEL, 'stop', { mode: 'stop', reason: '设置页手动停止' }]])
  }
})

test('控制卡：动作后的刷新排队完成前保持禁用，旧状态不能导致重复开窗', async (t) => {
  const clock = clockStub()
  const old = deferred()
  const fresh = deferred()
  let reads = 0
  const connection = routedConnection({ status: () => ++reads === 1 ? { ok: true, value: IDLE } : reads === 2 ? old.promise : fresh.promise })
  const { harness } = await mountPage(t, connection, { timers: clock })
  clock.tick()
  const click = byAction(harness.tree(), '开始').props.onClick
  click()
  await harness.flush()
  assert.equal(byAction(harness.tree(), '开始').props.disabled, true)
  old.resolve({ ok: true, value: IDLE })
  await harness.flush()
  assert.equal(reads, 3)
  assert.equal(byAction(harness.tree(), '开始').props.disabled, true)
  click()
  byAction(harness.tree(), '开始').props.onClick()
  assert.equal(connection.calls.filter(([, method]) => method === 'start').length, 1)
  fresh.resolve({ ok: true, value: STATUS })
  await harness.flush()
  assert.equal(byAction(harness.tree(), '开始'), undefined)
  assert.equal(byAction(harness.tree(), '停止').props.disabled, false)
})

test('控制卡：慢启停完成或失败后恢复焦点，不抢用户已经移动的焦点', async (t) => {
  for (const [failed, moved] of [[false, false], [true, false], [false, true], [true, true]]) {
    const pending = deferred()
    const connection = routedConnection({ start: () => pending.promise })
    const { harness, bundle } = await mountPage(t, connection)
    const button = { isConnected: true, focus() { bundle.document.activeElement = this } }
    bundle.document.activeElement = button
    byAction(harness.tree(), '开始').props.onClick({ currentTarget: button })
    // 浏览器禁用按钮时移焦到 body；用户也可能在等待期间主动选中其它控件。
    const nextFocus = moved ? {} : bundle.document.body
    bundle.document.activeElement = nextFocus
    pending.resolve(failed ? { ok: false, error: { message: 'offline' } } : { ok: true, value: {} })
    await harness.flush()
    assert.equal(bundle.document.activeElement, moved ? nextFocus : button)
  }
})

test('控制卡：无效本次时长禁止开始，修正后恢复', async (t) => {
  const connection = routedConnection()
  const { harness } = await mountPage(t, connection)
  for (const value of ['', '0', '721', 'bad']) {
    byField(harness.tree(), 'hours').props.onChange({ target: { value } })
    assert.equal(byAction(harness.tree(), '开始').props.disabled, true)
    byAction(harness.tree(), '开始').props.onClick()
  }
  assert.equal(connection.calls.some(([, method]) => method === 'start'), false)
  byField(harness.tree(), 'hours').props.onChange({ target: { value: '1' } })
  assert.equal(byAction(harness.tree(), '开始').props.disabled, false)
})

test('参数卡：读回配置 → 改字段 → 保存时只送 patch', async (t) => {
  const connection = routedConnection({
    status: { ok: true, value: IDLE },
    'config.get': {
      ok: true,
      value: {
        config: {
          group: '1234567',
          intervalSec: 20,
          windowHours: 24,
          minGapSec: 20,
          maxChars: 50,
          hardMaxChars: 120,
          dryRun: false,
          judge: { enabled: true },
          hourlyCap: { enabled: false, max: 6 },
          opening: { enabled: true, text: '大家好' },
        },
        warnings: ['intervalSec 需在 5..600，已用默认值 20'],
      },
    },
    'config.set': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved', written: true } },
  })
  const { harness } = await mountPage(t, connection)

  assert.deepEqual(connection.calls[1], [RPC_CHANNEL, 'config.get', {}], '挂载后应当读一次配置')
  assertTreeHas(harness.tree(), 'intervalSec 需在 5..600')
  assert.equal(byField(harness.tree(), 'group').props.value, '1234567')
  assert.equal(byField(harness.tree(), 'dryRun').props.checked, false)

  byField(harness.tree(), 'group').props.onChange({ target: { value: '1234568' } })
  byField(harness.tree(), 'dryRun').props.onChange({ target: { checked: true } })
  byField(harness.tree(), 'intervalSec').props.onChange({ target: { value: '30' } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()

  const saved = connection.calls.find(([, method]) => method === 'config.set')
  assert.equal(saved[0], RPC_CHANNEL)
  assert.equal(saved[2].patch.group, '1234568')
  assert.equal(saved[2].patch.dryRun, true)
  assert.equal(saved[2].patch.intervalSec, 30)
  assert.equal(Object.hasOwn(saved[2].patch, 'judge'), false, '未修改判读开关，不提交 judge 对象')
  assertTreeHas(harness.tree(), '已保存')
})

test('参数卡：数字清空或越界时禁止提交，而不是静默保留旧值', async (t) => {
  const connection = routedConnection()
  const { harness } = await mountPage(t, connection)
  for (const value of ['', '4', '601', 'NaN']) {
    byField(harness.tree(), 'intervalSec').props.onChange({ target: { value } })
    assert.equal(byAction(harness.tree(), '保存').props.disabled, true)
    assert.equal(byField(harness.tree(), 'intervalSec').props['aria-invalid'], true)
    byAction(harness.tree(), '保存').props.onClick()
    await harness.flush()
  }
  assert.equal(connection.calls.some(([, method]) => method === 'config.set'), false)
})

test('手动发言：空文本禁用发送，正文原样提交，发送后显示 msgId', async (t) => {
  const connection = routedConnection({
    status: { ok: true, value: STATUS },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    'send.now': { ok: true, value: { msgId: 'mid-9', dryRun: false, warnings: [] } },
  })
  const { harness } = await mountPage(t, connection)

  assert.equal(byAction(harness.tree(), '发送').props.disabled, true, '空文本不能发')
  byField(harness.tree(), 'manual-text').props.onChange({ target: { value: '  手动一句  ' } })
  byAction(harness.tree(), '发送').props.onClick()
  await harness.flush()

  const call = connection.calls.find(([, method]) => method === 'send.now')
  assert.deepEqual(call, [RPC_CHANNEL, 'send.now', { text: '  手动一句  ' }])
  assertTreeHas(harness.tree(), 'mid-9')
})

test('已发送但记账失败有独立提示，持久化故障不冒充采集故障', async (t) => {
  const status = { ...IDLE, phase: 'degraded', persistence: { ok: false, error: 'fixture 写盘失败' },
    window: { ...IDLE.window, stopped: true }, poll: { ...IDLE.poll, running: false } }
  const connection = savingConnection({ status: { ok: true, value: status },
    'send.now': { ok: true, value: { msgId: 'confirmed', stateWritten: false, warnings: [] } } })
  const { harness } = await mountPage(t, connection)
  assertTreeHas(harness.tree(), '记账或存储异常，已暂停')
  byField(harness.tree(), 'manual-text').props.onChange({ target: { value: '用户明确发送' } })
  byAction(harness.tree(), '发送').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '已发出，记账失败')
  assert.equal(byField(harness.tree(), 'manual-text').props.value, '')
})

test('手动发送不依赖窗口、采集身份、传输快照或演练设置', async (t) => {
  const values = [
    { ...IDLE, selfUid: '', transport: { ok: false }, dryRun: true },
    { ...STATUS, window: { ...STATUS.window, stopped: true } },
    { ...IDLE, window: { ...STATUS.window, active: false, stopped: true } },
    { ...IDLE, window: { active: false, remainingSec: -1 } },
  ]
  for (const value of values) {
    const connection = savingConnection({ status: { ok: true, value }, 'send.now': { ok: true, value: { msgId: 'manual', dryRun: false } } })
    const { harness } = await mountPage(t, connection)
    byField(harness.tree(), 'manual-text').props.onChange({ target: { value: '  原样手动正文  ' } })
    assert.equal(byAction(harness.tree(), '发送').props.disabled, false)
    assertTreeHas(harness.tree(), '不受自动规则或演练模式影响')
    byAction(harness.tree(), '发送').props.onClick()
    await harness.flush()
    assert.deepEqual(connection.calls.find(([, method]) => method === 'send.now'), [RPC_CHANNEL, 'send.now', { text: '  原样手动正文  ' }])
    assert.equal(connection.calls.some(([, method]) => ['start', 'judge.now', 'config.set'].includes(method)), false)
  }
})

test('手动发送使用生效目标，未保存的群草稿和无效自动参数不影响发送', async (t) => {
  let config = defaultConfig()
  const destinations = []
  const connection = savingConnection({
    status: () => ({ ok: true, value: { ...IDLE, group: config.group } }),
    'config.get': () => ({ ok: true, value: { config, configState: 'saved' } }),
    'config.set': ({ patch }) => { config = applyPatch(config, patch).config; return { ok: true, value: { config, written: true } } },
    'send.now': () => { destinations.push(config.group); return { ok: true, value: { msgId: 'manual', dryRun: false } } },
  })
  const { harness } = await mountPage(t, connection)
  byField(harness.tree(), 'group').props.onChange({ target: { value: '1234568' } })
  byField(harness.tree(), 'hardMaxChars').props.onChange({ target: { value: '' } })
  byField(harness.tree(), 'manual-text').props.onChange({ target: { value: '保持原目标' } })
  assert.equal(byAction(harness.tree(), '发送').props.disabled, false)
  byAction(harness.tree(), '发送').props.onClick()
  await harness.flush()
  assert.deepEqual(destinations, ['1234567'])
  byField(harness.tree(), 'hardMaxChars').props.onChange({ target: { value: '120' } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  byField(harness.tree(), 'manual-text').props.onChange({ target: { value: '使用已保存的新目标' } })
  byAction(harness.tree(), '发送').props.onClick()
  await harness.flush()
  assert.deepEqual(destinations, ['1234567', '1234568'])
})

test('各页签仅保留标题，无目标群提示或悬空描述，手动发送仍校验生效群', async (t) => {
  for (const [group, statusReady, configReady] of [
    ['1234567', true, true],
    ['', true, true],
    ['1234567', false, true],
    ['', false, false],
  ]) {
    const connection = routedConnection({
      status: statusReady
        ? { ok: true, value: { ...IDLE, group } }
        : { ok: false, error: { message: '状态暂不可用' } },
      'config.get': configReady
        ? { ok: true, value: { config: { ...defaultConfig(), group }, configState: 'saved' } }
        : { ok: false, error: { message: '配置暂不可用' } },
    })
    const { harness } = await mountPage(t, connection)
    for (const tab of ['overview', 'settings', 'records']) {
      byTab(harness.tree(), tab).props.onClick()
      await harness.flush()
      const header = findNodes(harness.tree(), node => node.props?.className?.includes('dsh-popo-page-head'))[0]
      assert.equal(header.props.children.length, 1)
      assertTreeHas(header, LABEL)
      assert.equal(findNodes(harness.tree(), node => node.props?.id === 'popo-target-group'
        || node.props?.['aria-describedby']?.split(' ').includes('popo-target-group')).length, 0)
    }
    byField(harness.tree(), 'manual-text').props.onChange({ target: { value: '校验生效目标' } })
    assert.equal(byAction(harness.tree(), '发送').props.disabled, !group)
    const manual = findNodes(harness.tree(), node => node.props?.['aria-label'] === '手动发言')[0]
    assertTreeHas(manual, '消息内容')
    assert.equal(JSON.stringify(manual).includes('1234567'), false, '手动区不绘制群号')
    assert.equal(connection.calls.some(([, endpoint]) => endpoint === 'send.now'), false)
  }
})

test('手动请求防重复提交，失败保留草稿并允许立即重试', async (t) => {
  const pending = deferred()
  let response = pending.promise
  const connection = savingConnection({ status: { ok: false, error: { message: '状态读取失败' } }, 'send.now': () => response })
  const { harness } = await mountPage(t, connection)
  byField(harness.tree(), 'manual-text').props.onChange({ target: { value: '请保留草稿' } })
  const click = byAction(harness.tree(), '发送').props.onClick
  click()
  click()
  assert.equal(byAction(harness.tree(), '发送').props.disabled, true)
  assert.equal(connection.calls.filter(([, method]) => method === 'send.now').length, 1)
  pending.resolve({ ok: false, error: { code: 'popo-watcher/error', message: 'popo-cli auth login', details: {} } })
  await harness.flush()
  assert.equal(byField(harness.tree(), 'manual-text').props.value, '请保留草稿')
  assert.equal(byAction(harness.tree(), '发送').props.disabled, false)
  assertTreeHas(harness.tree(), 'popo-cli auth login')
  response = { ok: true, value: { msgId: 'retry-on-click', dryRun: false } }
  byAction(harness.tree(), '发送').props.onClick()
  await harness.flush()
  assert.equal(connection.calls.filter(([, method]) => method === 'send.now').length, 2)
  assert.equal(byField(harness.tree(), 'manual-text').props.value, '')
})

test('立刻判一轮：走 judge.now 并把结论/挡板写出来', async (t) => {
  const connection = routedConnection({
    status: { ok: true, value: STATUS },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    'key.status': { ok: true, value: { configured: false, source: 'none', stored: false } },
    'judge.now': {
      ok: true,
      value: { mode: 'round', view: { verdict: 'blocked', blockers: ['noOpening'], nextStep: 'No opening in the last messages.' } },
    },
  })
  const { harness } = await mountPage(t, connection)

  byAction(harness.tree(), '仅判读一次').props.onClick()
  await harness.flush()

  assert.deepEqual(connection.calls.find(([, method]) => method === 'judge.now'), [RPC_CHANNEL, 'judge.now', {}])
  assertTreeHas(harness.tree(), '判读结论：blocked')
  assertTreeHas(harness.tree(), 'noOpening')
})

test('key 卡：显示来源、保存后清空明文、清除后回报剩余来源', async (t) => {
  const secret = 'ts_live_abcdef123456'
  const connection = routedConnection({
    status: { ok: true, value: STATUS },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    'key.status': { ok: true, value: { configured: true, source: 'user-env', stored: false } },
    'key.set': { ok: true, value: { configured: true, source: 'file' } },
    'key.clear': { ok: true, value: { configured: true, source: 'env', stored: false } },
  })
  const { harness } = await mountPage(t, connection)

  // 挂载后读一次状态；卡片上写来源，不写 key。
  assert.deepEqual(connection.calls.find(([, method]) => method === 'key.status'), [RPC_CHANNEL, 'key.status', {}])
  assertTreeHas(harness.tree(), '来源：用户环境变量')

  // 空输入时保存按钮禁用
  assert.equal(byAction(harness.tree(), '保存 key').props.disabled, true)

  byField(harness.tree(), 'judge-key').props.onChange({ target: { value: secret } })
  byAction(harness.tree(), '保存 key').props.onClick()
  await harness.flush()

  const saved = connection.calls.find(([, method]) => method === 'key.set')
  assert.deepEqual(saved, [RPC_CHANNEL, 'key.set', { key: secret }])
  assertTreeHas(harness.tree(), '已保存（页面不会再显示它）')
  assert.equal(byField(harness.tree(), 'judge-key').props.value, '', '保存后输入框必须清空，页面上不留明文')
  assert.equal(JSON.stringify(harness.tree()).includes(secret), false, '保存后渲染树里不该再出现 key')

  byAction(harness.tree(), '清除 key').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.find(([, method]) => method === 'key.clear'), [RPC_CHANNEL, 'key.clear', {}])
  assertTreeHas(harness.tree(), '仍配置了环境变量来源')
})

test('key 卡：未配置时清除按钮禁用，保存失败如实显示', async (t) => {
  const connection = routedConnection({
    status: { ok: true, value: STATUS },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    'key.status': { ok: true, value: { configured: false, source: 'none', stored: false } },
    'key.set': { ok: false, error: { message: 'key 不合法（空串、含换行，或超过 512 字）' } },
  })
  const { harness } = await mountPage(t, connection)

  assertTreeHas(harness.tree(), '未配置')
  assert.equal(byAction(harness.tree(), '清除 key').props.disabled, true)

  byField(harness.tree(), 'judge-key').props.onChange({ target: { value: 'x' } })
  byAction(harness.tree(), '保存 key').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '保存失败：key 不合法')
})

test('迁移卡：把源目录透给 importLegacy，并区分"已补/跳过"', async (t) => {
  const connection = routedConnection({
    status: { ok: true, value: STATUS },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    'key.status': { ok: true, value: { configured: false, source: 'none', stored: false } },
    importLegacy: {
      ok: true,
      value: {
        group: '1234567',
        from: 'D:/legacy',
        imported: { state: { sentMessages: 2 }, poller: { lastSeenMsgTime: 1 } },
        skipped: { messages: '目标已有文件，未覆盖' },
      },
    },
  })
  const { harness } = await mountPage(t, connection)

  assert.equal(byField(harness.tree(), 'legacy-from').props.value, '', '必须显式填写历史数据目录')
  byField(harness.tree(), 'legacy-from').props.onChange({ target: { value: 'D:/legacy' } })
  byAction(harness.tree(), '导入历史').props.onClick()
  await harness.flush()

  assert.deepEqual(connection.calls.find(([, method]) => method === 'importLegacy'), [RPC_CHANNEL, 'importLegacy', { from: 'D:/legacy' }])
  assertTreeHas(harness.tree(), '已补：state、poller')
  assertTreeHas(harness.tree(), '跳过：messages（目标已有文件，未覆盖）')
  assertTreeHas(harness.tree(), '导入不会开始监控')
})

test('迁移卡：失败如实显示，且不假装导入成功', async (t) => {
  const connection = routedConnection({
    status: { ok: true, value: STATUS },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    'key.status': { ok: true, value: { configured: false, source: 'none', stored: false } },
    importLegacy: { ok: false, error: { message: '源目录里没有可读的 state.json：D:/nope' } },
  })
  const { harness } = await mountPage(t, connection)

  byField(harness.tree(), 'legacy-from').props.onChange({ target: { value: 'D:/nope' } })
  byAction(harness.tree(), '导入历史').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '导入失败：源目录里没有可读的 state.json')
})

test('流水卡：进入即拉群消息，其它记录按需读取，并把行渲染出来', async (t) => {  const connection = routedConnection({
    status: { ok: true, value: STATUS },
    'config.get': { ok: true, value: { config: defaultConfig(), warnings: [], configState: 'saved' } },
    messages: { ok: true, value: { rows: [{ time: '2026-09-22 09:00:00', name: '张三', content: '缓存清了还是慢' }], limit: 30, group: '1234567', fetchedAt: '2026-10-10 12:00:00' } },
    sends: { ok: true, value: { rows: [{ at: '2026-09-22 09:10:00', opening: true, content: '大家好' }], limit: 30 } },
    log: { ok: false, error: { message: '数据目录不可用' } },
  })
  const { harness } = await mountPage(t, connection)

  assertTreeHas(harness.tree(), '尚未加载群消息')
  byTab(harness.tree(), 'records').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.find(([, method]) => method === 'messages'), [RPC_CHANNEL, 'messages', { limit: 30 }])
  assertTreeHas(harness.tree(), '张三：缓存清了还是慢')

  byStream(harness.tree(), 'sends').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '[开场白] 大家好')

  byStream(harness.tree(), 'log').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '读取失败：数据目录不可用')
})


test('群消息每 20 秒更新、请求单飞，切走停止，停止监控也可查询', async (t) => {
  const clock = clockStub()
  const pending = deferred()
  let reads = 0
  const response = { ok: true, value: { group: '1234567', fetchedAt: '2026-10-10 12:00:00', rows: [
    { t_msg: 2, time: '2026-10-10 11:59:00', content: '最新一条' },
    { t_msg: 1, time: '2026-10-09 10:00:00', content: '较早一条' },
  ] } }
  const connection = routedConnection({ messages: () => ++reads === 1 ? pending.promise : response })
  const { harness, bundle } = await mountPage(t, connection, { timers: clock })
  assert.equal(reads, 0)
  byTab(harness.tree(), 'records').props.onClick()
  assert.equal(reads, 1)
  assert.equal(clock.count(20000), 1)
  clock.tick(20000)
  byAction(harness.tree(), '刷新记录').props.onClick()
  assert.equal(reads, 1, '自动与手动请求共享锁')
  pending.resolve(response)
  await harness.flush()
  assertTreeHas(harness.tree(), '最近成功获取：2026-10-10 12:00:00')
  assertTreeHas(harness.tree(), '最新消息：2026-10-10 11:59:00')
  const rows = findNodes(harness.tree(), node => node.props?.className === 'dsh-popo-line')
  assertTreeHas(rows[0], '最新一条')
  clock.tick(20000)
  await harness.flush()
  assert.equal(reads, 2)
  bundle.document.hidden = true
  clock.tick(20000)
  assert.equal(reads, 2, '窗口不可见不查询')
  bundle.document.hidden = false
  byTab(harness.tree(), 'overview').props.onClick()
  assert.equal(clock.count(20000), 0)
  clock.tick(20000)
  assert.equal(reads, 2)
  byTab(harness.tree(), 'records').props.onClick()
  await harness.flush()
  assert.equal(reads, 3)
  byStream(harness.tree(), 'log').props.onClick()
  await harness.flush()
  assert.equal(clock.count(20000), 0)
  byStream(harness.tree(), 'messages').props.onClick()
  await harness.flush()
  assert.equal(reads, 4, '切换类型不重复发起立即读取')
  assert.equal(connection.calls.some(([, method]) => ['start', 'stop', 'judge.now', 'send.now', 'config.set'].includes(method)), false)
  harness.unmount()
  assert.equal(clock.cleared(), true)
})

test('群消息首次失败、成功空结果与无效宿主回应不会混淆', async (t) => {
  const clock = clockStub()
  let response = { ok: false, error: { message: '请重新登录' } }
  const connection = routedConnection({ messages: () => response })
  const { harness } = await mountPage(t, connection, { timers: clock })
  byTab(harness.tree(), 'records').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '记录读取失败')
  assertTreeHas(harness.tree(), '请重新登录')
  assert.equal(JSON.stringify(harness.tree()).includes('最近成功获取：'), false)
  response = { ok: true, value: { rows: [], group: '1234567', fetchedAt: '2026-10-10 12:00:00' } }
  clock.tick(20000)
  await harness.flush()
  assertTreeHas(harness.tree(), '暂无群消息记录')
  assertTreeHas(harness.tree(), '最新消息：—')
  response = { ok: true, value: { rows: [{ content: '不能显示的旧协议消息' }] } }
  clock.tick(20000)
  await harness.flush()
  assertTreeHas(harness.tree(), '宿主未返回当前群的有效记录')
  assertTreeHas(harness.tree(), '最近成功获取：2026-10-10 12:00:00（缓存结果，刷新失败）')
  assert.equal(JSON.stringify(harness.tree()).includes('不能显示的旧协议消息'), false)
})

test('切换有效群后丢弃旧消息响应，未保存群草稿不切换查询', async (t) => {
  const clock = clockStub()
  const old = deferred()
  let group = '1234567'
  let reads = 0
  const connection = routedConnection({
    status: () => ({ ok: true, value: { ...IDLE, group } }),
    messages: () => ++reads === 1 ? old.promise : { ok: true, value: { rows: [{ content: '新群消息' }], group, fetchedAt: '2026-10-10 12:01:00' } },
  })
  const { harness } = await mountPage(t, connection, { timers: clock })
  byTab(harness.tree(), 'records').props.onClick()
  byField(harness.tree(), 'group').props.onChange({ target: { value: '1234568' } })
  assert.equal(reads, 1)
  group = '1234568' // 仅为模拟 RPC，测试不访问任何真实群。
  clock.tick()
  await harness.flush()
  assert.equal(reads, 2)
  assertTreeHas(harness.tree(), '新群消息')
  old.resolve({ ok: true, value: { rows: [{ content: '旧群消息' }], group: '1234567', fetchedAt: '2026-10-10 12:00:00' } })
  await harness.flush()
  assert.equal(JSON.stringify(harness.tree()).includes('旧群消息'), false)
  assertTreeHas(harness.tree(), '新群消息')
})

test('切换连接或卸载后迟到的消息不更新页面', async (t) => {
  const clock = clockStub()
  const old = deferred()
  const next = deferred()
  const { harness } = await mountPage(t, routedConnection({ messages: () => old.promise }), { timers: clock })
  byTab(harness.tree(), 'records').props.onClick()
  const replacement = mount({ connection: routedConnection({ messages: () => next.promise }), react: harness.React, timers: clock })
  harness.render(harness.createElement(replacement.injected[0].entry.component, {}))
  await harness.flush()
  old.resolve({ ok: true, value: { rows: [{ content: '旧连接消息' }], group: '1234567', fetchedAt: '2026-10-10 12:00:00' } })
  await harness.flush()
  assert.equal(JSON.stringify(harness.tree()).includes('旧连接消息'), false)
  harness.unmount()
  const updates = harness.updates()
  next.resolve({ ok: true, value: { rows: [], group: '1234567', fetchedAt: '2026-10-10 12:01:00' } })
  await harness.flush()
  assert.equal(harness.updates(), updates)
  assert.equal(clock.cleared(), true)
})

test('三个页签保留草稿与记录，配置只读一次，轮询不覆盖编辑', async (t) => {
  const clock = clockStub()
  const connection = savingConnection({ messages: { ok: true, value: { rows: [{ content: '已加载记录' }], group: '1234567', fetchedAt: '2026-10-10 12:00:00' } } })
  const { harness } = await mountPage(t, connection, { timers: clock })
  assert.equal(byTab(harness.tree(), 'overview').props['aria-selected'], true)
  assert.equal(findNodes(harness.tree(), n => n.props?.className === 'dsh-popo-root').length, 1)
  byTab(harness.tree(), 'settings').props.onClick()
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '6' } })
  byField(harness.tree(), 'manual-text').props.onChange({ target: { value: '尚未发送的草稿' } })
  byTab(harness.tree(), 'records').props.onClick()
  assert.equal(connection.calls.filter(([, method]) => method === 'messages').length, 1)
  await harness.flush()
  byTab(harness.tree(), 'overview').props.onClick()
  clock.tick()
  await harness.flush()
  assert.equal(byField(harness.tree(), 'windowHours').props.value, '6')
  assert.equal(byField(harness.tree(), 'manual-text').props.value, '尚未发送的草稿')
  assertTreeHas(harness.tree(), '已加载记录')
  assert.equal(connection.calls.filter(([, method]) => method === 'config.get').length, 1)
  assert.equal(byAction(harness.tree(), '开始').props.disabled, true)
  assert.equal(byAction(harness.tree(), '发送').props.disabled, false, '未保存的自动设置不阻止手动发送')
})

test('@ 回复开关默认关闭，运行中单独保存并保留其他配置草稿', async (t) => {
  let config = defaultConfig()
  const connection = savingConnection({
    status: { ok: true, value: STATUS },
    'config.get': () => ({ ok: true, value: { config, configState: 'saved' } }),
    'config.set': ({ patch }) => {
      config = applyPatch(config, patch).config
      return { ok: true, value: { config, configState: 'saved', written: true } }
    },
  })
  const { harness } = await mountPage(t, connection)
  const toggle = () => byAction(harness.tree(), '切换仅回复@我')
  assert.equal(toggle().props['aria-checked'], false)
  assert.equal(toggle().props.role, 'switch')
  assert.equal(toggle().props.className, byAction(harness.tree(), '停止').props.className)
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '6' } })
  toggle().props.onClick()
  await harness.flush()
  assert.equal(toggle().props['aria-checked'], true)
  assert.equal(byField(harness.tree(), 'windowHours').props.value, '6')
  assert.equal(config.windowHours, 24)
  assert.deepEqual(connection.calls.filter(([, method]) => method === 'config.set').map(call => call[2]), [{ patch: { replyOnlyWhenMentioned: true } }])
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.equal(config.windowHours, 6)
  assert.equal(config.replyOnlyWhenMentioned, true)
  const reopened = await mountPage(t, connection)
  assert.equal(byAction(reopened.harness.tree(), '切换仅回复@我').props['aria-checked'], true)
  assert.equal(connection.calls.some(([, method]) => ['start', 'stop', 'send.now'].includes(method)), false)
})

test('@ 回复开关阻止重复点击，请求失败保留旧值，写盘失败可独立重试', async (t) => {
  const request = deferred()
  let config = defaultConfig()
  let attempts = 0
  const connection = savingConnection({ 'config.set': ({ patch }) => {
    if (++attempts === 1) return request.promise
    config = applyPatch(config, patch).config
    return { ok: true, value: { config, written: attempts > 2, configState: attempts > 2 ? 'saved' : 'unsaved' } }
  } })
  const { harness } = await mountPage(t, connection)
  const toggle = () => byAction(harness.tree(), '切换仅回复@我')
  const staleClick = toggle().props.onClick
  staleClick()
  staleClick()
  assert.equal(attempts, 1)
  assert.equal(toggle().props.disabled, true)
  assert.equal(toggle().props['aria-busy'], true)
  request.resolve({ ok: false, error: { message: 'offline' } })
  await harness.flush()
  assert.equal(toggle().props['aria-checked'], false)
  assertTreeHas(harness.tree(), '保存失败')
  toggle().props.onClick()
  await harness.flush()
  assert.equal(toggle().props['aria-checked'], true, '写盘失败仍显示服务端临时生效值')
  assertTreeHas(harness.tree(), '仅临时生效，尚未保存')
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '' } })
  byAction(harness.tree(), '重试保存回复范围').props.onClick()
  await harness.flush()
  assert.equal(attempts, 3)
  assert.equal(byField(harness.tree(), 'windowHours').props.value, '', '重试不覆盖或提交其他草稿')
  assert.equal(byAction(harness.tree(), '重试保存回复范围'), undefined)
  assert.deepEqual(connection.calls.filter(([, method]) => method === 'config.set').at(-1)[2], { patch: { replyOnlyWhenMentioned: true } })
  toggle().props.onClick()
  await harness.flush()
  assert.equal(toggle().props['aria-checked'], false)
})

test('配置提交是真正的嵌套增量，隐藏模型和阈值不会被表单覆盖', async (t) => {
  let config = defaultConfig()
  config.judge.model = 'custom-model'
  config.judge.timeoutMs = 12345
  config.judge.thresholds.roundFiller = 0.97
  const connection = savingConnection({
    'config.get': () => ({ ok: true, value: { config, configState: 'saved' } }),
    'config.set': ({ patch }) => {
      config = applyPatch(config, patch).config
      return { ok: true, value: { config, written: true, configState: 'saved' } }
    },
  })
  const { harness } = await mountPage(t, connection)
  byField(harness.tree(), 'judgeEnabled').props.onChange({ target: { checked: false } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.find(([, method]) => method === 'config.set')[2], { patch: { judge: { enabled: false } } })
  assert.equal(config.judge.model, 'custom-model')
  assert.equal(config.judge.timeoutMs, 12345)
  assert.equal(config.judge.thresholds.roundFiller, 0.97)
  assert.equal(byAction(harness.tree(), '保存').props.disabled, true)
})

test('默认时长随保存更新，手动覆盖的本次时长保持独立', async (t) => {
  const { harness } = await mountPage(t, savingConnection())
  assert.equal(byField(harness.tree(), 'hours').props.value, '24')
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '6' } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.equal(byField(harness.tree(), 'hours').props.value, '6')
  byField(harness.tree(), 'hours').props.onChange({ target: { value: '2' } })
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '8' } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.equal(byField(harness.tree(), 'hours').props.value, '2')
})

test('每小时上限与开场白关闭后保留配置值，打开时显示并校验', async (t) => {
  const connection = savingConnection()
  const { harness } = await mountPage(t, connection)
  assert.equal(byField(harness.tree(), 'hourlyCapMax').props.value, '6')
  assert.equal(byField(harness.tree(), 'hourlyCapMax').props.disabled, true)
  byField(harness.tree(), 'hourlyCapEnabled').props.onChange({ target: { checked: true } })
  assert.equal(byField(harness.tree(), 'hourlyCapMax').props.disabled, false)
  byField(harness.tree(), 'hourlyCapMax').props.onChange({ target: { value: '61' } })
  assert.equal(byAction(harness.tree(), '保存').props.disabled, true)
  byField(harness.tree(), 'hourlyCapMax').props.onChange({ target: { value: '9' } })
  byField(harness.tree(), 'openingEnabled').props.onChange({ target: { checked: false } })
  assert.equal(byField(harness.tree(), 'openingText').props.value, defaultConfig().opening.text)
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.find(([, method]) => method === 'config.set')[2].patch, { hourlyCap: { enabled: true, max: 9 }, opening: { enabled: false } })
})

test('读取和保存期间禁止提交；保存期间禁止编辑并阻止重复请求', async (t) => {
  const read = deferred()
  const write = deferred()
  const connection = savingConnection({ 'config.get': () => read.promise, 'config.set': () => write.promise })
  const { harness } = await mountPage(t, connection)
  assert.equal(byAction(harness.tree(), '保存').props.disabled, true)
  byAction(harness.tree(), '保存').props.onClick()
  assert.equal(connection.calls.some(([, method]) => method === 'config.set'), false)
  read.resolve({ ok: true, value: { config: defaultConfig(), configState: 'saved' } })
  await harness.flush()
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '6' } })
  byAction(harness.tree(), '保存').props.onClick()
  byAction(harness.tree(), '保存').props.onClick()
  assert.equal(byField(harness.tree(), 'windowHours').props.disabled, true)
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '9' } })
  assert.equal(byField(harness.tree(), 'windowHours').props.value, '6')
  assert.equal(connection.calls.filter(([, method]) => method === 'config.set').length, 1)
  write.resolve({ ok: false, error: { message: '断线' } })
  await harness.flush()
  assert.equal(byField(harness.tree(), 'windowHours').props.value, '6')
  assert.equal(byAction(harness.tree(), '保存').props.disabled, false)
})

test('写盘失败保持未保存状态；再次保存当前临时配置无需重复提交字段', async (t) => {
  let attempts = 0
  let config = defaultConfig()
  const connection = savingConnection({ 'config.set': ({ patch }) => {
    config = applyPatch(config, patch).config
    const written = ++attempts > 1
    return { ok: true, value: { config, written, configState: written ? 'saved' : 'unsaved', warnings: written ? [] : ['EACCES'] } }
  } })
  const { harness } = await mountPage(t, connection)
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '6' } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '仅临时生效，尚未保存')
  assert.equal(byField(harness.tree(), 'windowHours').props.value, '6')
  assert.equal(byAction(harness.tree(), '保存').props.disabled, false)
  assert.equal(byAction(harness.tree(), '开始').props.disabled, true)
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.filter(([, method]) => method === 'config.set')[1][2].patch, {})
  assert.equal(byAction(harness.tree(), '保存').props.disabled, true)
})

test('配置缺失能直接保存默认值，旧协议缺少 configState 时显示未知', async (t) => {
  for (const configState of ['default', undefined]) {
    const connection = savingConnection({ 'config.get': { ok: true, value: { config: defaultConfig(), configState } } })
    const { harness } = await mountPage(t, connection)
    assertTreeHas(harness.tree(), configState ? '当前使用默认值' : '保存状态未知')
    assert.equal(byAction(harness.tree(), '保存').props.disabled, false)
    byAction(harness.tree(), '保存').props.onClick()
    await harness.flush()
    assert.deepEqual(connection.calls.find(([, method]) => method === 'config.set')[2], { patch: {} })
  }
})

test('配置读取错误禁止覆盖，重新读取会携带 reload 并恢复编辑', async (t) => {
  const connection = savingConnection({ 'config.get': ({ reload }) => ({ ok: true, value: { config: defaultConfig(), configState: reload ? 'saved' : 'error', warnings: reload ? [] : ['EACCES'] } }) })
  const { harness } = await mountPage(t, connection)
  assert.equal(byField(harness.tree(), 'windowHours').props.disabled, true)
  assert.equal(byAction(harness.tree(), '保存').props.disabled, true)
  byAction(harness.tree(), '重新读取配置').props.onClick()
  await harness.flush()
  assert.equal(byField(harness.tree(), 'windowHours').props.disabled, false)
  assert.deepEqual(connection.calls.filter(([, method]) => method === 'config.get')[1][2], { reload: true })
})

test('运行/静音期间锁定群与间隔，未保存参数和无效本次时长不妨碍停止', async (t) => {
  for (const stopped of [false, true]) {
    const connection = savingConnection({ status: { ok: true, value: { ...STATUS, window: { ...STATUS.window, stopped } } }, stop: { ok: true, value: { stoppedAt: 'now' } } })
    const { harness } = await mountPage(t, connection)
    assert.equal(byField(harness.tree(), 'group').props.disabled, true)
    assert.equal(byField(harness.tree(), 'intervalSec').props.disabled, true)
    byField(harness.tree(), 'group').props.onChange({ target: { value: '1234568' } })
    assert.equal(byField(harness.tree(), 'group').props.value, '1234567')
    byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '6' } })
    byField(harness.tree(), 'hours').props.onChange({ target: { value: '' } })
    assert.equal(byAction(harness.tree(), '停止').props.disabled, false)
    byAction(harness.tree(), '停止').props.onClick()
    await harness.flush()
    assert.equal(connection.calls.some(([, method]) => method === 'stop'), true)
  }
})

test('状态显示区分静音、停止、到期、采集异常和未恢复采集', async (t) => {
  const cases = [
    [IDLE, '未开始'],
    [STATUS, '监控中'],
    [{ ...STATUS, phase: 'idle', window: { ...STATUS.window, stopped: true } }, '已静音'],
    [{ ...STATUS, phase: 'idle', window: { ...STATUS.window, stopped: true }, poll: { running: false } }, '已停止'],
    [{ ...IDLE, window: { ...STATUS.window, active: false, remainingSec: 0 } }, '已到期'],
    [{ ...STATUS, degraded: { active: true, reason: '采集失败' } }, '采集异常'],
    [{ ...STATUS, phase: 'disposed', poll: { running: false }, degraded: { active: true, reason: '采集失败' } }, '已卸载'],
    [{ ...STATUS, poll: { running: false } }, '采集未启动'],
  ]
  for (const [value, label] of cases) {
    const { harness } = await mountPage(t, savingConnection({ status: { ok: true, value } }))
    assertTreeHas(harness.tree(), label)
    assertTreeHas(harness.tree(), '累计发言')
    if (value.phase === 'disposed') assert.equal(JSON.stringify(harness.tree()).includes('正在重试'), false)
    assert.equal(JSON.stringify(harness.tree()).includes('本窗口 2 条'), false)
  }
})

test('状态断线保留最后成功快照，恢复后清除过期标记', async (t) => {
  const clock = clockStub()
  let fail = false
  const connection = savingConnection({ status: () => fail ? { ok: false, error: { message: 'offline' } } : { ok: true, value: STATUS } })
  const { harness } = await mountPage(t, connection, { timers: clock })
  fail = true
  clock.tick()
  await harness.flush()
  assertTreeHas(harness.tree(), '最后成功快照，可能已过期')
  assertTreeHas(harness.tree(), '这个坑我上周也踩过')
  const remaining = () => findNodes(harness.tree(), node => node.props?.['aria-label'] === '本轮时间')[0].props.children
  assert.deepEqual(remaining(), ['—'], '断线后不能把缓存时间当作活动倒计时')
  assert.equal(byAction(harness.tree(), '停止').props['data-tone'], 'bad')
  fail = false
  clock.tick()
  await harness.flush()
  assert.equal(JSON.stringify(harness.tree()).includes('可能已过期'), false)
  assert.deepEqual(remaining(), ['剩余 30 分 30 秒'])
  harness.unmount()
  assert.equal(clock.cleared(), true)
})

test('慢状态请求保持单飞；动作后的刷新排队，旧快照不会覆盖动作结果', async (t) => {
  const clock = clockStub()
  const old = deferred()
  let reads = 0
  const connection = savingConnection({ status: () => ++reads === 1 ? old.promise : { ok: true, value: { ...IDLE, sends: { count: 7 } } } })
  const { harness } = await mountPage(t, connection, { timers: clock })
  clock.tick()
  clock.tick()
  assert.equal(reads, 1)
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '6' } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.equal(reads, 1)
  old.resolve({ ok: true, value: { ...IDLE, sends: { count: 999 } } })
  await harness.flush()
  assert.equal(reads, 2)
  assertTreeHas(harness.tree(), '7 条')
  assert.equal(JSON.stringify(harness.tree()).includes('999 条'), false)
})

test('卸载后延迟的状态和配置响应不会再更新组件', async (t) => {
  const status = deferred()
  const config = deferred()
  const clock = clockStub()
  const { harness } = await mountPage(t, routedConnection({ status: () => status.promise, 'config.get': () => config.promise }), { timers: clock })
  harness.unmount()
  const updates = harness.updates()
  status.resolve({ ok: true, value: STATUS })
  config.resolve({ ok: true, value: { config: defaultConfig(), configState: 'saved' } })
  await harness.flush()
  assert.equal(harness.updates(), updates)
  assert.equal(clock.cleared(), true)
})

test('环境变量凭证不能通过清除本地副本删除，点击处理器也不发送请求', async (t) => {
  const connection = routedConnection()
  const { harness } = await mountPage(t, connection)
  assertTreeHas(harness.tree(), '不代表已验证服务可用')
  assert.equal(byAction(harness.tree(), '清除 key').props.disabled, true)
  byAction(harness.tree(), '清除 key').props.onClick()
  await harness.flush()
  assert.equal(connection.calls.some(([, method]) => method === 'key.clear'), false)
})

test('本轮时间区分活动窗口、停止残余时间、到期及无有效剩余值', async (t) => {
  const cases = [
    [IDLE, '未开始'],
    [STATUS, '剩余 30 分 30 秒'],
    [{ ...STATUS, window: { ...STATUS.window, stopped: true } }, '剩余 30 分 30 秒'],
    [{ ...STATUS, window: { ...STATUS.window, stopped: true }, poll: { running: false } }, '已停止'],
    [{ ...IDLE, window: { ...STATUS.window, active: false }, poll: { running: false } }, '已停止'],
    [{ ...IDLE, window: { ...STATUS.window, active: false, remainingSec: 0 } }, '已到期'],
    [{ ...STATUS, window: { ...STATUS.window, remainingSec: undefined } }, '—'],
    [{ ...STATUS, window: { ...STATUS.window, remainingSec: Infinity } }, '—'],
    [{ ...STATUS, phase: 'disposed' }, '已卸载'],
  ]
  for (const [value, text] of cases) {
    const { harness } = await mountPage(t, savingConnection({ status: { ok: true, value } }))
    const remaining = findNodes(harness.tree(), node => node.props?.['aria-label'] === '本轮时间')[0]
    assert.deepEqual(remaining.props.children, [text])
    if (value.window.endsAt) {
      const details = findNodes(harness.tree(), node => node.props?.['aria-label'] === '运行详情与诊断')[0]
      assertTreeHas(details, value.window.endsAt)
    }
  }
})

test('摘要保留采集日期、累计口径和长错误全文，诊断默认折叠且不自动执行', async (t) => {
  const error = '采集失败：' + 'very-long-error-path/'.repeat(20)
  const connection = savingConnection({ status: { ok: true, value: {
    ...STATUS, sends: { count: 123456789 },
    poll: { ...STATUS.poll, updatedAt: '2026-10-08 21:29:42', consecutiveFailures: 2, lastError: error },
  } } })
  const { harness } = await mountPage(t, connection)
  const tree = harness.tree()
  const recent = findNodes(tree, node => node.props?.['data-stat'] === 'updated')[0]
  assert.deepEqual(recent.props.children[1].props.children, ['2026-10-08\n21:29:42'])
  assertTreeHas(tree, '123456789 条')
  assertTreeHas(tree, '累计发言')
  const alert = findNodes(tree, node => node.type === 'details' && node.props?.role === 'alert')[0]
  assert.ok(alert, '长错误可以展开，不能挤出整个控制区')
  assertTreeHas(alert, error)
  assertTreeHas(alert, '查看完整信息')
  const details = findNodes(tree, node => node.props?.['aria-label'] === '运行详情与诊断')[0]
  assert.notEqual(details.props.open, true)
  assert.equal(byAction(tree, '停止').props['data-tone'], 'bad', '采集失败时开关不能显示健康状态')
  assert.equal(connection.calls.some(([, endpoint]) => ['cli.check', 'judge.now', 'send.now'].includes(endpoint)), false)
})

test('诊断卡片保留运行快照，CLI 成功及页签轮询不覆盖采集异常', async (t) => {
  const error = 'FABRIC_NETWORK_ERROR：' + 'long-network-error/'.repeat(20)
  const cliMessage = 'POPO CLI 可正常启动，登录状态正常；采集结果请查看最近采集。'
  const clock = clockStub()
  let offline = false
  const connection = savingConnection({
    status: () => offline ? { ok: false, error: { message: '状态断线' } } : { ok: true, value: {
      ...STATUS,
      poll: { ...STATUS.poll, consecutiveFailures: 2, lastError: error },
      round: { at: '12:06:00', verdict: 'blocked', reason: '模拟判读原因' },
      errors: [{ at: '12:07:00', message: '历史错误说明' }],
    } },
    'cli.check': { ok: true, value: { healthy: true, message: cliMessage } },
  })
  const { harness } = await mountPage(t, connection, { timers: clock })
  const details = () => findNodes(harness.tree(), node => node.props?.['aria-label'] === '运行详情与诊断')[0]
  const cards = ['运行信息', '模型与发送', '最近活动'].map(label => findNodes(details(), node => node.props?.['aria-label'] === label)[0])
  assertTreeHas(cards[0], STATUS.selfUid)
  assertTreeHas(cards[0], STATUS.window.endsAt)
  assertTreeHas(cards[1], '插件指定：netease / deepseek-v3')
  assertTreeHas(cards[1], '不可用时保持静默')
  assertTreeHas(cards[2], STATUS.sends.lastSendContent)
  assertTreeHas(cards[2], '模拟判读原因')
  assertTreeHas(cards[2], '历史错误说明')
  const alert = findNodes(details(), node => node.type === 'details' && node.props?.role === 'alert')[0]
  assert.ok(alert)
  assert.notEqual(alert.props.open, true)
  assertTreeHas(alert, error)

  byAction(harness.tree(), '检查 POPO CLI').props.onClick()
  await harness.flush()
  const cli = findNodes(details(), node => node.props?.['aria-label'] === 'POPO CLI 检查')[0]
  const message = findNodes(cli, node => node.props?.['data-dsh-popo-note'] === '')[0]
  assert.deepEqual(message.props.children, [cliMessage], '完整服务说明独立于检查时间')
  assertTreeHas(findNodes(cli, node => node.type === 'time')[0], '检查于')
  assertTreeHas(details(), 'CLI 启动、登录正常')
  assertTreeHas(details(), error)
  byTab(harness.tree(), 'settings').props.onClick()
  byTab(harness.tree(), 'overview').props.onClick()
  offline = true
  clock.tick()
  await harness.flush()
  assertTreeHas(details(), '以下详情为缓存')
  assertTreeHas(details(), error)
  assertTreeHas(details(), cliMessage)
  const footer = findNodes(harness.tree(), node => node.props?.className?.includes('dsh-popo-refresh'))[0]
  assertTreeHas(footer, '当前显示缓存')
  assertTreeHas(footer, '每 2 秒刷新')
  assert.equal(connection.calls.filter(([, endpoint]) => endpoint === 'cli.check').length, 1)
  assert.equal(connection.calls.some(([, endpoint]) => ['start', 'judge.now', 'send.now', 'config.set', 'messages'].includes(endpoint)), false)
})

test('单次判读保持单飞，长结论可展开并在页签切换后保留', async (t) => {
  const pending = deferred()
  const explanation = '模拟判读说明。'.repeat(45)
  const connection = savingConnection({ 'judge.now': () => pending.promise })
  const { harness } = await mountPage(t, connection)
  const click = byAction(harness.tree(), '仅判读一次').props.onClick
  click()
  click()
  assert.equal(byAction(harness.tree(), '仅判读一次').props.disabled, true)
  assert.equal(connection.calls.filter(([, endpoint]) => endpoint === 'judge.now').length, 1)
  pending.resolve({ ok: true, value: { view: { verdict: 'blocked', blockers: ['preview'], nextStep: explanation } } })
  await harness.flush()
  byTab(harness.tree(), 'settings').props.onClick()
  byTab(harness.tree(), 'overview').props.onClick()
  const judge = findNodes(harness.tree(), node => node.props?.['aria-label'] === '单次判读')[0]
  const note = findNodes(judge, node => node.type === 'details')[0]
  assert.ok(note)
  assert.notEqual(note.props.open, true)
  assertTreeHas(note, explanation)
  assertTreeHas(note, '查看完整信息')
  assert.equal(byAction(harness.tree(), '仅判读一次').props.disabled, false)
  assert.equal(connection.calls.some(([, endpoint]) => ['cli.check', 'start', 'send.now', 'config.set', 'messages'].includes(endpoint)), false)
})

test('诊断操作完成或失败后恢复按钮焦点，用户已移焦时不抢回', async (t) => {
  for (const [action, endpoint] of [['检查 POPO CLI', 'cli.check'], ['仅判读一次', 'judge.now']]) {
    for (const [failed, moved] of [[false, false], [true, false], [false, true], [true, true]]) {
      const pending = deferred()
      const { harness, bundle } = await mountPage(t, savingConnection({ [endpoint]: () => pending.promise }))
      const button = { isConnected: true, focus() { bundle.document.activeElement = this } }
      bundle.document.activeElement = button
      byAction(harness.tree(), action).props.onClick({ currentTarget: button })
      const nextFocus = moved ? {} : bundle.document.body
      bundle.document.activeElement = nextFocus
      pending.resolve(failed ? { ok: false, error: { message: 'offline' } } : {
        ok: true, value: endpoint === 'cli.check' ? { healthy: true, message: 'CLI 正常' } : { view: { verdict: 'blocked' } },
      })
      await harness.flush()
      assert.equal(bundle.document.activeElement, moved ? nextFocus : button)
    }
  }
})

test('成功信封内缺少运行状态时仍标记不可用，不推断为未开始', async (t) => {
  const connection = routedConnection({ status: { ok: true, value: {} } })
  const { harness } = await mountPage(t, connection)
  assertTreeHas(harness.tree(), '宿主未返回有效状态')
  assert.equal(byAction(harness.tree(), '开始'), undefined)
  assert.equal(byAction(harness.tree(), '停止').props.disabled, false)
  assert.equal(JSON.stringify(harness.tree()).includes('监控中'), false)
})

test('记录明确显示空结果、选中项和失败，失败时保留上一份成功记录', async (t) => {
  let failing = false
  const connection = routedConnection({
    messages: () => failing ? { ok: false, error: { message: 'offline' } } : { ok: true, value: { rows: [{ content: '缓存消息' }], group: '1234567', fetchedAt: '2026-10-10 12:00:00' } },
    sends: { ok: true, value: { rows: [] } },
  })
  const { harness } = await mountPage(t, connection)
  byStream(harness.tree(), 'sends').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '暂无已发送记录')
  assert.equal(byStream(harness.tree(), 'sends').props['aria-pressed'], true)
  byStream(harness.tree(), 'messages').props.onClick()
  await harness.flush()
  failing = true
  byAction(harness.tree(), '刷新记录').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '缓存消息')
  assertTreeHas(harness.tree(), '（缓存结果，刷新失败）')
  assertTreeHas(harness.tree(), '最近成功获取：2026-10-10 12:00:00')
  assertTreeHas(harness.tree(), '读取失败：offline')
})

const MODEL_CATALOG = {
  llm: { ok: true, defaultSelection: { provider: 'host', model: 'default-model' }, providers: [
    { id: 'first', name: '提供方一', models: [{ id: 'shared-id', name: '共享型号' }] },
    { id: 'second', name: '提供方二', models: [{ id: 'shared-id', name: '共享型号' }] },
  ] },
  judge: { ok: true, models: [{ id: 'jev-latest', name: 'jev-latest' }, { id: 'jev-preview', name: 'jev-preview' }] },
}

test('模型选择：首次进入设置才拉目录，同名模型按提供方区分，保存与重载保留嵌套参数', async (t) => {
  let config = defaultConfig()
  config.llm.temperature = 0.4
  config.llm.maxTokens = 320
  config.judge.thresholds.roundFiller = 0.93
  const clock = clockStub()
  const connection = savingConnection({
    'models.list': { ok: true, value: MODEL_CATALOG },
    'config.get': () => ({ ok: true, value: { config, configState: 'saved' } }),
    'config.set': ({ patch }) => {
      config = applyPatch(config, patch).config
      return { ok: true, value: { config, written: true, configState: 'saved' } }
    },
    status: { ok: true, value: { ...IDLE, llm: { resolved: { provider: 'host', model: 'default-model', source: 'host' } } } },
  })
  const { harness } = await mountPage(t, connection, { timers: clock })
  clock.tick()
  await harness.flush()
  assert.equal(connection.calls.some(([, method]) => method === 'models.list'), false)
  byTab(harness.tree(), 'settings').props.onClick()
  await harness.flush()
  assert.equal(byField(harness.tree(), 'llmSelection').type, 'select')
  assert.equal(byField(harness.tree(), 'judgeModel').type, 'select')
  assert.equal(findNodes(harness.tree(), node => node.type === 'optgroup').length, 2)
  byField(harness.tree(), 'llmSelection').props.onChange({ target: { value: '["second","shared-id"]' } })
  byField(harness.tree(), 'judgeModel').props.onChange({ target: { value: 'jev-preview' } })
  assertTreeHas(harness.tree(), '已生效：跟随宿主默认：host / default-model')
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.find(([, method]) => method === 'config.set')[2], {
    patch: { judge: { model: 'jev-preview' }, llm: { provider: 'second', model: 'shared-id' } },
  })
  assert.deepEqual(config.llm, { provider: 'second', model: 'shared-id', temperature: 0.4, maxTokens: 320 })
  assert.equal(config.judge.thresholds.roundFiller, 0.93)
  harness.unmount()
  const reopened = (await mountPage(t, connection)).harness
  byTab(reopened.tree(), 'settings').props.onClick()
  await reopened.flush()
  assert.equal(byField(reopened.tree(), 'llmSelection').props.value, '["second","shared-id"]')
  assert.equal(byField(reopened.tree(), 'judgeModel').props.value, 'jev-preview')
  byField(reopened.tree(), 'llmSelection').props.onChange({ target: { value: '' } })
  byAction(reopened.tree(), '保存').props.onClick()
  await reopened.flush()
  assert.deepEqual(connection.calls.filter(([, method]) => method === 'config.set').at(-1)[2].patch, { llm: { provider: '', model: '' } })
  assert.equal(config.llm.temperature, 0.4)
  assert.equal(connection.calls.some(([, method]) => ['start', 'judge.now', 'send.now'].includes(method)), false)
})

test('模型选择：旧值未列出或列表失败都保留配置，不能手填未列出的新 ID', async (t) => {
  let config = defaultConfig()
  config.llm.provider = 'legacy'
  config.llm.model = 'old-model'
  config.judge.model = 'jev-pinned-old'
  let fail = false
  const connection = savingConnection({
    'config.get': () => ({ ok: true, value: { config, configState: 'saved' } }),
    'config.set': ({ patch }) => { config = applyPatch(config, patch).config; return { ok: true, value: { config, written: true } } },
    'models.list': () => fail ? { ok: false, error: { message: '目录连接中断' } } : { ok: true, value: MODEL_CATALOG },
  })
  const { harness } = await mountPage(t, connection)
  byTab(harness.tree(), 'settings').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), 'legacy / old-model（当前配置，列表未返回）')
  assertTreeHas(harness.tree(), 'jev-pinned-old（当前配置，列表未返回）')
  assert.equal(byAction(harness.tree(), '保存').props.disabled, true)
  byField(harness.tree(), 'llmSelection').props.onChange({ target: { value: '["invented","unknown"]' } })
  byField(harness.tree(), 'judgeModel').props.onChange({ target: { value: 'invented' } })
  assert.equal(byField(harness.tree(), 'llmSelection').props.value, '["legacy","old-model"]')
  assert.equal(byField(harness.tree(), 'judgeModel').props.value, 'jev-pinned-old')
  fail = true
  byAction(harness.tree(), '刷新模型列表').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '目录连接中断')
  assert.equal(byField(harness.tree(), 'llmSelection').props.disabled, true)
  byField(harness.tree(), 'windowHours').props.onChange({ target: { value: '8' } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.find(([, method]) => method === 'config.set')[2].patch, { windowHours: 8 })
  assert.equal(config.llm.model, 'old-model')
  assert.equal(config.judge.model, 'jev-pinned-old')
})

test('模型选择：刷新、切页和状态轮询不覆盖草稿，撤销回到已保存选择', async (t) => {
  let catalog = MODEL_CATALOG
  const clock = clockStub()
  const connection = savingConnection({ 'models.list': () => ({ ok: true, value: catalog }) })
  const { harness } = await mountPage(t, connection, { timers: clock })
  byTab(harness.tree(), 'settings').props.onClick()
  await harness.flush()
  byField(harness.tree(), 'llmSelection').props.onChange({ target: { value: '["second","shared-id"]' } })
  byField(harness.tree(), 'judgeModel').props.onChange({ target: { value: 'jev-preview' } })
  catalog = { llm: { ok: true, providers: [] }, judge: { ok: true, models: [] } }
  byAction(harness.tree(), '刷新模型列表').props.onClick()
  await harness.flush()
  byTab(harness.tree(), 'overview').props.onClick()
  clock.tick()
  await harness.flush()
  byTab(harness.tree(), 'settings').props.onClick()
  await harness.flush()
  assert.equal(byField(harness.tree(), 'llmSelection').props.value, '["second","shared-id"]')
  assert.equal(byField(harness.tree(), 'judgeModel').props.value, 'jev-preview')
  assertTreeHas(harness.tree(), 'TypeSafe 未返回可选模型')
  assert.equal(connection.calls.filter(([, method]) => method === 'models.list').length, 2)
  byAction(harness.tree(), '撤销修改').props.onClick()
  assert.equal(byField(harness.tree(), 'llmSelection').props.value, '')
  assert.equal(byField(harness.tree(), 'judgeModel').props.value, 'jev-latest')
})

test('模型目录：凭证更新只刷新判读，迟到的整表回复不能覆盖新的判读列表', async (t) => {
  const first = deferred()
  let judgeList = { ok: true, models: [{ id: 'jev-new', name: 'jev-new' }] }
  const connection = savingConnection({
    'models.list': ({ scope }) => scope === 'judge' ? { ok: true, value: { judge: judgeList } } : first.promise,
    'key.set': { ok: true, value: { configured: true, source: 'file' } },
    'key.clear': { ok: true, value: { configured: false, source: 'none', stored: false } },
  })
  const { harness } = await mountPage(t, connection)
  byTab(harness.tree(), 'settings').props.onClick()
  await harness.flush()
  byField(harness.tree(), 'judge-key').props.onChange({ target: { value: 'fake-offline-key' } })
  byAction(harness.tree(), '保存 key').props.onClick()
  await harness.flush()
  first.resolve({ ok: true, value: MODEL_CATALOG })
  await harness.flush()
  const options = findNodes(byField(harness.tree(), 'judgeModel'), node => node.type === 'option').map(node => node.props.value)
  assert.ok(options.includes('jev-new'))
  assert.equal(options.includes('jev-preview'), false)
  assert.equal(byField(harness.tree(), 'llmSelection').props.disabled, false)
  judgeList = { ok: false, models: [], error: '未配置 TypeSafe 凭证' }
  byAction(harness.tree(), '清除 key').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '未配置 TypeSafe 凭证')
  assert.equal(byField(harness.tree(), 'judgeModel').props.value, 'jev-latest')
  assert.deepEqual(connection.calls.filter(([, method]) => method === 'models.list').map(call => call[2]), [{}, { scope: 'judge' }, { scope: 'judge' }])
})

test('模型目录：提供方局部失败与判读坏响应不妨碍选择正常生成模型', async (t) => {
  const connection = savingConnection({ 'models.list': { ok: true, value: {
    llm: { ...MODEL_CATALOG.llm, providers: [...MODEL_CATALOG.llm.providers, { id: 'broken', name: '故障提供方', models: [], error: '模型目录读取超时' }] },
    judge: { ok: true, models: [null] },
  } } })
  const { harness } = await mountPage(t, connection)
  byTab(harness.tree(), 'settings').props.onClick()
  await harness.flush()
  assertTreeHas(harness.tree(), '故障提供方：模型目录读取超时')
  assertTreeHas(harness.tree(), '宿主未返回有效模型列表')
  assert.equal(byField(harness.tree(), 'llmSelection').props.disabled, false)
  assert.equal(byField(harness.tree(), 'judgeModel').props.disabled, true)
  byField(harness.tree(), 'llmSelection').props.onChange({ target: { value: '["first","shared-id"]' } })
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.find(([, method]) => method === 'config.set')[2].patch, { llm: { provider: 'first', model: 'shared-id' } })
})

test('模型选择：保存期间禁止变更，写盘失败保留选择并能重试保存', async (t) => {
  let config = defaultConfig()
  const saving = deferred()
  let first = true
  const connection = savingConnection({
    'models.list': { ok: true, value: MODEL_CATALOG },
    'config.set': ({ patch }) => {
      config = applyPatch(config, patch).config
      if (first) { first = false; return saving.promise }
      return { ok: true, value: { config, written: true, configState: 'saved' } }
    },
  })
  const { harness } = await mountPage(t, connection)
  byTab(harness.tree(), 'settings').props.onClick()
  await harness.flush()
  byField(harness.tree(), 'llmSelection').props.onChange({ target: { value: '["second","shared-id"]' } })
  byField(harness.tree(), 'judgeModel').props.onChange({ target: { value: 'jev-preview' } })
  byAction(harness.tree(), '保存').props.onClick()
  assert.equal(byField(harness.tree(), 'llmSelection').props.disabled, true)
  assert.equal(byField(harness.tree(), 'judgeModel').props.disabled, true)
  byField(harness.tree(), 'llmSelection').props.onChange({ target: { value: '' } })
  assert.equal(byField(harness.tree(), 'llmSelection').props.value, '["second","shared-id"]')
  saving.resolve({ ok: true, value: { config, written: false, configState: 'unsaved' } })
  await harness.flush()
  assertTreeHas(harness.tree(), '仅临时生效，尚未保存')
  assert.equal(byField(harness.tree(), 'judgeModel').props.value, 'jev-preview')
  byAction(harness.tree(), '保存').props.onClick()
  await harness.flush()
  assert.deepEqual(connection.calls.filter(([, method]) => method === 'config.set')[1][2].patch, {})
  assert.equal(byAction(harness.tree(), '保存').props.disabled, true)
})
