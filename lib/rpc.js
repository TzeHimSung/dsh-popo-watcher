/**
 * 设置页 ↔ 宿主 的 RPC 端点表。
 *
 * 通道名固定在 `CHANNEL`，客户端用
 * `connection.rpc.call('/popo-watcher', '<endpoint>', payload)` 调用。
 *
 * 纪律：
 * - 处理器**绝不抛错**：任何异常都转成 `{ok:false, error:{message}}`，否则可能在传输层变成
 *   未处理的 rejection，把宿主进程带走（GUI 会直接掉线）。
 * - 无 `connection` 服务（非 web 组合）时静默跳过注册，不影响宿主行激活。
 *
 * @module dsh-popo-watcher/rpc
 */

/** RPC 通道名。 */
export const CHANNEL = '/popo-watcher'

/** 成功信封。 */
export function rpcOk(value) {
  return { ok: true, value }
}

/** 失败信封。 */
export function rpcFail(message) {
  return { ok: false, error: { code: 'popo-watcher/error', message: String(message ?? '未知错误'), details: {} } }
}

/**
 * 创建 RPC 处理器。
 * @param options - 依赖注入。
 * @param options.watcher - `lib/watcher.js` 的实例。
 * @param options.judge - `lib/judge.js` 模块（P2 用；P0 可为 undefined）。
 * @param options.listModels - 只读模型目录，支持 `{scope:'all'|'judge'}`。
 * @returns `(endpoint, payload) => Promise<RpcResult>`，永不抛。
 */
export function createRpcHandler({ watcher, judge, listModels } = {}) {
  return async function handle(endpoint, payload) {
    try {
      if (typeof endpoint !== 'string' || endpoint === '') return rpcFail('缺少端点名')
      const input = payload !== null && typeof payload === 'object' ? payload : {}

      switch (endpoint) {
        case 'status': {
          if (!watcher?.status) return rpcFail('watcher 不可用')
          const result = await watcher.status()
          return result?.ok === true ? rpcOk(result.value)
            : rpcFail(typeof result?.error === 'string' ? result.error : result?.error?.message ?? '读取运行状态失败')
        }

        case 'cli.check': {
          if (!watcher?.checkCli) return rpcFail('watcher 不可用，请重新加载插件后检查 POPO CLI')
          const result = await watcher.checkCli()
          const uid = typeof result?.value?.uid === 'string' ? result.value.uid : ''
          // RPC 成功表示检查已完成；healthy 才表示 CLI 可启动且登录状态正常。
          return rpcOk({
            healthy: result?.ok === true,
            message: result?.ok === true
              ? `POPO CLI 可正常启动，登录状态正常${uid ? `（${uid}）` : ''}。采集结果请查看“最近采集”。`
              : String(result?.error ?? '无法确认 POPO CLI 状态，请重试检查。'),
          })
        }

        case 'config.get': {
          if (!watcher?.getConfig) return rpcFail('watcher 不可用')
          const result = watcher.getConfig({ reload: input.reload === true })
          if (result?.ok !== true) return rpcFail(result?.error ?? '读取配置失败')
          return rpcOk({ config: result.config, warnings: result.warnings ?? [], configState: result.configState })
        }

        case 'models.list': {
          if (typeof listModels !== 'function') return rpcFail('模型目录不可用，请重新加载插件')
          const scope = input.scope ?? 'all'
          if (scope !== 'all' && scope !== 'judge') return rpcFail('模型目录 scope 只能为 all / judge')
          return rpcOk(await listModels({ scope }))
        }

        case 'config.set': {
          if (!watcher?.updateConfig) return rpcFail('watcher 不可用')
          if (input.patch === null || typeof input.patch !== 'object') return rpcFail('patch 必须是对象')
          const result = await watcher.updateConfig(input.patch)
          if (result?.ok !== true) return rpcFail(result?.error ?? '保存配置失败')
          return rpcOk({ config: result.config, warnings: result.warnings ?? [], configState: result.configState, written: result.written === true })
        }

        case 'start': {
          if (!watcher?.startWindow) return rpcFail('watcher 不可用')
          const hours = Number.isFinite(input.hours) ? Number(input.hours) : undefined
          const result = await watcher.startWindow(hours === undefined ? {} : { hours })
          if (result?.ok !== true) return rpcFail(result?.error ?? '开窗失败')
          // opening 是"开窗时顺手发的那句招呼"的结果（可能被守卫拒绝，也可能没配）。
          return rpcOk({ window: result.window, polling: result.polling === true, recovering: result.recovering === true, opening: result.opening ?? null })
        }

        case 'stop': {
          if (!watcher?.stop) return rpcFail('watcher 不可用')
          const mode = input.mode === 'mute' ? 'mute' : 'stop'
          const result = await watcher.stop({ mode, reason: input.reason })
          if (result?.ok !== true) return rpcFail(result?.error ?? '停止失败')
          return rpcOk({ mode: result.mode, stoppedAt: result.stoppedAt })
        }

        case 'messages': {
          if (!watcher?.messages) return rpcFail('watcher 不可用')
          const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(200, Math.floor(input.limit))) : 30
          const result = await watcher.messages(limit)
          if (result?.ok !== true) return rpcFail(result?.error ?? '读取消息失败')
          return rpcOk({ rows: result.rows ?? [], limit, group: result.group, fetchedAt: result.fetchedAt })
        }

        case 'sends': {
          if (!watcher?.sends) return rpcFail('watcher 不可用')
          const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(200, Number(input.limit))) : 20
          const result = watcher.sends(limit)
          if (result?.ok !== true) return rpcFail(result?.error ?? '读取发言记录失败')
          return rpcOk({ rows: result.rows ?? [], limit })
        }

        case 'log': {
          if (!watcher?.log) return rpcFail('watcher 不可用')
          const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(500, Number(input.limit))) : 50
          const result = watcher.log(limit)
          if (result?.ok !== true) return rpcFail(result?.error ?? '读取日志失败')
          return rpcOk({ lines: result.lines ?? [], limit })
        }

        case 'judge.now': {
          if (!watcher?.judgeNow) return rpcFail('watcher 不可用')
          const result = await watcher.judgeNow({
            draft: typeof input.draft === 'string' ? input.draft : undefined,
          })
          if (result?.ok !== true) return rpcFail(result?.error ?? '判读失败')
          return rpcOk(result)
        }

        case 'send.now': {
          if (!watcher?.sendNow) return rpcFail('watcher 不可用')
          const text = typeof input.text === 'string' ? input.text : ''
          if (text.trim() === '') return rpcFail('消息不能为空')
          const result = await watcher.sendNow({ text, opening: input.opening === true, manual: true })
          if (result?.ok !== true) {
            const detail = result?.detail ? `：${result.detail}` : ''
            return rpcFail(`${result?.reason ?? '发送失败'}${detail}`)
          }
          return rpcOk({ msgId: result.msgId ?? '', dryRun: result.dryRun === true, warnings: result.warnings ?? [],
            ...(typeof result.stateWritten === 'boolean' ? { stateWritten: result.stateWritten } : {}) })
        }

        case 'key.status': {
          if (!watcher?.keyStatus) return rpcFail('watcher 不可用')
          const result = await watcher.keyStatus()
          if (result?.ok !== true) return rpcFail(result?.error ?? '读取 key 状态失败')
          // 只回"有没有 + 从哪来"，绝不回显 key。
          return rpcOk({
            configured: result.configured === true,
            source: result.source ?? 'none',
            stored: result.stored === true,
          })
        }

        case 'key.set': {
          if (!watcher?.setKey) return rpcFail('watcher 不可用')
          const key = typeof input.key === 'string' ? input.key : ''
          if (key.trim() === '') return rpcFail('key 不能为空')
          if (/[\r\n]/.test(key)) return rpcFail('key 不能包含换行')
          const result = await watcher.setKey(key)
          if (result?.ok !== true) return rpcFail(result?.error ?? '保存 key 失败')
          return rpcOk({ configured: result.configured === true, source: result.source ?? 'file' })
        }

        case 'key.clear': {
          if (!watcher?.clearKey) return rpcFail('watcher 不可用')
          const result = await watcher.clearKey()
          if (result?.ok !== true) return rpcFail(result?.error ?? '清除 key 失败')
          return rpcOk({ configured: result.configured === true, source: result.source ?? 'none', stored: result.stored === true })
        }

        case 'importLegacy': {
          if (!watcher?.importLegacy) return rpcFail('watcher 不可用')
          const from = typeof input.from === 'string' ? input.from : undefined
          const result = await watcher.importLegacy(from === undefined ? {} : { from })
          if (result?.ok !== true) return rpcFail(result?.error ?? '导入失败')
          return rpcOk({ group: result.group, from: result.from, imported: result.imported ?? {}, skipped: result.skipped ?? {} })
        }

        default:
          return rpcFail(`未知端点: ${endpoint}`)
      }
    } catch (error) {
      // 兜底：处理器的任何异常都在这里被吃掉。
      return rpcFail(error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * 在宿主上注册 RPC 通道（惰性等待 connection 和 webServer，避免路由注册过早）。
 * @param ctx - 宿主插件上下文。
 * @param handler - `createRpcHandler()` 的返回值。
 */
export function registerRpc(ctx, handler) {
  try {
    if (typeof ctx?.inject !== 'function') return
    ctx.inject(['connection', 'webServer'], (scoped) => {
      try {
        const connection = scoped?.connection ?? scoped?.get?.('connection')
        if (!connection?.rpc?.handle) return
        const wrapped = async (endpoint, payload) => handler(endpoint, payload)
        connection.rpc.handle(CHANNEL, wrapped)
      } catch (error) {
        ctx.logger?.('popo-watcher')?.warn?.(`注册 RPC 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    // 注册失败不能影响插件激活。
    void error
  }
}
