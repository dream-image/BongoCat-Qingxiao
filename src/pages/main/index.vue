<script setup lang="ts">
import type { MotionInfo } from 'easy-live2d'

import { convertFileSrc } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { round } from 'es-toolkit'
import { nth } from 'es-toolkit/compat'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import { useAppMenu } from '@/composables/useAppMenu'
import { useDevice } from '@/composables/useDevice'
import { useGamepad } from '@/composables/useGamepad'
import { useModel } from '@/composables/useModel'
import { usePetPointer } from '@/composables/usePetPointer'
import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY } from '@/constants'
import { hideWindow, setAlwaysOnTop, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useModelStore } from '@/stores/model'
import { isImage } from '@/utils/is'
import modelRuntime from '@/utils/model-runtime'
import { join } from '@/utils/path'
import { isWindows } from '@/utils/platform'
import { clearObject } from '@/utils/shared'

const { startListening, prepareModelTransition, remapPressedKeyboardInputs } = useDevice()
const appWindow = getCurrentWebviewWindow()
const { modelSize, handleLoad, handleDestroy, handleResize, handleKeyChange } = useModel()
const petPointer = usePetPointer(
  () => modelSize.value,
  () => appWindow.startDragging(),
)
const catStore = useCatStore()
const { getBaseMenu, getExitMenu } = useAppMenu()
const modelStore = useModelStore()
const generalStore = useGeneralStore()
const resizing = ref(false)
const backgroundImagePath = ref<string>()
const { stickActive } = useGamepad()
// 模型加载和窗口重绘各自判代次，旧异步结果不能重新打开 rendererReady 门禁。
let modelLoadGeneration = 0
let resizeGeneration = 0

onMounted(startListening)

onUnmounted(() => {
  ++modelLoadGeneration
  petPointer.reset()
  handleDestroy()
})

const debouncedResize = useDebounceFn(async (generation: number, loadGeneration: number) => {
  const resized = await handleResize()

  // debounce 执行期间可能已切模型或开始下一次 resize，旧任务不得提交 ready。
  if (generation !== resizeGeneration || loadGeneration !== modelLoadGeneration) return

  resizing.value = false

  if (resized && modelStore.modelReady) {
    modelRuntime.updatePetRuntimeContext({ rendererReady: true })
  }
}, 100)

useEventListener('resize', () => {
  const generation = ++resizeGeneration

  resizing.value = true
  // resize 完成前暂停自主行为，避免动作落到尺寸尚未同步的画布。
  modelRuntime.updatePetRuntimeContext({ rendererReady: false })

  debouncedResize(generation, modelLoadGeneration)
})

watch(() => modelStore.currentModel, async (model) => {
  const generation = ++modelLoadGeneration

  ++resizeGeneration
  resizing.value = false
  // 先保留物理按压并撤掉旧视觉映射，待新模型资源表完成后再映射回来。
  prepareModelTransition()
  petPointer.reset()
  modelStore.modelReady = false
  modelRuntime.updatePetRuntimeContext({ rendererReady: false })
  backgroundImagePath.value = void 0
  clearObject([modelStore.supportKeys, modelStore.pressedKeys])

  if (!model) {
    handleDestroy()

    return
  }

  const { id, path: modelPath, renderer } = model
  // 深度 watch 可能在同一模型对象上触发，身份字段与代次一起核验才可靠。
  const isCurrent = () => {
    const current = modelStore.currentModel

    return generation === modelLoadGeneration
      && current?.id === id
      && current.path === modelPath
      && current.renderer === renderer
  }

  if (!await handleLoad() || !isCurrent()) return

  const path = join(model.path, 'resources', 'background.png')

  const existed = await exists(path)
  const nextBackgroundImagePath = existed ? convertFileSrc(path) : void 0
  const nextSupportKeys: Record<string, string> = {}

  if (!isCurrent()) return

  const resourcePath = join(model.path, 'resources')
  const groups = ['left-keys', 'right-keys']

  for await (const groupName of groups) {
    const groupDir = join(resourcePath, groupName)
    const files = await readDir(groupDir).catch(() => [])
    const imageFiles = files.filter(file => isImage(file.name))

    for (const file of imageFiles) {
      const fileName = file.name.split('.')[0]

      nextSupportKeys[fileName] = join(groupDir, file.name)
    }
  }

  if (!isCurrent()) return

  backgroundImagePath.value = nextBackgroundImagePath
  clearObject([modelStore.supportKeys])
  Object.assign(modelStore.supportKeys, nextSupportKeys)
  // supportKeys 完整提交后才能重映射持续按住的键，否则会错误回退或丢贴图。
  remapPressedKeyboardInputs()
  modelStore.modelReady = true

  // rendererReady 比 modelReady 更严格：窗口重绘期间仍保持关闭。
  if (!resizing.value) {
    modelRuntime.updatePetRuntimeContext({ rendererReady: true })
  }
}, { deep: true, immediate: true })

watch([() => catStore.window.scale, modelSize], async ([scale, modelSize]) => {
  if (!modelSize) return

  const { width, height } = modelSize

  appWindow.setSize(
    new PhysicalSize({
      width: Math.round(width * (scale / 100)),
      height: Math.round(height * (scale / 100)),
    }),
  )
}, { immediate: true })

watch([modelStore.pressedKeys, stickActive], ([keys, stickActive]) => {
  const dirs = Object.values(keys).map((path) => {
    return nth(path.split(sep()), -2)!
  })

  const hasLeft = dirs.some(dir => dir.startsWith('left'))
  const hasRight = dirs.some(dir => dir.startsWith('right'))

  handleKeyChange(true, stickActive.left || hasLeft)
  handleKeyChange(false, stickActive.right || hasRight)
}, { deep: true })

watch(() => catStore.window.visible, async (value) => {
  value ? showWindow() : hideWindow()
})

watch([
  () => catStore.pet.enabled,
  () => catStore.pet.activationDelayMs,
  () => catStore.pet.mouseInteractions,
  () => catStore.window.visible,
  () => catStore.model.ignoreMouse,
  () => catStore.window.passThrough,
  () => catStore.window.hideOnHover,
], ([enabled, activationDelayMs, mouseInteractions, visible, ignoreMouse, passThrough, hideOnHover]) => {
  // 穿透或 hover 隐藏时无法可靠接收指针序列，因此同时关闭并重置宠物鼠标交互。
  const interactionEnabled = mouseInteractions && !ignoreMouse && !passThrough && !hideOnHover

  if (!enabled || !visible || !interactionEnabled) petPointer.reset()

  modelRuntime.updatePetRuntimeContext({
    enabled,
    activationDelayMs,
    visible,
    mouseInteractions: interactionEnabled,
  })
}, { immediate: true })

watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })

watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })

watch(() => catStore.model.motionSound, modelRuntime.setMotionSoundEnabled, { immediate: true })

watch(() => catStore.model.maxFPS, modelRuntime.setMaxFPS, { immediate: true })

watch(() => catStore.model.mirror, modelRuntime.setMirrored, { immediate: true })

useTauriListen<MotionInfo>(LISTEN_KEY.START_MOTION, ({ payload }) => {
  modelRuntime.startMotion(payload)
})

useTauriListen<number>(LISTEN_KEY.SET_EXPRESSION, ({ payload }) => {
  modelRuntime.setExpression(payload)
})

function handleMouseDown(event: MouseEvent) {
  // 宠物手势已捕获左键时不能再触发窗口拖拽，两套状态机必须互斥。
  if (event.button !== 0 || petPointer.isCapturing()) return

  appWindow.startDragging()
}

function handlePointerDown(event: PointerEvent) {
  // 仅在命中模型交互区域后阻止默认行为，空白区域仍保留原窗口操作。
  if (!petPointer.handlePointerDown(event)) return

  event.preventDefault()
}

async function handleContextmenu(event: MouseEvent) {
  event.preventDefault()

  if (event.shiftKey) return

  const menu = await Menu.new({
    items: [
      ...await getBaseMenu({ includeAlwaysOnTop: true }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      ...await getExitMenu(),
    ],
  })

  // Temporarily disable always-on-top on Windows so the context menu is not covered
  if (isWindows && catStore.window.alwaysOnTop) {
    setAlwaysOnTop(false)
  }

  await menu.popup()

  // Restore always-on-top after the menu is closed
  if (!isWindows || !catStore.window.alwaysOnTop) return

  setAlwaysOnTop(true)
}

function handleMouseMove(event: MouseEvent) {
  const { buttons, shiftKey, movementX, movementY } = event

  if (buttons !== 2 || !shiftKey) return

  const delta = (movementX + movementY) * 0.5
  const nextScale = Math.max(10, Math.min(catStore.window.scale + delta, 500))

  catStore.window.scale = round(nextScale)
}
</script>

<template>
  <div
    class="relative size-screen overflow-hidden children:(absolute size-full)"
    :class="{ '-scale-x-100': catStore.model.mirror && modelStore.currentModel?.renderer !== 'sprite' }"
    :style="{
      opacity: catStore.window.opacity / 100,
      borderRadius: `${catStore.window.radius}%`,
    }"
    @contextmenu="handleContextmenu"
    @mousedown="handleMouseDown"
    @mousemove="handleMouseMove"
    @pointercancel="petPointer.handlePointerCancel"
    @pointerdown="handlePointerDown"
    @pointerleave="petPointer.handlePointerLeave"
    @pointermove="petPointer.handlePointerMove"
    @pointerup="petPointer.handlePointerUp"
  >
    <img
      v-if="backgroundImagePath"
      class="object-cover"
      :src="backgroundImagePath"
    >

    <canvas
      v-show="modelStore.currentModel?.renderer !== 'sprite'"
      id="live2dCanvas"
    />

    <canvas
      v-show="modelStore.currentModel?.renderer === 'sprite'"
      id="spriteCanvas"
    />

    <img
      v-for="path in modelStore.pressedKeys"
      :key="path"
      class="object-cover"
      :src="convertFileSrc(path)"
    >

    <div
      v-show="resizing || !modelStore.modelReady"
      class="flex items-center justify-center bg-black"
    >
      <span class="text-center text-[10vw] text-[#fff]">
        {{ resizing ? $t('pages.main.hints.redrawing') : $t('pages.main.hints.switching') }}
      </span>
    </div>
  </div>
</template>
