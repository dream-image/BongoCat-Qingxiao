import type { LiteralUnion } from 'type-fest'

import { invoke } from '@tauri-apps/api/core'
import { computed, reactive, watch } from 'vue'

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

export function useGamepad() {
  const modelStore = useModelStore()
  const { handlePress, handleRelease, handleAxisChange } = useModel()
  const sticks = reactive<Sticks>({
    left: { ...INITIAL_STICK_STATE },
    right: { ...INITIAL_STICK_STATE },
  })
  const pressedButtons = new Set<string>()
  const pressedThumbs = new Set<'LeftThumb' | 'RightThumb'>()
  let gamepadModeActive = false

  const stickActive = computed(() => ({
    left: sticks.left.moved || sticks.left.pressed,
    right: sticks.right.moved || sticks.right.pressed,
  }))

  const getInputId = (name: string) => `Gamepad:${name}`

  const releaseGamepadState = () => {
    for (const name of pressedButtons) {
      handleRelease(name, true, getInputId(name))
    }

    for (const name of pressedThumbs) {
      modelRuntime.setKeyboardInputActive(getInputId(name), false)
    }

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

    void invoke(gamepadModeActive
      ? INVOKE_KEY.START_GAMEPAD_LISTING
      : INVOKE_KEY.STOP_GAMEPAD_LISTING)
  }, { immediate: true })

  watch(() => modelStore.modelReady, (ready) => {
    if (!ready || !gamepadModeActive) return

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
    if (!gamepadModeActive) return

    const { name, value } = payload

    switch (name) {
      case 'LeftStickX':
        sticks.left.x = value

        return handleAxisChange('CatParamStickLX', value)
      case 'LeftStickY':
        sticks.left.y = value

        return handleAxisChange('CatParamStickLY', value)
      case 'RightStickX':
        sticks.right.x = value

        return handleAxisChange('CatParamStickRX', value)
      case 'RightStickY':
        sticks.right.y = value

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
