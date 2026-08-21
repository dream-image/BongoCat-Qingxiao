<script setup lang="ts">
import { Divider, Flex, InputNumber, Slider, SpaceAddon, SpaceCompact, Switch } from 'antdv-next'
import { computed } from 'vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { isWindows } from '@/utils/platform'

const catStore = useCatStore()
const modelStore = useModelStore()

const isSpriteModel = computed(() => modelStore.currentModel?.renderer === 'sprite')
const petActivationDelaySeconds = computed<number | null>({
  get: () => catStore.pet.activationDelayMs === null
    ? null
    : catStore.pet.activationDelayMs / 1000,
  set: (value) => {
    catStore.pet.activationDelayMs = typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value * 1000)
      : null
  },
})
</script>

<template>
  <ProList :title="$t('pages.preference.cat.labels.modelSettings')">
    <ProListItem
      :description="$t('pages.preference.cat.hints.mirrorMode')"
      :title="$t('pages.preference.cat.labels.mirrorMode')"
    >
      <Switch v-model:checked="catStore.model.mirror" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.mouseMirror')"
      :title="$t('pages.preference.cat.labels.mouseMirror')"
    >
      <Switch v-model:checked="catStore.model.mouseMirror" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.ignoreMouse')"
      :title="$t('pages.preference.cat.labels.ignoreMouse')"
    >
      <Switch v-model:checked="catStore.model.ignoreMouse" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.motionSound')"
      :title="$t('pages.preference.cat.labels.motionSound')"
    >
      <Switch v-model:checked="catStore.model.motionSound" />
    </ProListItem>

    <ProListItem
      v-if="isSpriteModel"
      :description="$t('pages.preference.cat.hints.petBehavior')"
      :title="$t('pages.preference.cat.labels.petBehavior')"
    >
      <Switch v-model:checked="catStore.pet.enabled" />
    </ProListItem>

    <ProListItem
      v-if="isSpriteModel"
      :description="$t('pages.preference.cat.hints.petActivationDelay')"
      :title="$t('pages.preference.cat.labels.petActivationDelay')"
    >
      <SpaceCompact>
        <InputNumber
          v-model:value="petActivationDelaySeconds"
          class="w-24"
          :disabled="!catStore.pet.enabled"
          :max="3600"
          :min="1"
          :placeholder="$t('pages.preference.cat.labels.modelDefault')"
          :precision="0"
          :step="1"
        />

        <SpaceAddon>s</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      v-if="isSpriteModel"
      :description="$t('pages.preference.cat.hints.petMouseInteractions')"
      :title="$t('pages.preference.cat.labels.petMouseInteractions')"
    >
      <Switch
        v-model:checked="catStore.pet.mouseInteractions"
        :disabled="!catStore.pet.enabled"
      />
    </ProListItem>

    <ProListItem
      v-else
      :description="$t('pages.preference.cat.hints.behavior')"
      :title="$t('pages.preference.cat.labels.behavior')"
    >
      <Switch v-model:checked="catStore.model.behavior" />
    </ProListItem>

    <ProListItem
      v-if="isWindows"
      :description="$t('pages.preference.cat.hints.autoReleaseDelay')"
      :title="$t('pages.preference.cat.labels.autoReleaseDelay')"
    >
      <SpaceCompact>
        <InputNumber
          v-model:value="catStore.model.autoReleaseDelay"
          class="w-20"
        />

        <SpaceAddon>s</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.maxFPS')"
      :title="$t('pages.preference.cat.labels.maxFPS')"
    >
      <InputNumber
        v-model:value="catStore.model.maxFPS"
        class="w-20"
        :min="0"
      />
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.cat.labels.windowSettings')">
    <ProListItem
      :description="$t('pages.preference.cat.hints.passThrough')"
      :title="$t('pages.preference.cat.labels.passThrough')"
    >
      <Switch v-model:checked="catStore.window.passThrough" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.alwaysOnTop')"
      :title="$t('pages.preference.cat.labels.alwaysOnTop')"
    >
      <Switch v-model:checked="catStore.window.alwaysOnTop" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.hideOnHover')"
      :title="$t('pages.preference.cat.labels.hideOnHover')"
    >
      <Flex align="center">
        <Switch v-model:checked="catStore.window.hideOnHover" />

        <Flex
          align="center"
          class="overflow-hidden transition-all"
          :class="[catStore.window.hideOnHover ? 'w-28 opacity-100' : 'w-0 opacity-0']"
        >
          <Divider type="vertical" />

          <SpaceCompact>
            <InputNumber
              v-model:value="catStore.window.hideOnHoverDelay"
              class="w-16"
              :min="0"
            />

            <SpaceAddon>s</SpaceAddon>
          </SpaceCompact>
        </Flex>
      </Flex>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.keepInScreen')"
      :title="$t('pages.preference.cat.labels.keepInScreen')"
    >
      <Switch v-model:checked="catStore.window.keepInScreen" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.windowSize')"
      :title="$t('pages.preference.cat.labels.windowSize')"
    >
      <SpaceCompact>
        <InputNumber
          v-model:value="catStore.window.scale"
          class="w-20"
          :max="500"
          :min="1"
        />

        <SpaceAddon>%</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem :title="$t('pages.preference.cat.labels.windowRadius')">
      <SpaceCompact>
        <InputNumber
          v-model:value="catStore.window.radius"
          class="w-20"
          :min="0"
        />

        <SpaceAddon>%</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      :title="$t('pages.preference.cat.labels.opacity')"
      vertical
    >
      <Slider
        v-model:value="catStore.window.opacity"
        class="m-0!"
        :max="100"
        :min="10"
        :tooltip="{
          formatter(value) {
            return `${value}%`
          },
        }"
      />
    </ProListItem>
  </ProList>
</template>
