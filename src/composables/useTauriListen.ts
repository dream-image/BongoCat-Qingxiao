import { listen } from '@tauri-apps/api/event'
import { noop } from '@vueuse/core'
import { onMounted, onUnmounted } from 'vue'

export function useTauriListen<T>(...args: Parameters<typeof listen<T>>) {
  let disposed = false
  let unlisten = noop
  let resolveReady = noop
  let rejectReady: (reason?: unknown) => void = noop

  // 原生监听启动前必须先等前端订阅完成，否则启动过程中发出的状态事件可能永久丢失。
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  // 这里只提前消费 rejection 以避免未 await 的调用方产生 unhandled rejection；返回给调用方的
  // 仍是原始 ready Promise，显式 await 时依旧能收到同一个安装错误。
  void ready.catch(noop)

  onMounted(async () => {
    try {
      const nextUnlisten = await listen<T>(...args)

      // listen 是异步的；若组件已卸载，立即释放刚创建的监听，避免残留回调访问旧状态。
      if (disposed) {
        nextUnlisten()
      } else {
        unlisten = nextUnlisten
      }

      resolveReady()
    } catch (reason) {
      rejectReady(reason)
    }
  })

  onUnmounted(() => {
    disposed = true
    unlisten()
  })

  // 调用方可用这个 Promise 建立“订阅完成后再启动生产者”的顺序保证。
  return ready
}
