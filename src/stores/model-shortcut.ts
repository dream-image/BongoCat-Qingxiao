import { defineStore } from 'pinia'
import { nextTick, reactive, ref } from 'vue'

import type { Model } from '@/stores/model'

import { useModelRegistryStore } from '@/stores/model'

export const useModelShortcutStore = defineStore('model-shortcut', () => {
  const shortcuts = reactive<Record<string, string>>({})
  const legacyMigrated = ref(false)

  const init = async (legacy: Record<string, string>, previousModels: Model[]) => {
    let changed = false

    if (!legacyMigrated.value) {
      for (const [key, shortcut] of Object.entries(legacy)) {
        if (shortcuts[key] !== undefined) continue

        shortcuts[key] = shortcut
      }

      legacyMigrated.value = true
      changed = true
    }

    const registryStore = useModelRegistryStore()

    for (const previous of previousModels.filter(model => model.isPreset && model.renderer === 'live2d')) {
      const next = registryStore.models.find((model) => {
        return model.isPreset && model.renderer === 'live2d' && model.mode === previous.mode
      })

      if (!next || previous.id === next.id) continue

      const prefix = `${previous.id}:`

      for (const [key, shortcut] of Object.entries(shortcuts)) {
        if (!key.startsWith(prefix)) continue

        const nextKey = `${next.id}:${key.slice(prefix.length)}`

        if (!shortcuts[nextKey]) shortcuts[nextKey] = shortcut

        delete shortcuts[key]
        changed = true
      }
    }

    if (!changed) return

    // 旧 model 快照只迁移一次，立即落盘后生成快捷键拥有独立的同步版本。
    await nextTick()
    await useModelShortcutStore().$tauri.saveNow()
  }

  return {
    shortcuts,
    legacyMigrated,
    init,
  }
}, {
  tauri: {
    filterKeys: ['shortcuts', 'legacyMigrated'],
    filterKeysStrategy: 'pick',
  },
})
