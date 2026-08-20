import type { PhysicalPosition } from '@tauri-apps/api/dpi'

import { LogicalSize } from '@tauri-apps/api/dpi'
import { resolveResource, sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { message } from 'antdv-next'
import { isNil, round } from 'es-toolkit'
import { findKey, nth } from 'es-toolkit/compat'
import { ref } from 'vue'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { getCursorMonitor } from '@/utils/monitor'
import { isMac } from '@/utils/platform'

import modelRuntime from '../utils/model-runtime'

const appWindow = getCurrentWebviewWindow()
const digitKeys = '1234567890'.split('') as readonly string[]
const letterKeys = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('') as readonly string[]

export interface ModelSize {
  width: number
  height: number
}

export function useModel() {
  const modelStore = useModelStore()
  const catStore = useCatStore()
  const modelSize = ref<ModelSize>()
  // 每次加载/销毁都会推进代次，让较慢的旧异步任务不能覆盖新模型状态。
  let loadGeneration = 0

  function getBehaviorShortcut(index: number) {
    const primary = isMac ? 'Command' : 'Control'

    const modifierGroups = [
      [primary],
      [primary, 'Shift'],
      [primary, 'Alt'],
      [primary, 'Shift', 'Alt'],
    ]

    const tiers = [
      ...modifierGroups.map(modifiers => ({ modifiers, keys: digitKeys })),
      ...modifierGroups.map(modifiers => ({ modifiers, keys: letterKeys })),
    ]

    let nextIndex = index

    for (const tier of tiers) {
      if (nextIndex < tier.keys.length) {
        return [...tier.modifiers, tier.keys[nextIndex]].join('+')
      }

      nextIndex -= tier.keys.length
    }

    return ''
  }

  function getMotionShortcutId(modelId: string, groupName: string, index: number) {
    return `${modelId}:motion:${groupName}:${index}`
  }

  function getExpressionShortcutId(modelId: string, index: number) {
    return `${modelId}:expression:${index}`
  }

  async function handleLoad() {
    const generation = ++loadGeneration
    const currentModel = modelStore.currentModel

    // 模型与窗口尺寸全部就绪前禁止宠物行为，避免动作发给正在销毁或尚未挂载的渲染器。
    modelRuntime.updatePetRuntimeContext({ rendererReady: false })
    modelSize.value = void 0
    modelStore.currentMotions = []
    modelStore.currentExpressions = []

    if (!currentModel) return false

    const { id, path, renderer } = currentModel
    // 不只比较代次，也比较模型身份，防止对象被原地更新时旧结果误提交。
    const isCurrent = () => {
      const model = modelStore.currentModel

      return generation === loadGeneration
        && model?.id === id
        && model.path === path
        && model.renderer === renderer
    }

    try {
      await resolveResource(path)

      if (!isCurrent()) return false

      const { width, height, motions, expressions } = await modelRuntime.load(path, renderer)

      if (!isCurrent()) return false

      const nextMotions = Object.entries(motions)
      const nextModelSize = { width, height }
      const nextShortcuts: Array<[string, string]> = []
      const behaviorIds: string[] = []

      for (const [groupName, items] of nextMotions) {
        for (const [index] of items.entries()) {
          behaviorIds.push(getMotionShortcutId(id, groupName, index))
        }
      }

      for (const [index] of expressions.entries()) {
        behaviorIds.push(getExpressionShortcutId(id, index))
      }

      for (const [index, id] of behaviorIds.entries()) {
        if (modelStore.shortcuts[id]) continue

        const shortcut = getBehaviorShortcut(index)

        if (!shortcut) continue

        nextShortcuts.push([id, shortcut])
      }

      if (!isCurrent()) return false

      modelSize.value = nextModelSize
      modelStore.currentMotions = nextMotions
      modelStore.currentExpressions = expressions

      for (const [shortcutId, shortcut] of nextShortcuts) {
        modelStore.shortcuts[shortcutId] = shortcut
      }

      if (!await handleResize(generation, nextModelSize)) return false

      return isCurrent()
    } catch (error) {
      if (isAbortError(error) || !isCurrent()) return false

      message.error(String(error))

      return false
    }
  }

  function handleDestroy() {
    // 先使所有在途加载失效，再销毁渲染器。
    ++loadGeneration
    modelRuntime.updatePetRuntimeContext({ rendererReady: false })
    modelRuntime.destroy()
  }

  async function handleResize(
    generation = loadGeneration,
    nextModelSize = modelSize.value,
  ) {
    // resize 跨越窗口 API 和 animation frame，任一阶段都可能被下一次模型加载抢占。
    if (!nextModelSize || generation !== loadGeneration) return false

    const { width, height } = nextModelSize

    if (innerWidth > 0 && innerHeight > 0
      && round(innerWidth / innerHeight, 1) !== round(width / height, 1)) {
      await appWindow.setSize(
        new LogicalSize({
          width: innerWidth,
          height: Math.ceil(innerWidth * (height / width)),
        }),
      )

      if (generation !== loadGeneration) return false
    }

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    if (generation !== loadGeneration) return false

    modelRuntime.resizeModel(nextModelSize)

    const size = await appWindow.size()

    if (generation !== loadGeneration) return false

    catStore.window.scale = round((size.width / width) * 100)

    return true
  }

  const setPressedRenderKey = (renderKey: string) => {
    const path = modelStore.supportKeys[renderKey]

    if (!path) return

    const dirName = nth(path.split(sep()), -2)!
    const prevKey = findKey(modelStore.pressedKeys, (value) => {
      return value.includes(dirName)
    })

    // 同一只手的贴图只能显示一张；切键时替换旧贴图，不能误释放对应的物理按键。
    if (prevKey && prevKey !== renderKey) delete modelStore.pressedKeys[prevKey]

    modelStore.pressedKeys[renderKey] = path
  }

  const handlePress = (key: string, label?: string | null, inputId = key) => {
    // inputId 表示真实输入源，renderKey 表示当前模型采用的贴图键，两者不能混为一谈。
    const { key: renderKey } = modelRuntime.handleKeyboard(key, true, label, true, inputId)

    setPressedRenderKey(renderKey)
  }

  const syncPressedRenderKeys = (renderKeys: Iterable<string>) => {
    // 多个物理输入可能共享同一 renderKey，因此以 runtime 的完整快照重建最安全。
    for (const key of Object.keys(modelStore.pressedKeys)) {
      delete modelStore.pressedKeys[key]
    }

    for (const renderKey of renderKeys) setPressedRenderKey(renderKey)
  }

  const handleRelease = (key: string, trackInput = true, inputId = key) => {
    const result = modelRuntime.handleKeyboard(key, false, void 0, trackInput, inputId)

    // trackInput=false 只撤销视觉状态，用于模型过渡，不能改变仍按住的物理输入集合。
    if (!trackInput) {
      if (result.renderStateChanged) delete modelStore.pressedKeys[result.key]

      return
    }

    syncPressedRenderKeys(modelRuntime.getActiveRenderKeys())
  }

  function handleKeyChange(isLeft = true, pressed = true) {
    const id = isLeft ? 'CatParamLeftHandDown' : 'CatParamRightHandDown'

    modelRuntime.setParameterValue(id, pressed)
  }

  function handleMouseChange(key: string, pressed = true) {
    const id = key === 'Left' ? 'ParamMouseLeftDown' : 'ParamMouseRightDown'

    modelRuntime.handleMouse(key, pressed)
    modelRuntime.setParameterValue(id, pressed)
  }

  async function handleMouseMove(cursorPoint: PhysicalPosition) {
    const monitor = await getCursorMonitor(cursorPoint)

    if (!monitor) return

    const { size, position } = monitor

    const xRatio = (cursorPoint.x - position.x) / size.width
    const yRatio = (cursorPoint.y - position.y) / size.height

    for (const id of [
      'ParamMouseX',
      'ParamMouseY',
      'ParamAngleX',
      'ParamAngleY',
      'ParamAngleZ',
      'ParamEyeBallX',
      'ParamEyeBallY',
    ]) {
      const range = modelRuntime.getParameterValueRange(id)

      if (!range) continue

      const { min, max } = range

      if (isNil(min) || isNil(max)) continue

      const isXAxis = id.endsWith('X')
      const isYAxis = id.endsWith('Y')
      const isZAxis = id.endsWith('Z')

      let value: number

      if (isZAxis) {
        const dragX = 1 - 2 * xRatio
        const dragY = 1 - 2 * yRatio

        value = dragX * dragY * min
      } else {
        const ratio = isXAxis ? xRatio : yRatio

        value = max - ratio * (max - min)
      }

      if (!isYAxis && catStore.model.mouseMirror) {
        value *= -1
      }

      modelRuntime.setParameterValue(id, value)
    }
  }

  async function handleAxisChange(id: string, value: number) {
    const range = modelRuntime.getParameterValueRange(id)

    if (!range) return

    const { min, max } = range

    modelRuntime.setParameterValue(id, Math.max(min, value * max))
  }

  return {
    modelSize,
    handlePress,
    handleRelease,
    syncPressedRenderKeys,
    handleLoad,
    handleDestroy,
    handleResize,
    handleKeyChange,
    handleMouseChange,
    handleMouseMove,
    handleAxisChange,
  }
}

function isAbortError(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError'
}
