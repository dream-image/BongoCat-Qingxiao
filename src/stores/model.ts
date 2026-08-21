import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { resolveResource } from '@tauri-apps/api/path'
import { readDir } from '@tauri-apps/plugin-fs'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

import type {
  ValidatedModelMode,
  ValidatedModelRenderer,
} from '@/utils/model-validation'

import { MODEL_MODES, validateModelDirectory } from '@/utils/model-validation'
import { join } from '@/utils/path'

export type ModelMode = ValidatedModelMode
export type ModelRenderer = ValidatedModelRenderer

export interface Model {
  id: string
  path: string
  mode: ModelMode
  renderer: ModelRenderer
  displayName?: string
  isPreset: boolean
}

export const useModelStore = defineStore('model', () => {
  const modelReady = ref(true)
  const models = ref<Model[]>([])
  const currentModel = ref<Model>()
  const supportKeys = reactive<Record<string, string>>({})
  const pressedKeys = reactive<Record<string, string>>({})
  const currentMotions = ref<Array<[string, MotionInfo[]]>>([])
  const currentExpressions = ref<ExpressionInfo[]>([])
  const shortcuts = reactive<Record<string, string>>({})

  const init = async () => {
    const modelsPath = await resolveResource('assets/models')
    const previousModels = models.value.map(model => ({
      ...model,
      renderer: model.renderer ?? ('live2d' as const),
    }))
    const previousCurrent = currentModel.value
      ? {
          ...currentModel.value,
          renderer: currentModel.value.renderer ?? ('live2d' as const),
        }
      : void 0

    const previousCustomModels = previousModels.filter(model => !model.isPreset)
    const previousPresetModels = previousModels.filter(model => model.isPreset)

    const spriteModels: Model[] = []
    const spriteIds = new Set<string>()
    const entries = await readDir(modelsPath).catch(() => [])

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory || MODEL_MODES.includes(entry.name as ModelMode)) continue

      const path = join(modelsPath, entry.name)

      try {
        const validated = await validateModelDirectory(path, {
          spriteDefaultMode: 'keyboard',
        })

        if (validated.renderer !== 'sprite') continue

        const manifestId = validated.id?.trim()
          ? validated.id.trim()
          : entry.name

        if (spriteIds.has(manifestId)) continue

        spriteIds.add(manifestId)

        spriteModels.push({
          id: `preset-sprite-${manifestId}`,
          mode: validated.mode,
          renderer: 'sprite',
          displayName: validated.displayName ?? entry.name,
          isPreset: true,
          path,
        })
      } catch {
        continue
      }
    }

    const live2dModels: Model[] = []

    for (const mode of MODEL_MODES.slice().reverse()) {
      const path = join(modelsPath, mode)

      try {
        const validated = await validateModelDirectory(path)

        if (validated.renderer !== 'live2d') continue

        live2dModels.push({
          id: `preset-live2d-${mode}`,
          mode,
          renderer: 'live2d',
          isPreset: true,
          path,
        })
      } catch {
        continue
      }
    }

    const customModels: Model[] = []

    // 持久化记录只是索引；启动时必须以当前落盘内容重建渲染类型和模式，失效目录不能重新进入模型列表。
    for (const previous of previousCustomModels) {
      try {
        const validated = await validateModelDirectory(previous.path)

        customModels.push({
          ...previous,
          mode: validated.mode,
          renderer: validated.renderer,
          displayName: validated.displayName ?? previous.displayName,
        })
      } catch {
        continue
      }
    }

    const nextModels = [...spriteModels, ...live2dModels, ...customModels]

    for (const previous of previousPresetModels) {
      if (previous.renderer !== 'live2d') continue

      const next = live2dModels.find(model => model.mode === previous.mode)

      if (!next || previous.id === next.id) continue

      const prefix = `${previous.id}:`

      for (const [key, shortcut] of Object.entries(shortcuts)) {
        if (!key.startsWith(prefix)) continue

        const nextKey = `${next.id}:${key.slice(prefix.length)}`

        if (!shortcuts[nextKey]) shortcuts[nextKey] = shortcut

        delete shortcuts[key]
      }
    }

    let matched: Model | undefined

    if (previousCurrent?.isPreset) {
      if (previousCurrent.renderer === 'sprite') {
        matched = spriteModels.find(model => model.path === previousCurrent.path)

        if (!matched) {
          const legacyId = previousCurrent.id.replace(/^preset-(?:sprite-)?/, '')

          matched = spriteModels.find(model => model.id === `preset-sprite-${legacyId}`)
        }
      } else {
        matched = live2dModels.find(model => model.mode === previousCurrent.mode)
      }
    } else if (previousCurrent) {
      matched = customModels.find(model => model.id === previousCurrent.id)
    }

    currentModel.value = matched ?? nextModels[0]

    models.value = nextModels
  }

  return {
    modelReady,
    models,
    currentModel,
    supportKeys,
    pressedKeys,
    currentMotions,
    currentExpressions,
    shortcuts,
    init,
  }
}, {
  tauri: {
    filterKeys: ['supportKeys', 'pressedKeys'],
  },
})
