<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { remove } from '@tauri-apps/plugin-fs'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useElementSize } from '@vueuse/core'
import { Card, Masonry, message, Popconfirm } from 'antdv-next'
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Model } from '@/stores/model'

import { useCatStore } from '@/stores/cat'
import { useModelRegistryStore } from '@/stores/model'
import { useModelRuntimeStore } from '@/stores/model-runtime'
import { useModelSelectionStore } from '@/stores/model-selection'
import { join } from '@/utils/path'

import BehaviorModal from './components/behavior-modal/index.vue'
import FloatMenu from './components/float-menu/index.vue'
import Upload from './components/upload/index.vue'

const catStore = useCatStore()
const modelRegistryStore = useModelRegistryStore()
const modelRuntimeStore = useModelRuntimeStore()
const modelSelectionStore = useModelSelectionStore()
const firstCardRef = useTemplateRef('firstCard')
const { height } = useElementSize(firstCardRef)
const { t } = useI18n()
const openBehaviorModal = ref(false)
const failedCoverIds = ref(new Set<string>())
const deletingIds = new Set<string>()
const behaviorEnabled = computed(() => {
  return modelSelectionStore.currentModel?.renderer === 'sprite'
    ? catStore.pet.enabled
    : catStore.model.behavior
})

const masonryItems = computed(() => {
  const items = modelRegistryStore.models.map((item) => {
    return {
      key: item.id,
      data: item,
    }
  })

  return [{ key: 'upload', data: null }, ...items]
})

function handleToggle(nextModel: Model) {
  if (modelSelectionStore.currentModel?.id === nextModel.id) return

  modelRuntimeStore.modelReady = false

  modelSelectionStore.currentModel = nextModel
}

async function handleDelete(item: Model) {
  const { id, path } = item
  const wasSelected = id === modelSelectionStore.currentModel?.id

  if (deletingIds.has(id)) return

  deletingIds.add(id)

  try {
    await remove(path, { recursive: true })

    modelRegistryStore.models = modelRegistryStore.models.filter(item => item.id !== id)

    if (wasSelected) {
      modelSelectionStore.currentModel = modelRegistryStore.models[0]
    }

    await nextTick()
    await Promise.all([
      modelRegistryStore.$tauri.saveNow(),
      modelSelectionStore.$tauri.saveNow(),
    ])

    message.success(t('pages.preference.model.hints.deleteSuccess'))
  } catch (error) {
    message.error(String(error))
  } finally {
    deletingIds.delete(id)
  }
}

function handleCoverError(id: string) {
  failedCoverIds.value.add(id)
}
</script>

<template>
  <Masonry
    :columns="{ xs: 3, lg: 4, xxl: 6 }"
    :gutter="16"
    :items="masonryItems"
  >
    <template #itemRender="{ data, index }">
      <template v-if="!data">
        <Upload :style="{ height: `${height}px` }" />
      </template>

      <Card
        v-else
        :ref="index === 1 ? 'firstCard' : void 0"
        :classes="{
          actions: `[&>li]:(flex justify-center) [&>li>span]:(inline-flex! justify-center text-4!)`,
        }"
        hoverable
        size="small"
        @click="handleToggle(data)"
      >
        <template #cover>
          <div
            v-if="failedCoverIds.has(data.id)"
            class="w-full flex items-center justify-center bg-[--ant-color-fill-quaternary] text-12 text-[--ant-color-text-quaternary]"
            style="aspect-ratio: 612 / 354"
          >
            <i class="i-lucide:image-off" />
          </div>

          <img
            v-else
            alt="example"
            :src="convertFileSrc(join(data.path, 'resources', 'cover.png'))"
            @error="handleCoverError(data.id)"
          >
        </template>

        <template #actions>
          <i
            class="i-lucide:circle-check"
            :class="{ 'text-success': data.id === modelSelectionStore.currentModel?.id }"
          />

          <i
            v-if="behaviorEnabled && modelSelectionStore.currentModel?.id === data.id"
            class="i-lucide:smile"
            @click.stop="openBehaviorModal = true"
          />

          <i
            class="i-lucide:folder-open"
            @click.stop="revealItemInDir(data.path)"
          />

          <template v-if="!data.isPreset">
            <Popconfirm
              :description="$t('pages.preference.model.hints.deleteModel')"
              placement="topRight"
              :title="$t('pages.preference.model.labels.deleteModel')"
              @confirm="handleDelete(data)"
            >
              <i
                class="i-lucide:trash-2"
                @click.stop
              />
            </Popconfirm>
          </template>
        </template>
      </Card>
    </template>
  </Masonry>

  <FloatMenu />

  <BehaviorModal
    v-if="behaviorEnabled"
    v-model="openBehaviorModal"
  />
</template>
