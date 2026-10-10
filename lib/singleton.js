/**
 * 进程级单实例锁。
 *
 * 为什么需要：`dsh-hmr` 热重载插件时会在同一个宿主进程里**再跑一次 apply**。
 * 如果旧实例没被 dispose 干净，就会出现两个轮询循环并联——两边都可能决定发言，
 * 结果是群里重复说话。这里用 globalThis 上的一个键保证任何时刻只有一个实例活着。
 *
 * 约束：本模块不得抛错（宿主进程里一次未处理异常就可能让 `dsh web` 退出）。
 *
 * @module dsh-popo-watcher/singleton
 */

/** globalThis 上的键名（带插件命名空间，避免与别的插件撞）。 */
export const SINGLETON_KEY = '__dshPopoWatcher'

/**
 * 认领单实例位：先 dispose 上一个实例，再把当前实例放上去。
 * @param target - 承载锁的对象，生产用 globalThis，测试可传普通对象。
 * @param instance - 当前实例，需提供幂等的 `dispose()`。
 * @returns 释放函数：仅当当前实例仍是自己时清空锁；幂等、不抛。
 */
export function claimSingleton(target, instance) {
  try {
    const previous = target[SINGLETON_KEY]
    if (previous !== undefined && previous !== instance) {
      try {
        previous.dispose?.()
      } catch (error) {
        // 旧实例清理失败不能连累新实例；这里只吞掉，调用方日志由上层负责。
        void error
      }
    }
    target[SINGLETON_KEY] = instance
    return () => {
      try {
        if (target[SINGLETON_KEY] === instance) delete target[SINGLETON_KEY]
      } catch (error) {
        void error
      }
    }
  } catch (error) {
    void error
    return () => {}
  }
}

/**
 * 读取当前持锁实例（诊断用）。
 * @param target - 承载锁的对象。
 * @returns 当前实例，或 undefined。
 */
export function currentSingleton(target) {
  try {
    return target[SINGLETON_KEY]
  } catch {
    return undefined
  }
}
