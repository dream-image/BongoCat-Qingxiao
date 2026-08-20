import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error } from '@tauri-apps/plugin-log'
import { isNil } from 'es-toolkit'
import { Ticker } from 'pixi.js'
import { checkInputMonitoringPermission, requestInputMonitoringPermission } from 'tauri-plugin-macos-permissions-api'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { inBetween } from '@/utils/is'
import modelRuntime from '@/utils/model-runtime'
import { isMac, isWindows } from '@/utils/platform'

import { INVOKE_KEY, LISTEN_KEY, WINDOW_LABEL } from '../constants'
import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

interface MouseButtonEvent {
  kind: 'MousePress' | 'MouseRelease'
  value: string
}

export interface CursorPoint {
  x: number
  y: number
}

interface PressedKeyboardInput {
  code: string
  renderKey?: string
}

interface MouseMoveEvent {
  kind: 'MouseMove'
  value: CursorPoint
}

interface KeyboardEvent {
  kind: 'KeyboardPress' | 'KeyboardRelease'
  value: string | {
    code: string
    label?: string | null
  }
}

interface DeviceListenerStatus {
  state: 'unavailable' | 'starting' | 'ready'
  error?: string | null
}

type DeviceEvent = MouseButtonEvent | MouseMoveEvent | KeyboardEvent

const DAMPING_DECAY = 0.75
const DEVICE_RETRY_BASE_DELAY = 500
const DEVICE_RETRY_MAX_DELAY = 8000
const DEVICE_RETRY_MAX_ATTEMPTS = 6
const DEVICE_READY_STABILITY_DELAY = 10000
const WINDOW_VISIBILITY_POLL_DELAY = 50
const WINDOW_VISIBILITY_POLL_ATTEMPTS = 40
const appWindow = getCurrentWebviewWindow()

export function useDevice() {
  const modelStore = useModelStore()
  const releaseTimers = new Map<string, NodeJS.Timeout>()
  const pressedKeyboardInputs = new Map<string, PressedKeyboardInput>()
  const pressedMouseButtons = new Set<string>()
  const appStore = useAppStore()
  const catStore = useCatStore()
  const latestCursorPoint = ref<CursorPoint>()
  const smoothedCursorPoint = ref<CursorPoint>()
  const scaleFactor = ref(1)
  const {
    handlePress,
    handleRelease,
    syncPressedRenderKeys,
    handleMouseChange,
    handleMouseMove,
  } = useModel()
  let unmounted = false
  let lifecycleGeneration = 0
  let listenerState: DeviceListenerStatus['state'] = 'unavailable'
  let retryAttempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let readyResetTimer: ReturnType<typeof setTimeout> | undefined
  let permissionPollTimer: ReturnType<typeof setTimeout> | undefined
  let permissionPollResolve: (() => void) | undefined
  let listenerStart: Promise<void> | undefined
  let permissionFlow: Promise<boolean> | undefined
  let permissionPromptRequested = false
  let hideOnHoverTimer: ReturnType<typeof setTimeout> | undefined
  let pointerInsideMainWindow = false
  let hoverHidden = false
  let actualWindowVisible = false
  let windowVisibilityGeneration = 0
  let unlistenWindowClose = () => {}
  let desiredIgnoreCursorEvents = false
  let ignoreCursorEventsTask: Promise<void> | undefined

  const clearRetryTimer = () => {
    if (!retryTimer) return

    clearTimeout(retryTimer)
    retryTimer = void 0
  }

  const clearReadyResetTimer = () => {
    if (!readyResetTimer) return

    clearTimeout(readyResetTimer)
    readyResetTimer = void 0
  }

  const clearPermissionPollTimer = () => {
    if (permissionPollTimer) clearTimeout(permissionPollTimer)

    permissionPollTimer = void 0
    permissionPollResolve?.()
    permissionPollResolve = void 0
  }

  const clearReleaseTimers = () => {
    for (const timer of releaseTimers.values()) clearTimeout(timer)

    releaseTimers.clear()
  }

  const releaseMouseInputState = () => {
    for (const button of pressedMouseButtons) handleMouseChange(button, false)

    pressedMouseButtons.clear()
  }

  const releaseInputState = () => {
    clearReleaseTimers()

    const keyboardInputs = [...pressedKeyboardInputs.entries()]

    pressedKeyboardInputs.clear()

    for (const [inputId, { renderKey }] of keyboardInputs) {
      if (renderKey) {
        handleRelease(renderKey, true, inputId)
      } else {
        modelRuntime.setKeyboardInputActive(inputId, false)
      }
    }

    syncPressedRenderKeys(modelRuntime.getActiveRenderKeys())

    releaseMouseInputState()
  }

  const tickerCallback = (ticker: Ticker) => {
    const destination = latestCursorPoint.value

    if (!destination) return

    const current = smoothedCursorPoint.value ?? destination

    const alpha = 1 - DAMPING_DECAY ** (ticker.deltaMS / (1000 / 60))

    const interpolated = {
      x: current.x + (destination.x - current.x) * alpha,
      y: current.y + (destination.y - current.y) * alpha,
    }

    if (Math.hypot(destination.x - interpolated.x, destination.y - interpolated.y) < 0.5) {
      smoothedCursorPoint.value = { ...destination }

      latestCursorPoint.value = void 0
    } else {
      smoothedCursorPoint.value = interpolated
    }

    void handleCursorMove(smoothedCursorPoint.value)
  }

  onMounted(async () => {
    void reconcileWindowVisibility()

    const nextUnlistenWindowClose = await appWindow.onCloseRequested(() => {
      void reconcileWindowVisibility(false)
    })

    if (unmounted) {
      nextUnlistenWindowClose()
    } else {
      unlistenWindowClose = nextUnlistenWindowClose
    }

    scaleFactor.value = isMac ? await appWindow.scaleFactor() : 1

    appWindow.onScaleChanged(({ payload }) => {
      if (!isMac) return

      scaleFactor.value = payload.scaleFactor
    })
  })

  onUnmounted(() => {
    unmounted = true
    ++lifecycleGeneration
    ++windowVisibilityGeneration
    unlistenWindowClose()
    clearRetryTimer()
    clearReadyResetTimer()
    clearPermissionPollTimer()
    resetHideOnHover()
    releaseInputState()
    modelRuntime.updatePetRuntimeContext({
      inputStatus: 'unavailable',
      renderedVisible: false,
    })
    Ticker.shared.remove(tickerCallback)
  })

  const waitForPermissionPoll = () => new Promise<void>((resolve) => {
    permissionPollResolve = resolve
    permissionPollTimer = setTimeout(() => {
      permissionPollTimer = void 0
      permissionPollResolve = void 0
      resolve()
    }, 1000)
  })

  const waitForInputMonitoringPermission = async () => {
    for (;;) {
      if (unmounted) return false
      if (await checkInputMonitoringPermission()) return true

      await waitForPermissionPoll()
    }
  }

  const ensureInputMonitoringPermission = async () => {
    if (!isMac) return true
    if (permissionFlow) return permissionFlow

    const nextPermissionFlow = (async () => {
      if (await checkInputMonitoringPermission()) return true

      if (!permissionPromptRequested) {
        await requestInputMonitoringPermission()
        permissionPromptRequested = true
      }

      return waitForInputMonitoringPermission()
    })()

    permissionFlow = nextPermissionFlow

    try {
      return await nextPermissionFlow
    } finally {
      if (permissionFlow === nextPermissionFlow) permissionFlow = void 0
    }
  }

  const getSupportedKey = (key: string) => {
    if (modelStore.currentModel?.renderer === 'sprite') return key

    let nextKey = key

    const unsupportedKey = !modelStore.supportKeys[nextKey]

    if (key.startsWith('F') && unsupportedKey) {
      nextKey = key.replace(/F(\d+)/, 'Fn')
    }

    for (const item of ['Meta', 'Shift', 'Alt', 'Control']) {
      if (key.startsWith(item) && unsupportedKey) {
        const regex = new RegExp(`^(${item}).*`)
        nextKey = key.replace(regex, '$1')
      }
    }

    return nextKey
  }

  const clearHideOnHoverTimer = () => {
    if (!hideOnHoverTimer) return

    clearTimeout(hideOnHoverTimer)
    hideOnHoverTimer = void 0
  }

  const syncRenderedVisibility = () => {
    modelRuntime.updatePetRuntimeContext({
      renderedVisible: !unmounted
        && catStore.window.visible
        && actualWindowVisible
        && !hoverHidden,
    })
  }

  const syncIgnoreCursorEvents = () => {
    desiredIgnoreCursorEvents = hoverHidden || catStore.window.passThrough

    if (ignoreCursorEventsTask) return

    const nextTask = (async () => {
      for (;;) {
        const desired = desiredIgnoreCursorEvents

        try {
          await appWindow.setIgnoreCursorEvents(desired)
        } catch (reason) {
          console.error('Failed to update cursor event policy:', reason)
        }

        if (desired === desiredIgnoreCursorEvents) return
      }
    })()

    ignoreCursorEventsTask = nextTask

    void nextTask.finally(() => {
      if (ignoreCursorEventsTask === nextTask) ignoreCursorEventsTask = void 0
    })
  }

  const setActualWindowVisible = (visible: boolean) => {
    actualWindowVisible = visible
    syncRenderedVisibility()
  }

  const reconcileWindowVisibility = async (expected?: boolean) => {
    const generation = ++windowVisibilityGeneration

    if (expected === false) {
      setActualWindowVisible(false)

      return
    }

    for (let attempt = 0; attempt < WINDOW_VISIBILITY_POLL_ATTEMPTS; attempt++) {
      if (unmounted || generation !== windowVisibilityGeneration) return

      let visible: boolean

      try {
        visible = await appWindow.isVisible()
      } catch (reason) {
        console.error('Failed to read window visibility:', reason)

        return
      }

      if (unmounted || generation !== windowVisibilityGeneration) return

      if (expected !== true || visible) {
        setActualWindowVisible(visible)

        return
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, WINDOW_VISIBILITY_POLL_DELAY)
      })
    }

    if (!unmounted && generation === windowVisibilityGeneration) {
      setActualWindowVisible(false)
    }
  }

  const setHoverHidden = (hidden: boolean) => {
    hoverHidden = hidden

    if (hidden) {
      document.body.style.setProperty('opacity', '0')
    } else {
      document.body.style.removeProperty('opacity')
    }

    syncRenderedVisibility()
    syncIgnoreCursorEvents()
  }

  const resetHideOnHover = () => {
    clearHideOnHoverTimer()
    pointerInsideMainWindow = false
    setHoverHidden(false)
  }

  watch(() => catStore.model.ignoreMouse, (value) => {
    if (value) {
      latestCursorPoint.value = void 0
      smoothedCursorPoint.value = void 0
      resetHideOnHover()

      for (const button of pressedMouseButtons) {
        handleMouseChange(button, false)
      }

      pressedMouseButtons.clear()

      return Ticker.shared.remove(tickerCallback)
    }

    return Ticker.shared.add(tickerCallback)
  }, { immediate: true })

  const onHideOnHover = (x: number, y: number) => {
    const { x: winX, y: winY, width, height } = appStore.windowState[WINDOW_LABEL.MAIN] ?? {}

    if (isNil(winX) || isNil(winY) || isNil(width) || isNil(height)) return

    const isInWindow = inBetween(x, winX, winX + width)
      && inBetween(y, winY, winY + height)

    if (isInWindow === pointerInsideMainWindow) return

    pointerInsideMainWindow = isInWindow
    clearHideOnHoverTimer()

    if (!isInWindow) {
      setHoverHidden(false)

      return
    }

    hideOnHoverTimer = setTimeout(() => {
      hideOnHoverTimer = void 0

      if (unmounted
        || !catStore.window.visible
        || !catStore.window.hideOnHover
        || !pointerInsideMainWindow) {
        return
      }

      setHoverHidden(true)
    }, catStore.window.hideOnHoverDelay * 1000)
  }

  watch([
    () => catStore.window.hideOnHover,
    () => catStore.window.visible,
  ], ([hideOnHover, visible]) => {
    if (!visible) {
      void reconcileWindowVisibility(false)
      resetHideOnHover()

      return
    }

    void reconcileWindowVisibility(true)

    if (!hideOnHover) {
      resetHideOnHover()

      return
    }

    syncRenderedVisibility()
    syncIgnoreCursorEvents()
  }, { immediate: true })

  watch(() => catStore.window.passThrough, syncIgnoreCursorEvents, { immediate: true })

  useTauriListen<string>(LISTEN_KEY.SHOW_WINDOW, ({ payload }) => {
    if (payload !== WINDOW_LABEL.MAIN) return

    void reconcileWindowVisibility(true)
  })

  useTauriListen<string>(LISTEN_KEY.HIDE_WINDOW, ({ payload }) => {
    if (payload !== WINDOW_LABEL.MAIN) return

    void reconcileWindowVisibility(false)
  })

  const handleCursorMove = async (cursorPoint: CursorPoint) => {
    if (catStore.model.ignoreMouse) return

    const x = cursorPoint.x * scaleFactor.value
    const y = cursorPoint.y * scaleFactor.value

    handleMouseMove(new PhysicalPosition(x, y))

    if (!catStore.window.hideOnHover) return

    onHideOnHover(x, y)
  }

  const prepareModelTransition = () => {
    for (const input of pressedKeyboardInputs.values()) {
      input.renderKey = void 0
    }

    modelRuntime.suspendKeyboardInputRendering(pressedKeyboardInputs.keys())
    releaseMouseInputState()
  }

  const remapPressedKeyboardInputs = () => {
    const mappings: Array<{ inputId: string, renderKey: string }> = []

    for (const [inputId, input] of pressedKeyboardInputs) {
      const renderKey = getSupportedKey(input.code)

      input.renderKey = renderKey
      mappings.push({ inputId, renderKey })
    }

    const activeRenderKeys = modelRuntime.remapKeyboardInputs(mappings)

    syncPressedRenderKeys(activeRenderKeys)
  }

  const releaseKeyboardInput = (inputId: string) => {
    const timer = releaseTimers.get(inputId)

    if (timer) clearTimeout(timer)

    releaseTimers.delete(inputId)

    const renderKey = pressedKeyboardInputs.get(inputId)?.renderKey

    pressedKeyboardInputs.delete(inputId)

    if (renderKey) {
      handleRelease(renderKey, true, inputId)
    } else {
      modelRuntime.setKeyboardInputActive(inputId, false)
    }

    syncPressedRenderKeys(modelRuntime.getActiveRenderKeys())
  }

  const handleKeyboardPress = (
    inputId: string,
    code: string,
    label?: string | null,
  ) => {
    const activeInput = pressedKeyboardInputs.get(inputId)
    const renderKey = activeInput?.renderKey ?? getSupportedKey(code)

    pressedKeyboardInputs.delete(inputId)
    pressedKeyboardInputs.set(inputId, { code, renderKey })
    handlePress(renderKey, label, inputId)

    return renderKey
  }

  const registerKeyboardPress = (
    inputId: string,
    code: string,
    label?: string | null,
  ) => {
    if (modelStore.modelReady) return handleKeyboardPress(inputId, code, label)

    const activeInput = pressedKeyboardInputs.get(inputId)

    pressedKeyboardInputs.set(inputId, {
      code,
      renderKey: activeInput?.renderKey,
    })
    modelRuntime.setKeyboardInputActive(inputId, true)
  }

  const handleAutoRelease = (
    inputId: string,
    code: string,
    delay = 100,
    label?: string | null,
  ) => {
    registerKeyboardPress(inputId, code, label)

    const previousTimer = releaseTimers.get(inputId)

    if (previousTimer) clearTimeout(previousTimer)

    const timer = setTimeout(() => {
      if (releaseTimers.get(inputId) !== timer) return

      releaseKeyboardInput(inputId)
    }, delay)

    releaseTimers.set(inputId, timer)
  }

  const deviceListenerReady = useTauriListen<DeviceEvent>(LISTEN_KEY.DEVICE_CHANGED, ({ payload }) => {
    const { kind, value } = payload

    if (kind === 'KeyboardPress' || kind === 'KeyboardRelease') {
      const code = typeof value === 'string' ? value : value.code
      const label = typeof value === 'string' ? void 0 : value.label
      if (code === 'CapsLock') {
        return handleAutoRelease(code, code)
      }

      if (kind === 'KeyboardPress') {
        if (isWindows) {
          const delay = catStore.model.autoReleaseDelay * 1000

          return handleAutoRelease(code, code, delay, label)
        }

        return registerKeyboardPress(code, code, label)
      }

      return releaseKeyboardInput(code)
    }

    switch (kind) {
      case 'MousePress':
        if (catStore.model.ignoreMouse) return

        pressedMouseButtons.add(value)

        return handleMouseChange(value)
      case 'MouseRelease':
        if (catStore.model.ignoreMouse) return

        pressedMouseButtons.delete(value)

        return handleMouseChange(value, false)
      case 'MouseMove':
        if (catStore.model.ignoreMouse) return

        return latestCursorPoint.value = value
    }
  })

  const deviceStatusListenerReady = useTauriListen<DeviceListenerStatus>(
    LISTEN_KEY.DEVICE_LISTENER_STATUS,
    ({ payload }) => {
      listenerState = payload.state

      if (payload.state === 'unavailable') {
        clearReadyResetTimer()
        releaseInputState()
        scheduleListenerRestart()
      } else {
        clearRetryTimer()

        if (payload.state === 'ready') {
          clearReadyResetTimer()

          const generation = lifecycleGeneration
          readyResetTimer = setTimeout(() => {
            readyResetTimer = void 0

            if (!unmounted && generation === lifecycleGeneration && listenerState === 'ready') {
              retryAttempt = 0
            }
          }, DEVICE_READY_STABILITY_DELAY)
        }
      }

      modelRuntime.updatePetRuntimeContext({ inputStatus: payload.state })

      if (!payload.error) return

      console.error(payload.error)
      void error(payload.error).catch((logReason) => {
        console.error('Failed to write device listening error log:', logReason)
      })
    },
  )

  function scheduleListenerRestart() {
    if (unmounted || retryTimer || retryAttempt >= DEVICE_RETRY_MAX_ATTEMPTS) return

    const generation = lifecycleGeneration
    const delay = Math.min(
      DEVICE_RETRY_BASE_DELAY * 2 ** retryAttempt,
      DEVICE_RETRY_MAX_DELAY,
    )

    ++retryAttempt
    retryTimer = setTimeout(() => {
      retryTimer = void 0

      if (unmounted || generation !== lifecycleGeneration || listenerState !== 'unavailable') {
        return
      }

      if (listenerStart) {
        --retryAttempt
        scheduleListenerRestart()

        return
      }

      void requestListenerStart()
    }, delay)
  }

  async function requestListenerStart() {
    if (unmounted) return
    if (listenerStart) return listenerStart

    const generation = lifecycleGeneration
    const nextListenerStart = (async () => {
      try {
        await Promise.all([deviceListenerReady, deviceStatusListenerReady])

        if (unmounted || generation !== lifecycleGeneration) return

        if (!await ensureInputMonitoringPermission()) return

        if (unmounted || generation !== lifecycleGeneration) return

        await invoke(INVOKE_KEY.START_DEVICE_LISTENING)
      } catch (reason) {
        if (unmounted || generation !== lifecycleGeneration) return

        listenerState = 'unavailable'
        releaseInputState()
        modelRuntime.updatePetRuntimeContext({ inputStatus: 'unavailable' })

        const message = reason instanceof Error ? reason.message : String(reason)

        console.error('Failed to start device listening:', reason)
        void error(`Failed to start device listening: ${message}`).catch((logReason) => {
          console.error('Failed to write device listening error log:', logReason)
        })

        scheduleListenerRestart()
      }
    })()

    listenerStart = nextListenerStart

    try {
      await nextListenerStart
    } finally {
      if (listenerStart === nextListenerStart) listenerStart = void 0
    }
  }

  const startListening = () => {
    modelRuntime.updatePetRuntimeContext({ inputStatus: 'unavailable' })

    return requestListenerStart()
  }

  return {
    startListening,
    prepareModelTransition,
    remapPressedKeyboardInputs,
  }
}
