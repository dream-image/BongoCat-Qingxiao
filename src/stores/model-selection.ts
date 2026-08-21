import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { Model } from '@/stores/model'

import { useModelRegistryStore } from '@/stores/model'

function findMigratedModel(models: Model[], previous: Model | undefined) {
  if (!previous) return undefined

  if (!previous.isPreset) {
    return models.find(model => model.id === previous.id)
  }

  if (previous.renderer === 'sprite') {
    const byPath = models.find(model => model.renderer === 'sprite' && model.path === previous.path)

    if (byPath) return byPath

    const legacyId = previous.id.replace(/^preset-(?:sprite-)?/, '')

    return models.find(model => model.id === `preset-sprite-${legacyId}`)
  }

  return models.find(model => model.renderer === 'live2d' && model.mode === previous.mode)
}

export const useModelSelectionStore = defineStore('model-selection', () => {
  const registryStore = useModelRegistryStore()
  const selectedModelId = ref<string>()
  const currentModel = computed<Model | undefined>({
    get: () => registryStore.models.find(model => model.id === selectedModelId.value),
    set: model => selectedModelId.value = model?.id,
  })

  const init = (legacyCurrentModel?: Model) => {
    const persisted = registryStore.models.find(model => model.id === selectedModelId.value)
    const migrated = findMigratedModel(registryStore.models, legacyCurrentModel)

    // 选择域只保存稳定 id；模型路径和渲染类型始终从已复验的注册表解析。
    selectedModelId.value = (persisted ?? migrated ?? registryStore.models[0])?.id
  }

  return {
    selectedModelId,
    currentModel,
    init,
  }
}, {
  tauri: {
    filterKeys: ['selectedModelId'],
    filterKeysStrategy: 'pick',
  },
})
