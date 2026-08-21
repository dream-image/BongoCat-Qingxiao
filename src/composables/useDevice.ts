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
import { useModelRuntimeStore } from '@/stores/model-runtime'
import { useModelSelectionStore } from '@/stores/model-selection'
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
  // code 是稳定的物理输入；renderKey 会随当前模型的支持键规则变化。
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
// 重启采用有上限的指数退避；连续稳定后才清零，避免故障循环高频占用 CPU。
const DEVICE_RETRY_BASE_DELAY = 500
const DEVICE_RETRY_MAX_DELAY = 8000
const DEVICE_RETRY_MAX_ATTEMPTS = 6
const DEVICE_READY_STABILITY_DELAY = 10000
const WINDOW_VISIBILITY_POLL_DELAY = 50
const WINDOW_VISIBILITY_POLL_ATTEMPTS = 40
// 鼠标移动只用于重置被动空闲计时；时间与距离双门槛避免原生高频事件持续轰击调度器。
const MOUSE_ACTIVITY_SAMPLE_INTERVAL = 400
const MOUSE_ACTIVITY_MIN_DISTANCE = 24
const appWindow = getCurrentWebviewWindow()

export function useDevice() {
  const modelRuntimeStore = useModelRuntimeStore()
  const modelSelectionStore = useModelSelectionStore()
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
  // 所有跨 await/timer 的任务都用代次判旧，卸载后不得再写组件或 runtime 状态。
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
  // 配置可见不等于窗口已渲染；hover 隐藏也需要单独记录，供宠物行为门禁使用。
  let pointerInsideMainWindow = false
  let hoverHidden = false
  let actualWindowVisible = false
  // 窗口 API 首次回读前不产生 presence 边沿，防止启动默认值被误判为一次离开/回来。
  let actualWindowVisibilityKnown = false
  let reportedPresenceVisible: boolean | undefined
  let lastMouseActivityAt = Number.NEGATIVE_INFINITY
  let lastMouseActivityPoint: CursorPoint | undefined
  let windowVisibilityGeneration = 0
  let unlistenWindowClose = () => {}
  let desiredIgnoreCursorEvents = false
  // Tauri 写入是异步的，用单一任务收敛到最后一次期望值，避免完成顺序倒置。
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
    // 监听器中断时 release 事件可能永远不到达，必须以本地账本主动归零全部输入。
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
    // 初始化读取真实窗口状态，不能仅相信持久化的 visible 配置。
    document.addEventListener('visibilitychange', syncDocumentVisibility)
    syncDocumentVisibility()
    void reconcileWindowVisibility()

    const nextUnlistenWindowClose = await appWindow.onCloseRequested(() => {
      void reconcileWindowVisibility(false)
    })

    // onCloseRequested 的订阅也是异步的，解决后若已卸载必须立即反订阅。
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
    // 推进两个代次，使监听重启、权限轮询和窗口可见性轮询的迟到结果全部失效。
    unmounted = true
    ++lifecycleGeneration
    ++windowVisibilityGeneration
    unlistenWindowClose()
    document.removeEventListener('visibilitychange', syncDocumentVisibility)
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
    // 保存 resolve，使卸载时能主动唤醒轮询，避免 Promise 长时间悬挂。
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
    // 多次重启请求共享同一个授权流程，避免重复弹系统授权窗口。
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
    // sprite 自己负责按键分组；Live2D 缺少左右修饰键/Fn 资源时才回退到通用键。
    if (modelSelectionStore.currentModel?.renderer === 'sprite') return key

    let nextKey = key

    const unsupportedKey = !modelRuntimeStore.supportKeys[nextKey]

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
    // 自主行为只允许在用户确实能看到角色时运行，逻辑 visible 只是必要条件之一。
    modelRuntime.updatePetRuntimeContext({
      renderedVisible: !unmounted
        && catStore.window.visible
        && actualWindowVisible
        && document.visibilityState === 'visible'
        && !hoverHidden,
    })
  }

  const syncIgnoreCursorEvents = () => {
    desiredIgnoreCursorEvents = hoverHidden || catStore.window.passThrough

    // 已有写任务会在完成后读取最新期望值并继续，不并发调用系统 API。
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

  const syncPetPresence = () => {
    if (!actualWindowVisibilityKnown) return

    const visible = actualWindowVisible && document.visibilityState === 'visible'

    if (visible === reportedPresenceVisible) return

    // Presence 只由真实窗口和 document 可见边沿组成；hover/resize/focus 不得伪造“久别归来”。
    reportedPresenceVisible = visible
    modelRuntime.setPetPresenceVisible(visible)
  }

  const setActualWindowVisible = (visible: boolean) => {
    actualWindowVisible = visible
    // 首次只建立 presence 基线；不能把初始默认 false 当成一次真实离开。
    actualWindowVisibilityKnown = true
    syncPetPresence()
    syncRenderedVisibility()
  }

  const syncDocumentVisibility = () => {
    // 锁屏/最小化可能只隐藏 WebView 而 Tauri 窗口仍报 visible，两个闸门必须同时更新。
    syncPetPresence()
    syncRenderedVisibility()
  }

  const reconcileWindowVisibility = async (expected?: boolean) => {
    // showWindow 返回与系统真正显示之间有延迟；轮询并用代次丢弃旧 show/hide 结果。
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

    // 视觉隐藏与鼠标穿透必须作为一次状态转换同步更新。
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
      // 禁用鼠标时清除平滑队列、hover 定时器和已按按钮，避免恢复后补播旧交互。
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

    // 只在跨越窗口边界时建/撤定时器，普通移动不应不断延后隐藏。
    if (isInWindow === pointerInsideMainWindow) return

    pointerInsideMainWindow = isInWindow
    clearHideOnHoverTimer()

    if (!isInWindow) {
      setHoverHidden(false)

      return
    }

    hideOnHoverTimer = setTimeout(() => {
      hideOnHoverTimer = void 0

      // 定时器触发前设置可能已改变，提交隐藏前重新验证全部前置条件。
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
    // 任一门禁关闭都立即取消待执行隐藏，防止旧 timer 反向覆盖新配置。
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

  const reportMouseActivity = (cursorPoint: CursorPoint) => {
    const now = performance.now()
    const previous = lastMouseActivityPoint

    if (now - lastMouseActivityAt < MOUSE_ACTIVITY_SAMPLE_INTERVAL) return
    if (previous
      && Math.hypot(cursorPoint.x - previous.x, cursorPoint.y - previous.y)
      < MOUSE_ACTIVITY_MIN_DISTANCE) {
      return
    }

    lastMouseActivityAt = now
    lastMouseActivityPoint = cursorPoint
    // 只上报经距离+时间节流的离散 pulse，不把高频坐标流传入行为引擎。
    modelRuntime.notifyPetPassiveActivity({
      inputId: 'Mouse:Move',
      phase: 'pulse',
      source: 'mouse',
    })
  }

  const prepareModelTransition = () => {
    // 模型切换只暂停视觉映射，保留真实按压账本，用户持续按键仍应阻止 idle 行为。
    for (const input of pressedKeyboardInputs.values()) {
      input.renderKey = void 0
    }

    modelRuntime.suspendKeyboardInputRendering(pressedKeyboardInputs.keys())
    releaseMouseInputState()
  }

  const remapPressedKeyboardInputs = () => {
    // 新模型资源就绪后按原始 code 重新求 renderKey；不生成新气泡，也不伪造新按键。
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

    // release 以物理 inputId 定位，再交给 runtime 判断共享 renderKey 是否仍被其他输入占用。
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
    // 重复 press 沿用已绑定的 renderKey，避免模型资源变化中途造成一键对应两张贴图。
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
    if (modelRuntimeStore.modelReady) return handleKeyboardPress(inputId, code, label)

    // 渲染器未就绪时仍登记真实输入，既保护 idle 门禁，也供加载完成后无缝 remap。
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

    // timer 必须按物理输入编号覆盖，Windows 的重复 press 才不会提前释放新一次按压。
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

        reportMouseActivity(value)

        return latestCursorPoint.value = value
    }
  })

  const deviceStatusListenerReady = useTauriListen<DeviceListenerStatus>(
    LISTEN_KEY.DEVICE_LISTENER_STATUS,
    ({ payload }) => {
      listenerState = payload.state

      if (payload.state === 'unavailable') {
        // 后端 tap 失效意味着输入账本不再可信，先归零，再安排有限重试。
        clearReadyResetTimer()
        releaseInputState()
        scheduleListenerRestart()
      } else {
        clearRetryTimer()

        if (payload.state === 'ready') {
          clearReadyResetTimer()

          // 短暂 ready 仍可能是崩溃循环，稳定一段时间后才恢复完整重试预算。
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

    // 指数退避有次数与时长上限，既允许瞬时恢复，也避免永久故障时忙循环。
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
        // 与在途启动撞车不消耗一次重试额度，稍后继续按原次数调度。
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
        // 必须先订阅数据和状态事件，再启动后端生产者，否则会漏掉首次 ready/unavailable。
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
    // 在收到后端 ready 之前保持不可用，防止自主行为在输入盲区误触发。
    modelRuntime.updatePetRuntimeContext({ inputStatus: 'unavailable' })

    return requestListenerStart()
  }

  return {
    startListening,
    prepareModelTransition,
    remapPressedKeyboardInputs,
  }
}
