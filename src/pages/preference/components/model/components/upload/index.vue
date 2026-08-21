<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open } from '@tauri-apps/plugin-dialog'
import { exists, readDir, remove } from '@tauri-apps/plugin-fs'
import { message } from 'antdv-next'
import { nanoid } from 'nanoid'
import { onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ModelMode, ModelRenderer } from '@/stores/model'

import { INVOKE_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import live2d from '@/utils/live2d'
import { join, readBoundedTextFile, resolveModelResourcePath } from '@/utils/path'
import sprite from '@/utils/sprite'

const MAX_MODEL_MANIFEST_BYTES = 1024 * 1024

const dropRef = useTemplateRef('drop')
const dragenter = ref(false)
const selectPaths = ref<string[]>([])
const modelStore = useModelStore()
const { t } = useI18n()

interface ValidatedModelImport {
  mode: ModelMode
  renderer: ModelRenderer
  displayName?: string
}

onMounted(() => {
  const appWindow = getCurrentWebviewWindow()

  appWindow.onDragDropEvent(({ payload }) => {
    const { type } = payload

    if (type === 'over') {
      const { x, y } = payload.position

      if (dropRef.value) {
        const { left, right, top, bottom } = dropRef.value.getBoundingClientRect()

        const inBoundsX = x >= left && x <= right
        const inBoundsY = y >= top && y <= bottom

        dragenter.value = inBoundsX && inBoundsY
      }
    } else if (type === 'drop' && dragenter.value) {
      dragenter.value = false

      selectPaths.value = payload.paths
    } else {
      dragenter.value = false
    }
  })
})

async function handleUpload() {
  const selected = await open({ directory: true, multiple: true })

  if (!selected) return

  selectPaths.value = selected
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function detectLive2DMode(path: string): Promise<ModelMode> {
  const files = await readDir(join(path, 'resources', 'right-keys')).catch(() => [])

  if (files.length === 0) return 'standard'

  const fileNames = files.map(file => file.name.split('.')[0])

  return fileNames.includes('East') ? 'gamepad' : 'keyboard'
}

async function validateModelImport(path: string): Promise<ValidatedModelImport> {
  const manifestCandidate = join(path, 'model.json')

  if (await exists(manifestCandidate)) {
    const manifestPath = await resolveModelResourcePath(path, 'model.json')
    const content = await readBoundedTextFile(
      manifestPath,
      MAX_MODEL_MANIFEST_BYTES,
      'Model manifest',
    )
    const manifest = JSON.parse(content) as unknown

    if (!isRecord(manifest)) {
      throw new TypeError('Model manifest must be an object')
    }

    if (manifest.renderer === 'sprite') {
      const validatedManifest = await sprite.validateModel(path)

      await resolveModelResourcePath(path, 'resources/cover.png')

      return {
        renderer: 'sprite',
        mode: validatedManifest.mode ?? 'standard',
        displayName: validatedManifest.displayName,
      }
    }

    if (manifest.renderer !== undefined && manifest.renderer !== 'live2d') {
      throw new TypeError(`Unsupported model renderer: ${String(manifest.renderer)}`)
    }
  }

  await live2d.validateModel(path)
  await resolveModelResourcePath(path, 'resources/cover.png')

  return {
    renderer: 'live2d',
    mode: await detectLive2DMode(path),
  }
}

watch(selectPaths, async (paths) => {
  for await (const fromPath of paths) {
    try {
      const id = nanoid()
      const detectedModel = await validateModelImport(fromPath)

      const toPath = join(await appDataDir(), 'custom-models', id)

      await invoke(INVOKE_KEY.COPY_DIR, {
        fromPath,
        toPath,
      })

      let storedModel: ValidatedModelImport

      try {
        // 复制后重新校验实际落盘内容，关闭“校验完成到复制开始”之间源目录被替换的窗口。
        storedModel = await validateModelImport(toPath)

        if (storedModel.renderer !== detectedModel.renderer) {
          throw new Error('Model renderer changed while importing')
        }
      } catch (error) {
        await remove(toPath, { recursive: true }).catch(() => {})
        throw error
      }

      modelStore.models.push({
        id,
        path: toPath,
        mode: storedModel.mode,
        renderer: storedModel.renderer,
        displayName: storedModel.displayName,
        isPreset: false,
      })

      message.success(t('pages.preference.model.hints.importSuccess'))
    } catch (error) {
      message.error(String(error))
    }
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
