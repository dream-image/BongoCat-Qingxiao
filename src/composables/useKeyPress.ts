import type { ShortcutHandler } from '@tauri-apps/plugin-global-shortcut'
import type { Ref } from 'vue'

import {
  isRegistered,
  register,
  unregister,
} from '@tauri-apps/plugin-global-shortcut'
import { onUnmounted, watch } from 'vue'

interface ShortcutRegistryEntry {
  handlers: Map<symbol, ShortcutHandler>
  operation: Promise<void>
  registered: boolean
}

const shortcutRegistry = new Map<string, ShortcutRegistryEntry>()

function scheduleShortcutReconcile(shortcut: string, entry: ShortcutRegistryEntry) {
  entry.operation = entry.operation
    .catch(() => void 0)
    .then(async () => {
      if (entry.handlers.size > 0) {
        if (entry.registered) return

        if (await isRegistered(shortcut)) await unregister(shortcut)
        if (entry.handlers.size === 0) return

        await register(shortcut, (event) => {
          if (event.state === 'Released') return

          const handlers = [...entry.handlers.values()]

          handlers[handlers.length - 1]?.(event)
        })
        entry.registered = true

        return
      }

      if (entry.registered || await isRegistered(shortcut)) {
        await unregister(shortcut)
      }

      entry.registered = false

      if (shortcutRegistry.get(shortcut) === entry && entry.handlers.size === 0) {
        shortcutRegistry.delete(shortcut)
      }
    })

  void entry.operation.catch((reason) => {
    console.error(`Failed to reconcile global shortcut ${shortcut}:`, reason)
  })
}

function attachShortcut(shortcut: string, owner: symbol, callback: ShortcutHandler) {
  const entry = shortcutRegistry.get(shortcut) ?? {
    handlers: new Map<symbol, ShortcutHandler>(),
    operation: Promise.resolve(),
    registered: false,
  }

  entry.handlers.set(owner, callback)
  shortcutRegistry.set(shortcut, entry)
  scheduleShortcutReconcile(shortcut, entry)
}

function detachShortcut(shortcut: string, owner: symbol) {
  const entry = shortcutRegistry.get(shortcut)

  if (!entry) return

  entry.handlers.delete(owner)
  scheduleShortcutReconcile(shortcut, entry)
}

export function useKeyPress(shortcut: Ref<string | undefined, string>, callback: ShortcutHandler) {
  const owner = Symbol('shortcut-owner')
  let currentShortcut = ''

  watch(shortcut, (value) => {
    const nextShortcut = value ?? ''

    if (nextShortcut === currentShortcut) return

    if (currentShortcut) detachShortcut(currentShortcut, owner)

    currentShortcut = nextShortcut

    if (currentShortcut) attachShortcut(currentShortcut, owner, callback)
  }, { immediate: true })

  onUnmounted(() => {
    if (currentShortcut) detachShortcut(currentShortcut, owner)

    currentShortcut = ''
  })
}
