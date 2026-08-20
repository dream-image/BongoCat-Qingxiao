import type { MotionInfo } from 'easy-live2d'

import type { ModelRenderer } from '@/stores/model'

import type { PetBehaviorRuntimeContext, PetInteractionInput, PetPoint } from './pet-behavior'

import live2d from './live2d'
import { PetBehaviorController } from './pet-behavior'
import sprite from './sprite'

class ModelRuntime {
  private renderer: ModelRenderer = 'live2d'
  private mirrored = false
  private loadGeneration = 0
  private petExitGeneration = 0
  private pendingSpriteBinding: string | undefined
  private readonly activeKeyboardInputs = new Set<string>()
  private readonly pressedSpriteBindings = new Set<string>()
  private readonly petBehavior = new PetBehaviorController(void 0, {
    driver: {
      play: (animation, options) => sprite.play(animation, options),
    },
  })

  public async load(path: string, renderer: ModelRenderer) {
    const generation = ++this.loadGeneration

    this.destroyRenderers()

    this.renderer = renderer

    if (renderer === 'live2d') {
      const result = await live2d.load(path)

      if (generation !== this.loadGeneration) {
        throw new DOMException('Model load was superseded', 'AbortError')
      }

      return result
    }

    const result = await sprite.load(path)

    if (generation !== this.loadGeneration) {
      throw new DOMException('Model load was superseded', 'AbortError')
    }

    sprite.setMirrored(this.mirrored)
    this.petBehavior.configure(result.petBehavior, result.defaultAnimation)
    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs)
    this.petBehavior.start()

    return result
  }

  public destroy() {
    ++this.loadGeneration
    this.destroyRenderers()
  }

  public resizeModel(size: { width: number, height: number }) {
    if (this.renderer === 'sprite') {
      sprite.resizeModel(size)
    } else {
      live2d.resizeModel(size)
    }
  }

  public startMotion(motion: MotionInfo) {
    if (this.renderer !== 'live2d') return

    return live2d.startMotion(motion)
  }

  public setExpression(index: number) {
    if (this.renderer !== 'live2d') return

    return live2d.setExpression(index)
  }

  public getParameterValueRange(id: string) {
    if (this.renderer !== 'live2d') return

    return live2d.getParameterValueRange(id)
  }

  public setParameterValue(id: string, value: number | boolean) {
    if (this.renderer !== 'live2d') return

    return live2d.setParameterValue(id, value)
  }

  public handleKeyboard(
    key: string,
    pressed: boolean,
    label?: string | null,
    trackInput = true,
  ) {
    if (trackInput) {
      if (pressed) {
        this.activeKeyboardInputs.add(key)
      } else {
        this.activeKeyboardInputs.delete(key)
      }
    }

    if (this.renderer !== 'sprite') return

    if (!this.petBehavior.hasConfig) {
      return sprite.handleKeyboard(key, pressed, label ?? void 0)
    }

    if (!pressed) {
      this.pressedSpriteBindings.delete(key)

      if (trackInput) this.petBehavior.notifyKeyboardRelease(key)

      return sprite.handleKeyboardBinding(key, false, !this.petBehavior.isPetActive)
    }

    const hasBinding = sprite.hasKeyboardBinding(key)

    if (hasBinding) {
      this.pressedSpriteBindings.delete(key)
      this.pressedSpriteBindings.add(key)
    }

    const bubbleShown = sprite.showKeyboardBubble(key, label ?? void 0)
    const exitingPet = this.petBehavior.notifyKeyboardPress(key)

    if (!exitingPet) {
      return sprite.handleKeyboardBinding(key, true) || bubbleShown
    }

    if (hasBinding) {
      this.pendingSpriteBinding = key
      sprite.markKeyboardBindingPressed(key)
    }

    const generation = ++this.petExitGeneration

    void this.playPendingBindingAfterPetExit(generation)

    return true
  }

  public handleMouse(button: string, pressed: boolean) {
    if (this.renderer !== 'sprite') return
    if (this.petBehavior.isPetActive) {
      return pressed ? false : sprite.handleMouse(button, false, false)
    }

    return sprite.handleMouse(button, pressed)
  }

  public updatePetRuntimeContext(context: Partial<PetBehaviorRuntimeContext>) {
    if (context.inputStatus === 'unavailable') this.activeKeyboardInputs.clear()

    if (context.enabled === false
      || context.visible === false
      || context.inputStatus === 'unavailable') {
      this.petExitGeneration++
      this.pendingSpriteBinding = void 0
    }

    this.petBehavior.updateContext(context)
  }

  public hitTestPetPointer(point: PetPoint) {
    if (this.renderer !== 'sprite' || !this.petBehavior.isPetActive) return []

    return this.petBehavior.hitTest(point)
  }

  public resolvePetInteraction(input: PetInteractionInput) {
    if (this.renderer !== 'sprite' || !this.petBehavior.isPetActive) return

    return this.petBehavior.resolveInteraction(input)
  }

  public isPetPointerBlocked() {
    return this.renderer === 'sprite'
      && this.petBehavior.isPetActive
      && !this.canReceivePetPointer()
  }

  public handlePetInteraction(input: PetInteractionInput) {
    if (this.renderer !== 'sprite') return false

    return this.petBehavior.dispatchInteraction(input)
  }

  public readonly setMotionSoundEnabled = (enabled: boolean) => {
    live2d.setMotionSoundEnabled(enabled)
  }

  public readonly setMaxFPS = (fps: number) => {
    live2d.setMaxFPS(fps)
    sprite.setMaxFPS(fps)
  }

  public readonly setMirrored = (mirrored: boolean) => {
    this.mirrored = mirrored
    sprite.setMirrored(mirrored)
  }

  private destroyRenderers() {
    this.petBehavior.stop()
    this.petBehavior.configure()
    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs)
    this.petExitGeneration++
    this.pendingSpriteBinding = void 0
    this.pressedSpriteBindings.clear()
    live2d.destroy()
    sprite.destroy()
  }

  private async playPendingBindingAfterPetExit(generation: number) {
    await this.petBehavior.exitForInput()

    if (generation !== this.petExitGeneration
      || this.renderer !== 'sprite'
      || !this.petBehavior.hasConfig) {
      return
    }

    const key = this.pendingSpriteBinding
    this.pendingSpriteBinding = void 0

    sprite.syncPressedKeyboardBindings([...this.pressedSpriteBindings])

    if (!key) {
      sprite.resumePressedInputBinding()

      return
    }

    if (this.pressedSpriteBindings.has(key)) {
      sprite.playPressedKeyboardBinding(key)

      return
    }

    const playback = sprite.triggerKeyboardBinding(key)

    if (!playback) {
      sprite.resumePressedInputBinding()

      return
    }

    const result = await playback.finished

    if (result.reason !== 'finished'
      || generation !== this.petExitGeneration
      || this.renderer !== 'sprite'
      || !this.petBehavior.hasConfig) {
      return
    }

    sprite.resumePressedInputBinding()
  }

  private canReceivePetPointer() {
    return this.petBehavior.state === 'pet-idle'
      || this.petBehavior.state === 'pet-action'
  }
}

const modelRuntime = new ModelRuntime()

export default modelRuntime
