/**
 * dsh-popo-watcher —— 双面 DSH 插件。
 *
 * - 宿主半即本文件：注册模型可调用的工具；并在 web 组合里挂上「POPO自动水群」服务
 *   （状态快照 + RPC + 自动轮次：采集 → 判读 → 写文案 → 发送）；
 * - 浏览器半见 `lib/client.js`：设置项「POPO自动水群」的页面。
 *
 * 模块契约（Cordis 插件形态，Loader 的 unwrapExports 直接接受命名导出，
 * 不要求 default 导出）：
 * - `name`  插件名，仅用于日志与诊断；
 * - `inject` 声明依赖的服务。这里**只声明 `tools`**：其余服务（connection / subprocess /
 *   llm / agentDefaultModel / credentials）一律惰性获取。多声明一个组合里不存在的服务，
 *   会让本行永远 pending，DSH 启动 audit（assertEntriesActivated）就 fail loud，
 *   整个 `dsh web` 起不来；
 * - `apply(ctx, config)` 挂载入口。行 config 原样传入（本插件不导出 Config schema，
 *   因此不做校验）。
 *
 * 安全纪律（见 docs/interfaces.md §0）：
 * - import 期不做 IO、不抛错；水群器装配整体 try/catch，失败只降级、不影响行激活；
 * - 水群器内部的异步入口一律解析为结果对象，不产生未处理的 rejection——宿主进程里
 *   一个未处理的 rejection 会直接杀掉 `dsh web`。
 *
 * 为什么宿主半零 bare import（`@deepseek-ai/*`、zod、schemastery 都不能 import）：
 * 1) `dsh plugin add <目录>` 走 pnpm 的「目录依赖 = symlink」语义，插件的真实
 *    路径在项目目录，其裸 import 无法沿 Node 父级查找走到
 *    `$DSH_HOME/profiles/node_modules`（宿主安装依赖闭包），因此 import
 *    `@deepseek-ai/dsh-tools` 会解析失败；
 * 2) 手写工具定义不需要 defineTool：`ctx.tools.register()` 只校验 output，
 *    parameters 就是原始 JSON Schema 子集；
 * 3) 不使用 Schemastery Config，避免出现第二个 schemastery 实例导致校验失配。
 *
 * 工具注册进的是**全局层**，宿主侧注册对所有 agent（含 web 会话的 preset
 * agent）可见；要按 agent 收窄请用 `ctx.tools.restrict` 或 preset 行。
 *
 * @module dsh-popo-watcher
 */

import * as configModule from './config.js'
import * as storeModule from './store.js'
import { claimSingleton } from './singleton.js'
import { createJudge } from './judge.js'
import { checkCodeMakerConnection, createDraftWriter, listDraftModels, resolveDraftRoute } from './llm.js'
import { resolveKey, storedKeyFile } from './key-source.js'
import { createTransport, resolveCli } from './popo.js'
import { createRpcHandler, registerRpc } from './rpc.js'
import { createTools } from './tools.js'
import { createWatcher } from './watcher.js'

/** 插件名（Cordis 插件名，不是包名）。 */
export const name = 'popo-watcher'

/** 依赖的服务：宿主工具注册表（其余服务惰性获取，别加进来）。 */
export const inject = ['tools']

/** npm 包名，出现在工具返回值里，便于确认到底是哪个包在跑。 */
const PLUGIN_ID = 'dsh-popo-watcher'

/** 与 package.json 的 version 保持一致。 */
const PLUGIN_VERSION = '0.1.3'

/** 模型可见的 ping 工具名（snake_case，与 DSH 内置工具风格一致）。 */
const TOOL_NAME = 'popo_watcher_ping'

/**
 * 挂载插件：注册 ping 工具，并装配水群服务。
 * @param ctx - 宿主上下文，需提供 `tools` 服务。
 * @param config - 行 config，只读 `greeting`；缺省或非法时回落 `hello`。
 */
export function apply(ctx, config) {
  const greeting = typeof config?.greeting === 'string' && config.greeting !== ''
    ? config.greeting
    : 'hello'

  // 两个加载信号，各有用处：
  // - ctx.logger 是 DSH 的结构化日志通道（进入 logger buffer，web 日志面板可见），
  //   node 侧没有安装 console exporter，所以终端启动时看不到；
  // - console.log 是终端启动时唯一可见的信号（dsh web 打印 URL 也用 console.log）。
  // 两者都包了 try/catch：日志通道不可用**绝不能**让 apply 抛错（那会让 dsh web 起不来）。
  try {
    ctx.logger('popo-watcher').info('loaded: %s registered', TOOL_NAME)
  } catch {
    // 忽略：日志不可用不影响激活
  }
  try {
    console.log(`dsh-popo-watcher: loaded (tool ${TOOL_NAME})`)
  } catch {
    // 忽略：stdout 不可用不影响激活
  }

  ctx.tools.register({
    name: TOOL_NAME,
    description: 'Report that the dsh-popo-watcher plugin is loaded; echoes an optional message.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional text to echo back.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'plugin', 'version', 'greeting', 'node', 'cwd', 'time'],
        properties: {
          ok: { type: 'boolean' },
          plugin: { type: 'string' },
          version: { type: 'string' },
          greeting: { type: 'string' },
          message: { type: 'string' },
          node: { type: 'string' },
          cwd: { type: 'string' },
          time: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const message = typeof args?.message === 'string' && args.message !== '' ? args.message : undefined
      return {
        ok: true,
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        greeting,
        ...(message === undefined ? {} : { message }),
        node: process.version,
        cwd: process.cwd(),
        time: new Date().toISOString(),
      }
    },
  })

  mountPopoWatcher(ctx)
}

/**
 * 装配「POPO自动水群」服务：状态服务 + RPC + agent 工具 + 进程级单实例锁。
 *
 * 默认**不自动开窗**：安装即静默，只有窗口被显式开启（RPC `start` / 工具 / 恢复）之后
 * 才会采集、判读、发言。窗口开着时，每采到一批新消息就判一轮（`lib/round.js`）。
 *
 * @param ctx - 宿主上下文。
 */
function mountPopoWatcher(ctx) {
  try {
    const log = (message) => {
      try {
        ctx.logger('popo-watcher').info(message)
      } catch {
        // 日志通道不可用时也不能抛
      }
    }

    // 传输层惰性构造：subprocess 服务可能后到，且换实例（HMR）时要跟着换；
    // 配置里的 popoCliJs 变了也要换（设置页改完不用重启宿主）。
    let transportCache = { service: undefined, cliJs: undefined, transport: null }
    const getTransport = () => {
      let service
      try {
        service = ctx.get('subprocess')
      } catch {
        service = undefined
      }
      if (!service?.spawn) return null
      const cliJs = (() => {
        try {
          const configured = readConfig()?.popoCliJs
          return typeof configured === 'string' ? configured.trim() : ''
        } catch {
          return ''
        }
      })()
      if (transportCache.service !== service || transportCache.cliJs !== cliJs) {
        transportCache = {
          service,
          cliJs,
          transport: createTransport({
            spawn: (spec) => service.spawn(spec),
            // 显式路径优先（配置项 popoCliJs），留空则自动探测 npm 全局布局。
            resolve: () => resolveCli(cliJs === '' ? {} : { explicit: cliJs }),
            logger: log,
          }),
        }
      }
      return transportCache.transport
    }

    // 当前配置读法：watcher 造好之前先用默认值，造好之后改成读 watcher 的活配置
    // （judge 的模型档、llm 的路由都跟着设置页改动走，不用重启宿主）。
    let readConfig = () => configModule.defaultConfig()

    // 判读客户端（TypeSafe/Jev）：每次调用现造一个薄封装，模型与超时都取当下配置。
    // key 解析顺序 = 设置页存的 secret.json → 进程环境变量 → 用户作用域环境变量（HKCU\Environment）。
    const makeJudge = () => {
      const cfg = readConfig()
      return createJudge({
        fetchImpl: typeof globalThis.fetch === 'function' ? (input, init) => globalThis.fetch(input, init) : undefined,
        getKey: () => resolveKey({ name: 'TYPESAFE_API_KEY', file: storedKeyFile(storeModule.dataRoot()) }),
        model: typeof cfg?.judge?.model === 'string' && cfg.judge.model !== '' ? cfg.judge.model : 'jev-latest',
        timeoutMs: Number.isFinite(cfg?.judge?.timeoutMs) ? cfg.judge.timeoutMs : 8000,
        logger: log,
      })
    }
    const judgeClient = {
      available: () => makeJudge().available(),
      listModels: () => makeJudge().listModels(),
      runRound: (state, questions) => makeJudge().runRound(state, questions),
      runDraft: (state, questions) => makeJudge().runDraft(state, questions),
    }

    const getDefaultSelection = () => {
      try { return ctx.get('agentDefaultModel')?.currentSelection?.() ?? null } catch { return null }
    }
    const getModelSelection = () => resolveDraftRoute(readConfig(), getDefaultSelection())

    // 调用与状态展示读同一路由，目录查询只在设置页显式请求时发生。
    const draftWriter = createDraftWriter({
      getLlm: () => ctx.get('llm'),
      getRoute: getModelSelection,
      logger: log,
    })

    const watcher = createWatcher({
      store: storeModule,
      config: configModule,
      logger: log,
      getTransport,
      judgeClient,
      draftWriter,
      getModelSelection,
      checkStartup: () => checkCodeMakerConnection({
        getRoute: getModelSelection,
        getLlm: () => ctx.get('llm'),
        getSettings: () => ctx.get('settings'),
      }),
    })
    readConfig = () => watcher.getConfig().config ?? configModule.defaultConfig()

    registerRpc(ctx, createRpcHandler({ watcher, listModels: async ({ scope }) => {
      if (scope === 'judge') return { judge: await judgeClient.listModels() }
      const [llm, judge] = await Promise.allSettled([
        listDraftModels({ getLlm: () => ctx.get('llm'), getDefaultSelection }),
        judgeClient.listModels(),
      ])
      return {
        llm: llm.status === 'fulfilled' ? llm.value : { ok: false, providers: [], error: '宿主模型目录读取失败' },
        judge: judge.status === 'fulfilled' ? judge.value : { ok: false, models: [], error: '判读模型目录读取失败' },
      }
    } }))

    const tools = createTools({ watcher })
    for (const tool of tools) {
      ctx.tools.register(tool)
    }

    // 单实例锁：HMR 重载会在同一进程里再跑一次 apply，必须先把旧实例 dispose 掉，
    // 否则两个循环并联会重复发言。
    const release = claimSingleton(globalThis, { dispose: () => watcher.dispose() })

    // 装完才算"水群器就绪"：装配整体包在 try/catch 里（见函数末尾），失败会静默降级成
    // 没有水群器。所以这里打一条终端可见的信号——起不来时能一眼看出是哪一步没成。
    try {
      console.log(`dsh-popo-watcher: popo watcher ready (tools: ${tools.map((tool) => tool.name).join(', ')})`)
    } catch {
      // stdout 不可用不影响激活
    }

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        // 延迟到下一个 tick 再恢复：boot 阶段不读盘、不起子进程（避免拖慢启动）。
        const timer = setTimeout(() => {
          void watcher.resume()
        }, 0)
        return () => {
          try {
            clearTimeout(timer)
          } catch {
            // 忽略
          }
          try {
            release()
          } catch {
            // 释放失败不影响卸载
          }
          watcher.dispose()
        }
      }, 'dsh-popo-watcher: popo watcher')
    }
  } catch (error) {
    // 水群器初始化失败绝不能让插件行挂掉（否则 DSH 起不来）。
    try {
      ctx.logger('popo-watcher').warn(`水群器初始化失败（已跳过）：${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // ignore
    }
  }
}
