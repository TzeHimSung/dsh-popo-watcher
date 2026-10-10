/**
 * dsh-popo-watcher 冒烟测试：不启动 DSH 宿主，用 stub ctx 直接验证插件契约。
 *
 * 覆盖三件事：
 * 1) 模块导出形态（name / inject / apply）；
 * 2) 注册出来的工具定义形状与 execute 行为；
 * 3) 行 config（greeting）的兜底行为。
 *
 * @module dsh-popo-watcher/test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'

/**
 * 采集一次 apply() 的注册结果、结构化日志与 stdout，构造最小 stub ctx。
 * 同时吞掉 console.log，避免测试输出被加载行污染。
 */
function mount(config) {
  const registered = []
  const logs = []
  const stdout = []
  const ctx = {
    logger: (scope) => ({
      info: (...args) => logs.push([scope, args]),
    }),
    tools: {
      register(definition) {
        registered.push(definition)
      },
    },
  }
  const originalLog = console.log
  console.log = (...args) => stdout.push(args.join(' '))
  try {
    plugin.apply(ctx, config)
  } finally {
    console.log = originalLog
  }
  return { registered, logs, stdout }
}

test('模块导出形态符合 Cordis 插件契约', () => {
  assert.equal(plugin.name, 'popo-watcher')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 注册的工具集合固定，且 schema 形状在宿主支持子集内', () => {
  const { registered } = mount()
  // 工具集合是显式契约：新增工具必须同时改这条断言（避免悄悄扩面）。
  assert.deepEqual(registered.map((entry) => entry.name).sort(), ['popo_watch_status', 'popo_watcher_ping'])

  const tool = registered.find((entry) => entry.name === 'popo_watcher_ping')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 0)

  // parameters：对象根，只声明一个可选 string。
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.properties.message.type, 'string')

  // output.schema：register() 会断言该子集，且 required 必须都在 properties 里。
  const schema = tool.output.schema
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.ok(Array.isArray(schema.required) && schema.required.length > 0)
  for (const key of schema.required) {
    assert.ok(Object.hasOwn(schema.properties, key), `required 字段 ${key} 缺少 properties 定义`)
  }
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
})

test('execute 返回声明的必填字段，message 可选', async () => {
  const tool = mount().registered[0]

  const withMessage = await tool.execute({ message: 'hi' })
  assert.equal(withMessage.ok, true)
  assert.equal(withMessage.plugin, 'dsh-popo-watcher')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(withMessage.version, manifest.version)
  assert.equal(withMessage.message, 'hi')
  assert.equal(withMessage.greeting, 'hello')
  assert.equal(typeof withMessage.node, 'string')
  assert.equal(typeof withMessage.cwd, 'string')
  assert.ok(!Number.isNaN(Date.parse(withMessage.time)))

  const withoutMessage = await tool.execute({})
  assert.equal(withoutMessage.ok, true)
  assert.equal(Object.hasOwn(withoutMessage, 'message'), false)

  const emptyMessage = await tool.execute({ message: '' })
  assert.equal(Object.hasOwn(emptyMessage, 'message'), false)
})

test('output.render 输出单个 text 块', async () => {
  const tool = mount().registered[0]
  const value = await tool.execute({ message: 'render' })
  assert.deepEqual(tool.output.render({ message: 'render' }, value), [
    { type: 'text', text: JSON.stringify(value) },
  ])
})

test('config.greeting 生效，非法或缺省时回落 hello', async () => {
  const custom = await mount({ greeting: '你好' }).registered[0].execute({})
  assert.equal(custom.greeting, '你好')

  for (const config of [undefined, {}, { greeting: 123 }, { greeting: '' }]) {
    const fallback = await mount(config).registered[0].execute({})
    assert.equal(fallback.greeting, 'hello')
  }
})

test('apply 会打一条结构化日志和两条终端可见的加载行', () => {
  const { logs, stdout } = mount()

  assert.equal(logs.length, 1)
  assert.equal(logs[0][0], 'popo-watcher')
  assert.ok(logs[0][1].includes('popo_watcher_ping'))

  // 第一行证明插件行激活了，第二行证明水群器装配**跑到了最后**（装配整体包在 try/catch 里，
  // 中途抛错会静默降级成"没有水群器"，所以需要这条正向信号）。
  assert.equal(stdout.length, 2)
  assert.ok(stdout[0].includes('dsh-popo-watcher'))
  assert.ok(stdout[0].includes('popo_watcher_ping'))
  assert.ok(stdout[1].includes('popo watcher ready'))
  assert.ok(stdout[1].includes('popo_watch_status'))
})
