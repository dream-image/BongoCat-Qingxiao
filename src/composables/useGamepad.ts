import type { LiteralUnion } from 'type-fest'

import { invoke } from '@tauri-apps/api/core'
import { computed, onUnmounted, reactive, watch } from 'vue'

import { INVOKE_KEY, LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import modelRuntime from '@/utils/model-runtime'

import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

type GamepadEventName = LiteralUnion<'LeftStickX' | 'LeftStickY' | 'RightStickX' | 'RightStickY' | 'LeftThumb' | 'RightThumb', string>

interface GamepadEvent {
  kind: 'ButtonChanged' | 'AxisChanged'
  name: GamepadEventName
  value: number
}

interface StickState {
  x: number
  y: number
  moved: boolean
  pressed: boolean
}

interface Sticks {
  left: StickState
  right: StickState
}

const INITIAL_STICK_STATE: StickState = { x: 0, y: 0, moved: false, pressed: false }
// 进入阈值高于退出阈值形成 hysteresis，既过滤摇杆漂移，也能在真实回中时可靠释放活跃态。
const STICK_ACTIVITY_ENTER_THRESHOLD = 0.18
const STICK_ACTIVITY_EXIT_THRESHOLD = 0.10

export function useGamepad() {
  const modelStore = useModelStore()
  const { handlePress, handleRelease, handleAxisChange } = useModel()
  const sticks = reactive<Sticks>({
    left: { ...INITIAL_STICK_STATE },
    right: { ...INITIAL_STICK_STATE },
  })
  const pressedButtons = new Set<string>()
  const pressedThumbs = new Set<'LeftThumb' | 'RightThumb'>()
  const stickAxisActive = { left: false, right: false }
  let gamepadModeActive = false

  const stickActive = computed(() => ({
    left: sticks.left.moved || sticks.left.pressed,
    right: sticks.right.moved || sticks.right.pressed,
  }))

  // 输入 ID 带来源命名空间，避免手柄按钮名与键盘键名互相覆盖释放状态。
  const getInputId = (name: string) => `Gamepad:${name}`

  const releaseGamepadState = () => {
    // 停止监听时系统不会补发 release，必须主动清空 runtime 与模型参数，防止“卡键”。
    for (const name of pressedButtons) {
      handleRelease(name, true, getInputId(name))
    }

    for (const name of pressedThumbs) {
      modelRuntime.setKeyboardInputActive(getInputId(name), false)
    }

    // 轴向活跃是前端合成的 held 输入，设备停止监听时同样不会收到原生 release，必须显式收尾。
    modelRuntime.setKeyboardInputActive(getInputId('LeftStickAxis'), false)
    modelRuntime.setKeyboardInputActive(getInputId('RightStickAxis'), false)
    stickAxisActive.left = false
    stickAxisActive.right = false

    pressedButtons.clear()
    pressedThumbs.clear()
    Object.assign(sticks.left, INITIAL_STICK_STATE)
    Object.assign(sticks.right, INITIAL_STICK_STATE)
    modelRuntime.setParameterValue('CatParamStickLX', 0)
    modelRuntime.setParameterValue('CatParamStickLY', 0)
    modelRuntime.setParameterValue('CatParamStickRX', 0)
    modelRuntime.setParameterValue('CatParamStickRY', 0)
    modelRuntime.setParameterValue('CatParamStickLeftDown', false)
    modelRuntime.setParameterValue('CatParamStickRightDown', false)
  }

  watch(() => modelStore.currentModel?.mode, (mode) => {
    gamepadModeActive = mode === 'gamepad'

    if (!gamepadModeActive) releaseGamepadState()

    // invoke 失败不应打断 Vue watcher；后续模式变化仍可再次尝试同步原生监听状态。
    void invoke(gamepadModeActive
      ? INVOKE_KEY.START_GAMEPAD_LISTING
      : INVOKE_KEY.STOP_GAMEPAD_LISTING).catch(() => void 0)
  }, { immediate: true })

  onUnmounted(() => {
    // 组件卸载与模式切换采用相同收尾规则，保证原生监听和前端按压状态一起结束。
    gamepadModeActive = false
    releaseGamepadState()
    void invoke(INVOKE_KEY.STOP_GAMEPAD_LISTING).catch(() => void 0)
  })

  watch(() => modelStore.modelReady, (ready) => {
    if (!ready || !gamepadModeActive) return

    // 模型切换会重建渲染器；重放仍有效的摇杆状态，而不是等待下一次硬件事件。
    void handleAxisChange('CatParamStickLX', sticks.left.x)
    void handleAxisChange('CatParamStickLY', sticks.left.y)
    void handleAxisChange('CatParamStickRX', sticks.right.x)
    void handleAxisChange('CatParamStickRY', sticks.right.y)
    modelRuntime.setParameterValue('CatParamStickLeftDown', sticks.left.pressed)
    modelRuntime.setParameterValue('CatParamStickRightDown', sticks.right.pressed)
    modelRuntime.setParameterValue(
      'CatParamStickShowLeftHand',
      sticks.left.moved || sticks.left.pressed,
    )
    modelRuntime.setParameterValue(
      'CatParamStickShowRightHand',
      sticks.right.moved || sticks.right.pressed,
    )
  }, { immediate: true })

  watch(sticks.left, ({ x, y, moved, pressed }) => {
    sticks.left.moved = x !== 0 || y !== 0

    modelRuntime.setParameterValue('CatParamStickShowLeftHand', moved || pressed)
  }, { deep: true })

  watch(sticks.right, ({ x, y, moved, pressed }) => {
    sticks.right.moved = x !== 0 || y !== 0

    modelRuntime.setParameterValue('CatParamStickShowRightHand', moved || pressed)
  }, { deep: true })

  useTauriListen<GamepadEvent>(LISTEN_KEY.GAMEPAD_CHANGED, ({ payload }) => {
    // stop invoke 与事件投递存在时间差，离开手柄模式后的迟到事件必须丢弃。
    if (!gamepadModeActive) return

    const { name, value } = payload

    const syncStickActivity = (side: 'left' | 'right') => {
      const stick = sticks[side]
      const magnitude = Math.hypot(stick.x, stick.y)
      const nextActive = stickAxisActive[side]
        ? magnitude > STICK_ACTIVITY_EXIT_THRESHOLD
        : magnitude >= STICK_ACTIVITY_ENTER_THRESHOLD

      // 摇杆回中会有小幅噪声；用双阈值滞回只上报 neutral↔active 边沿，避免永久卡在活跃态。
      if (nextActive === stickAxisActive[side]) return

      stickAxisActive[side] = nextActive
      modelRuntime.setKeyboardInputActive(
        getInputId(side === 'left' ? 'LeftStickAxis' : 'RightStickAxis'),
        nextActive,
      )
    }

    switch (name) {
      case 'LeftStickX':
        sticks.left.x = value
        syncStickActivity('left')

        return handleAxisChange('CatParamStickLX', value)
      case 'LeftStickY':
        sticks.left.y = value
        syncStickActivity('left')

        return handleAxisChange('CatParamStickLY', value)
      case 'RightStickX':
        sticks.right.x = value
        syncStickActivity('right')

        return handleAxisChange('CatParamStickRX', value)
      case 'RightStickY':
        sticks.right.y = value
        syncStickActivity('right')

        return handleAxisChange('CatParamStickRY', value)
      case 'LeftThumb':
        return handleThumbChange('LeftThumb', value !== 0)
      case 'RightThumb':
        return handleThumbChange('RightThumb', value !== 0)
      default:
        return handleButtonChange(name, value > 0)
    }
  })

  const handleButtonChange = (name: string, pressed: boolean) => {
    const wasPressed = pressedButtons.has(name)

    // 部分驱动会连续上报相同值，去重后才不会重复生成气泡或重置行为计时。
    if (pressed === wasPressed) return

    if (pressed) {
      pressedButtons.add(name)
      handlePress(name, void 0, getInputId(name))
    } else {
      pressedButtons.delete(name)
      handleRelease(name, true, getInputId(name))
    }
  }

  const handleThumbChange = (name: 'LeftThumb' | 'RightThumb', pressed: boolean) => {
    const wasPressed = pressedThumbs.has(name)

    if (pressed === wasPressed) return

    const isLeft = name === 'LeftThumb'

    if (pressed) {
      pressedThumbs.add(name)
    } else {
      pressedThumbs.delete(name)
    }

    if (isLeft) {
      sticks.left.pressed = pressed
    } else {
      sticks.right.pressed = pressed
    }

    // 摇杆按下也属于活跃输入，必须阻止用户操作期间进入自主宠物形态。
    modelRuntime.setKeyboardInputActive(getInputId(name), pressed)
    modelRuntime.setParameterValue(
      isLeft ? 'CatParamStickLeftDown' : 'CatParamStickRightDown',
      pressed,
    )
  }

  return {
    stickActive,
  }
}
