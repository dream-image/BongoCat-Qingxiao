<script setup lang="ts">
import type { MotionInfo } from 'easy-live2d'

import { emit, emitTo } from '@tauri-apps/api/event'
import { Empty, Modal, Segmented, Spin } from 'antdv-next'
import { isEmpty } from 'es-toolkit/compat'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type {
  PetActionCatalogRequest,
  PetActionCatalogResponse,
  PetActionTriggerRequest,
  PetActionTriggerResponse,
} from '@/utils/pet-action-events'
import type { PetActionCatalogView } from '@/utils/pet-behavior'

import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { useModelStore } from '@/stores/model'
import { getPetActionShortcutId } from '@/utils/pet-action-events'

import BehaviorItem from './components/behavior-item/index.vue'

const modelValue = defineModel<boolean>()
const modelStore = useModelStore()
const { locale } = useI18n()
const value = ref<'active' | 'expression' | 'motion' | 'passive'>('motion')
const petCatalog = ref<PetActionCatalogView | null>(null)
const petCatalogLoading = ref(false)
const isSpriteModel = computed(() => modelStore.currentModel?.renderer === 'sprite')
const petActiveGroups = computed(() => petCatalog.value?.activeGroups ?? [])
const petPassiveGroups = computed(() => petCatalog.value?.passiveGroups ?? [])
let requestSequence = 0
let currentCatalogRequestId = ''

function getMotionShortcutId(groupName: string, index: number) {
  return `${modelStore.currentModel?.id}:motion:${groupName}:${index}`
}

function getExpressionShortcutId(index: number) {
  return `${modelStore.currentModel?.id}:expression:${index}`
}

function getActionShortcutId(itemId: string) {
  return getPetActionShortcutId(modelStore.currentModel?.id ?? '', itemId)
}

function startMotion(motion: MotionInfo) {
  emit(LISTEN_KEY.START_MOTION, motion)
}

function setExpression(index: number) {
  emit(LISTEN_KEY.SET_EXPRESSION, index)
}

const catalogListenerReady = useTauriListen<PetActionCatalogResponse>(
  LISTEN_KEY.PET_ACTION_CATALOG,
  ({ payload }) => {
    if (payload.requestId !== currentCatalogRequestId) return
    if (payload.modelId !== modelStore.currentModel?.id) return

    petCatalog.value = payload.catalog
    petCatalogLoading.value = false
  },
)

useTauriListen<PetActionTriggerResponse>(LISTEN_KEY.PET_ACTION_TRIGGERED, ({ payload }) => {
  if (payload.modelId !== modelStore.currentModel?.id) return

  void requestPetActionCatalog()
})

async function requestPetActionCatalog() {
  const currentModel = modelStore.currentModel

  if (currentModel?.renderer !== 'sprite'
    || !modelStore.modelReady) {
    currentCatalogRequestId = ''
    petCatalog.value = null
    petCatalogLoading.value = false

    return
  }

  const requestId = `${currentModel.id}:${++requestSequence}`

  currentCatalogRequestId = requestId
  petCatalogLoading.value = true

  try {
    await catalogListenerReady

    if (requestId !== currentCatalogRequestId) return

    await emitTo<PetActionCatalogRequest>(WINDOW_LABEL.MAIN, LISTEN_KEY.REQUEST_PET_ACTION_CATALOG, {
      requestId,
      modelId: currentModel.id,
      locale: locale.value,
    })
  } catch {
    if (requestId !== currentCatalogRequestId) return

    petCatalog.value = null
    petCatalogLoading.value = false
  }
}

async function triggerPetAction(itemId: string) {
  const currentModel = modelStore.currentModel

  if (currentModel?.renderer !== 'sprite' || !modelStore.modelReady) return

  const requestId = `${currentModel.id}:trigger:${++requestSequence}`

  await emitTo<PetActionTriggerRequest>(WINDOW_LABEL.MAIN, LISTEN_KEY.TRIGGER_PET_ACTION, {
    requestId,
    modelId: currentModel.id,
    itemId,
  })
}

watch(isSpriteModel, (sprite) => {
  value.value = sprite ? 'active' : 'motion'
}, { immediate: true })

watch([
  () => modelStore.currentModel?.id,
  () => modelStore.modelReady,
  locale,
], () => {
  void requestPetActionCatalog()
}, { immediate: true })
</script>

<template>
  <Modal
    v-model:open="modelValue"
    :cancel-text="false"
    centered
    :footer="null"
    force-render
    :title="isSpriteModel
      ? $t('composables.usePetActionMenu.title')
      : $t('pages.preference.model.behaviorModal.title')"
  >
    <Segmented
      v-if="isSpriteModel"
      v-model:value="value"
      block
      class="mb-4"
      :options="[
        { label: $t('composables.usePetActionMenu.group'), value: 'active' },
        { label: $t('composables.usePetActionMenu.passive'), value: 'passive' },
      ]"
    />

    <Segmented
      v-else
      v-model:value="value"
      block
      class="mb-4"
      :options="[
        { label: $t('pages.preference.model.behaviorModal.labels.motion'), value: 'motion' },
        { label: $t('pages.preference.model.behaviorModal.labels.expression'), value: 'expression' },
      ]"
    />

    <Spin
      v-if="isSpriteModel"
      class="block min-h-40"
      :spinning="petCatalogLoading"
    >
      <div
        v-show="value === 'active'"
        class="max-h-[60vh] min-h-40 flex flex-col gap-4 overflow-y-auto pr-1"
      >
        <Empty
          v-if="!petCatalogLoading && isEmpty(petActiveGroups)"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />

        <div
          v-for="group in petActiveGroups"
          :key="group.label"
        >
          <div class="mb-2">
            {{ group.label }}
          </div>

          <div class="b-1 b-solid b-border rounded-lg">
            <BehaviorItem
              v-for="action in group.actions"
              :key="action.id"
              v-model="modelStore.shortcuts[getActionShortcutId(action.id)]"
              :label="action.label"
              @click="triggerPetAction(action.id)"
            />
          </div>
        </div>
      </div>

      <div
        v-show="value === 'passive'"
        class="max-h-[60vh] min-h-40 flex flex-col gap-4 overflow-y-auto pr-1"
      >
        <Empty
          v-if="!petCatalogLoading && isEmpty(petPassiveGroups)"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />

        <div
          v-for="group in petPassiveGroups"
          :key="group.id"
        >
          <div class="mb-2">
            {{ group.label }}
          </div>

          <div class="b-1 b-solid b-border rounded-lg">
            <BehaviorItem
              v-for="action in group.actions"
              :key="action.id"
              v-model="modelStore.shortcuts[getActionShortcutId(action.id)]"
              :label="action.label"
              @click="triggerPetAction(action.id)"
            />
          </div>
        </div>
      </div>
    </Spin>

    <template v-else>
      <div
        v-show="value === 'motion'"
        class="flex flex-col gap-4"
      >
        <Empty
          v-if="isEmpty(modelStore.currentMotions)"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />

        <template v-else>
          <div
            v-for="([groupName, motions], groupIndex) in modelStore.currentMotions"
            :key="groupName"
          >
            <div class="mb-2">
              {{ $t('pages.preference.model.behaviorModal.labels.motionGroupIndex', { index: groupIndex + 1 }) }}
            </div>

            <div class="b-1 b-solid b-border rounded-lg">
              <template
                v-for="(item, index) in motions"
                :key="item.no"
              >
                <BehaviorItem
                  v-model="modelStore.shortcuts[getMotionShortcutId(groupName, index)]"
                  :label="$t('pages.preference.model.behaviorModal.labels.motionIndex', { index: index + 1 })"
                  @click="startMotion(item)"
                />
              </template>
            </div>
          </div>
        </template>
      </div>

      <div
        v-show="value === 'expression'"
        class="flex flex-col"
      >
        <Empty
          v-if="isEmpty(modelStore.currentExpressions)"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />

        <div class="b-1 b-solid b-border rounded-lg">
          <template
            v-for="(item, index) in modelStore.currentExpressions"
            :key="item.name"
          >
            <BehaviorItem
              v-model="modelStore.shortcuts[getExpressionShortcutId(index)]"
              :label="$t('pages.preference.model.behaviorModal.labels.expressionIndex', { index: index + 1 })"
              @click="setExpression(index)"
            />
          </template>
        </div>
      </div>
    </template>
  </Modal>
</template>
