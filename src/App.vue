<script setup lang="ts">
import { HappyProvider } from '@antdv-next/happy-work-theme'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error } from '@tauri-apps/plugin-log'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEventListener } from '@vueuse/core'
import { ConfigProvider, theme } from 'antdv-next'
import { isString } from 'es-toolkit'
import isURL from 'is-url'
import { onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'

import { useTauriListen } from './composables/useTauriListen'
import { useWindowState } from './composables/useWindowState'
import { LANGUAGE, LISTEN_KEY } from './constants'
import { getAntdLocale } from './locales/index.ts'
import { hideWindow, showWindow } from './plugins/window'
import { useAppStore } from './stores/app'
import { useCatStore } from './stores/cat'
import { useGeneralStore } from './stores/general'
import { useModelRegistryStore } from './stores/model'
import { useModelRuntimeStore } from './stores/model-runtime'
import { useModelSelectionStore } from './stores/model-selection'
import { useModelShortcutStore } from './stores/model-shortcut'
import { useShortcutStore } from './stores/shortcut.ts'

const appStore = useAppStore()
const modelRegistryStore = useModelRegistryStore()
const modelRuntimeStore = useModelRuntimeStore()
const modelSelectionStore = useModelSelectionStore()
const modelShortcutStore = useModelShortcutStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const shortcutStore = useShortcutStore()
const appWindow = getCurrentWebviewWindow()
const { isRestored, restoreState } = useWindowState()
const { darkAlgorithm, defaultAlgorithm } = theme
const { locale } = useI18n()

onMounted(async () => {
  await appStore.$tauri.start()
  await appStore.init()
  // 注册表先完成旧快照迁移和磁盘复验，其他域才能安全解析选择与快捷键。
  await modelRegistryStore.$tauri.start()
  const modelInitContext = await modelRegistryStore.init()
  await modelSelectionStore.$tauri.start()
  modelSelectionStore.init(modelInitContext.legacyCurrentModel)
  await modelShortcutStore.$tauri.start()
  await modelShortcutStore.init(
    modelInitContext.legacyShortcuts,
    modelInitContext.previousModels,
  )
  await modelRuntimeStore.$tauri.start()
  await catStore.$tauri.start()
  catStore.init()
  await generalStore.$tauri.start()
  await generalStore.init()
  await shortcutStore.$tauri.start()
  await restoreState()
})

watch(() => generalStore.appearance.language, (value) => {
  locale.value = value ?? LANGUAGE.EN_US
})

useTauriListen(LISTEN_KEY.SHOW_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  showWindow()
})

useTauriListen(LISTEN_KEY.HIDE_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  hideWindow()
})

useEventListener('unhandledrejection', ({ reason }) => {
  const message = isString(reason) ? reason : JSON.stringify(reason)

  error(message)
})

useEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest('a')

  if (!link) return

  const { href, target } = link

  if (target === '_blank') return

  event.preventDefault()

  if (!isURL(href)) return

  openUrl(href)
})
</script>

<template>
  <HappyProvider
    v-slot="{ wave }"
    enabled
  >
    <ConfigProvider
      :locale="getAntdLocale(generalStore.appearance.language)"
      :theme="{
        algorithm: generalStore.appearance.isDark ? darkAlgorithm : defaultAlgorithm,
      }"
      :wave="wave"
    >
      <RouterView v-if="isRestored" />
    </ConfigProvider>
  </HappyProvider>
</template>
