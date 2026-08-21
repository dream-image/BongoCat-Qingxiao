<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open } from '@tauri-apps/plugin-dialog'
import { remove } from '@tauri-apps/plugin-fs'
import { message } from 'antdv-next'
import { nanoid } from 'nanoid'
import { onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ValidatedModelDirectory } from '@/utils/model-validation'

import { INVOKE_KEY } from '@/constants'
import { useModelRegistryStore } from '@/stores/model'
import { validateModelDirectory } from '@/utils/model-validation'

const dropRef = useTemplateRef('drop')
const dragenter = ref(false)
const selectPaths = ref<string[]>([])
const modelRegistryStore = useModelRegistryStore()
const { t } = useI18n()

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

watch(selectPaths, async (paths) => {
  for await (const fromPath of paths) {
    try {
      const id = nanoid()
      const detectedModel = await validateModelDirectory(fromPath)

      // 前端只提交不可解释为路径的模型 ID；实际目标必须由 Rust 的应用数据目录解析器生成并回传。
      const toPath = await invoke<string>(INVOKE_KEY.IMPORT_MODEL_DIRECTORY, {
        fromPath,
        modelId: id,
      })

      let storedModel: ValidatedModelDirectory

      try {
        // 复制后重新校验实际落盘内容，关闭“校验完成到复制开始”之间源目录被替换的窗口。
        storedModel = await validateModelDirectory(toPath)

        if (storedModel.renderer !== detectedModel.renderer) {
          throw new Error('Model renderer changed while importing')
        }

        // 成功提示必须等注册表的 saveNow 确认；注册或落盘失败由 store 回滚旧快照。
        await modelRegistryStore.registerCustomModel({
          id,
          path: toPath,
          mode: storedModel.mode,
          renderer: storedModel.renderer,
          displayName: storedModel.displayName,
          isPreset: false,
        })
      } catch (error) {
        // 复制目录与注册表必须同生共死，不能留下未注册的孤儿模型。
        await remove(toPath, { recursive: true }).catch(() => {})
        throw error
      }

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
