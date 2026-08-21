import { resolveResource } from '@tauri-apps/api/path'
import { readDir } from '@tauri-apps/plugin-fs'
import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'

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

export interface ModelRegistryInitContext {
  legacyCurrentModel?: Model
  legacyShortcuts: Record<string, string>
  previousModels: Model[]
}

let legacyCurrentModel: Model | undefined
let legacyShortcuts: Record<string, string> = {}

function normalizeModel(model: Model): Model {
  return {
    ...model,
    renderer: model.renderer ?? 'live2d',
  }
}

function captureLegacyState(state: Record<string, unknown>) {
  // 旧版把四个状态域存进 model；迁移只读取一次，之后 model 仅拥有模型注册表。
  if (state.currentModel && typeof state.currentModel === 'object') {
    legacyCurrentModel = normalizeModel(state.currentModel as Model)
  }

  if (state.shortcuts && typeof state.shortcuts === 'object') {
    legacyShortcuts = { ...state.shortcuts as Record<string, string> }
  }

  return state
}

export const useModelRegistryStore = defineStore('model', () => {
  const models = ref<Model[]>([])

  const init = async (): Promise<ModelRegistryInitContext> => {
    const modelsPath = await resolveResource('assets/models')
    const previousModels = models.value.map(normalizeModel)
    const previousCustomModels = previousModels.filter(model => !model.isPreset)
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

    models.value = [...spriteModels, ...live2dModels, ...customModels]

    return {
      legacyCurrentModel,
      legacyShortcuts: { ...legacyShortcuts },
      previousModels,
    }
  }

  const registerCustomModel = async (model: Model) => {
    const previousModels = models.value.map(item => ({ ...item }))

    if (models.value.some(item => item.id === model.id)) {
      throw new Error(`Model id already exists: ${model.id}`)
    }

    models.value = [...models.value, model]

    try {
      // saveNow 的成功返回是导入成功的持久化确认，不能让普通自动保存定时机代替它。
      await nextTick()
      await useModelRegistryStore().$tauri.saveNow()
    } catch (error) {
      models.value = previousModels

      // 同步层可能已收到失败注册的快照，回滚也必须立即推回并尝试持久化。
      await nextTick()
      await useModelRegistryStore().$tauri.saveNow().catch(() => {})

      throw error
    }
  }

  return {
    models,
    init,
    registerCustomModel,
  }
}, {
  tauri: {
    // 注册表拥有唯一持久化文件；旧 store 的选择、快捷键和运行态不会再被回写。
    filterKeys: ['models'],
    filterKeysStrategy: 'pick',
    hooks: {
      beforeFrontendSync: captureLegacyState,
    },
  },
})
