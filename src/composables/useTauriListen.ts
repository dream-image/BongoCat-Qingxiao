import { listen } from '@tauri-apps/api/event'
import { noop } from '@vueuse/core'
import { onMounted, onUnmounted } from 'vue'

export function useTauriListen<T>(...args: Parameters<typeof listen<T>>) {
  let disposed = false
  let unlisten = noop
  let resolveReady = noop
  let rejectReady: (reason?: unknown) => void = noop
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  void ready.catch(noop)

  onMounted(async () => {
    try {
      const nextUnlisten = await listen<T>(...args)

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

  return ready
}
