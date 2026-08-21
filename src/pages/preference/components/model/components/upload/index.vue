<script setup lang="ts">
import type { PhysicalPosition } from '@tauri-apps/api/dpi'

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open } from '@tauri-apps/plugin-dialog'
import { remove } from '@tauri-apps/plugin-fs'
import { message } from 'antdv-next'
import { nanoid } from 'nanoid'
import { onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { INVOKE_KEY } from '@/constants'
import { useModelRegistryStore } from '@/stores/model'
import { validateModelDirectory } from '@/utils/model-validation'

const dropRef = useTemplateRef('drop')
const dragenter = ref(false)
const importing = ref(false)
const selectPaths = ref<string[]>([])
const modelRegistryStore = useModelRegistryStore()
const { t } = useI18n()
const appWindow = getCurrentWebviewWindow()
let disposed = false
let unlisten: (() => void) | undefined

async function isInDropZone(position: PhysicalPosition) {
  if (!dropRef.value) return false

  const scaleFactor = await appWindow.scaleFactor()
  const { x, y } = position.toLogical(scaleFactor)
  const { left, right, top, bottom } = dropRef.value.getBoundingClientRect()

  return x >= left && x <= right && y >= top && y <= bottom
}

onMounted(async () => {
  const unregister = await appWindow.onDragDropEvent(({ payload }) => {
    void (async () => {
      if (payload.type === 'leave') {
        dragenter.value = false
        return
      }

      const inDropZone = await isInDropZone(payload.position)

      if (payload.type === 'drop') {
        if (inDropZone && !importing.value) {
          selectPaths.value = payload.paths
        }

        dragenter.value = false
        return
      }

      dragenter.value = inDropZone
    })()
  })

  if (disposed) {
    unregister()
  } else {
    unlisten = unregister
  }
})

onUnmounted(() => {
  disposed = true
  unlisten?.()
})

async function handleUpload() {
  if (importing.value) return

  const selected = await open({ directory: true, multiple: true })

  if (!selected) return

  selectPaths.value = selected
}

watch(selectPaths, async (paths) => {
  if (paths.length === 0 || importing.value) return

  importing.value = true

  try {
    for (const fromPath of paths) {
      let toPath: string | undefined

      try {
        const id = nanoid()

        toPath = await invoke<string>(INVOKE_KEY.IMPORT_MODEL_DIRECTORY, {
          fromPath,
          modelId: id,
        })

        const storedModel = await validateModelDirectory(toPath, {
          decodeSpriteAssets: true,
        })

        await modelRegistryStore.registerCustomModel({
          id,
          path: toPath,
          mode: storedModel.mode,
          renderer: storedModel.renderer,
          displayName: storedModel.displayName,
          isPreset: false,
        })

        message.success(t('pages.preference.model.hints.importSuccess'))
      } catch (error) {
        if (toPath) {
          await remove(toPath, { recursive: true }).catch(() => {})
        }

        message.error(String(error))
      }
    }
  } finally {
    selectPaths.value = []
    importing.value = false
  }
})
</script>

<template>
  <div
    ref="drop"
    class="w-full flex flex-col cursor-pointer items-center justify-center gap-4 b-1 b-dashed bg-[--ant-color-fill-quaternary] transition b-border rounded-lg hover:border-primary"
    :class="{ 'border-primary': dragenter }"
    @click="handleUpload"
  >
    <div class="i-solar:upload-square-outline text-12 text-primary" />

    <span>{{ $t('pages.preference.model.hints.clickOrDragToImport') }}</span>
  </div>
</template>
