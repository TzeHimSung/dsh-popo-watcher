/** DSH still receives a single self-registering browser script. */
import { SECTION_ID, SECTION_ORDER, SECTION_LABEL } from './constants.js'
import { installNavIconPatch } from './host.js'
import { installStyles } from './styles.js'
import { createUi } from './page.js'

window.__ModuleLoader__.load({
  id: 'dsh-popo-watcher',
  factory: require => {
    let uiCache = { react: null, page: null }
    function uiFor(React) {
      if (uiCache.react === React && uiCache.page !== null) return uiCache.page
      const built = createUi(React)
      uiCache = { react: React, page: built }
      return built
    }
    function apply(ctx) {
      ctx.effect(() => installNavIconPatch(), 'dsh-popo-watcher: settings nav icon')
      ctx.effect(() => installStyles(), 'dsh-popo-watcher: settings styles')

      // 取不到宿主连接就无法读状态：此时不注册页面（面板里只会少这一项，不影响别的功能）。
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (!connection) {
        console.warn('[dsh-popo-watcher] 无 connection 服务，跳过设置页注册')
        return
      }

      let React
      try {
        React = require('react')
      } catch (error) {
        console.warn(`[dsh-popo-watcher] require('react') 失败，跳过设置页注册：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (!React || typeof React.createElement !== 'function') {
        console.warn('[dsh-popo-watcher] 宿主 react 不可用，跳过设置页注册')
        return
      }

      const { Page } = uiFor(React)

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => SECTION_LABEL,
      }, () => Page({ connection })))
    }
    return { name: 'popo-watcher', inject: ['slots', 'connection'], apply }
  },
})
