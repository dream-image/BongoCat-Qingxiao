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
  private readonly activeKeyboardInputs = new Map<string, string | undefined>()
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
    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs.keys())
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
    inputId = key,
  ) {
    let renderKey = key
    let shouldReleaseRenderState = true

    if (trackInput) {
      if (pressed) {
        const activeRenderKey = this.activeKeyboardInputs.get(inputId)

        if (activeRenderKey !== void 0) {
          renderKey = activeRenderKey
        } else {
          this.activeKeyboardInputs.set(inputId, renderKey)
        }
      } else {
        renderKey = this.activeKeyboardInputs.get(inputId) ?? renderKey
        this.activeKeyboardInputs.delete(inputId)
        shouldReleaseRenderState = ![...this.activeKeyboardInputs.values()]
          .includes(renderKey)
      }
    }

    const result = {
      key: renderKey,
      renderStateChanged: pressed || shouldReleaseRenderState,
    }

    if (this.renderer !== 'sprite') return result

    if (!this.petBehavior.hasConfig) {
      if (!pressed && !shouldReleaseRenderState) return result

      sprite.handleKeyboard(renderKey, pressed, label ?? void 0)

      return result
    }

    if (!pressed) {
      if (trackInput) this.petBehavior.notifyKeyboardRelease(inputId)

      if (!shouldReleaseRenderState) return result

      this.pressedSpriteBindings.delete(renderKey)
      sprite.handleKeyboardBinding(renderKey, false, !this.petBehavior.isPetActive)

      return result
    }

    const hasBinding = sprite.hasKeyboardBinding(renderKey)

    if (hasBinding) {
      this.pressedSpriteBindings.delete(renderKey)
      this.pressedSpriteBindings.add(renderKey)
    }

    sprite.showKeyboardBubble(renderKey, label ?? void 0)
    const exitingPet = this.petBehavior.notifyKeyboardPress(inputId)

    if (!exitingPet) {
      sprite.handleKeyboardBinding(renderKey, true)

      return result
    }

    if (hasBinding) {
      this.pendingSpriteBinding = renderKey
      sprite.markKeyboardBindingPressed(renderKey)
    }

    const generation = ++this.petExitGeneration

    void this.playPendingBindingAfterPetExit(generation)

    return result
  }

  public setKeyboardInputActive(inputId: string, active: boolean) {
    if (active) {
      if (!this.activeKeyboardInputs.has(inputId)) {
        this.activeKeyboardInputs.set(inputId, void 0)
      }
    } else {
      this.activeKeyboardInputs.delete(inputId)
    }

    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs.keys())
  }

  public suspendKeyboardInputRendering(inputIds: Iterable<string>) {
    for (const inputId of inputIds) {
      this.activeKeyboardInputs.set(inputId, void 0)
    }

    this.clearKeyboardRenderState()
    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs.keys())

    if (this.renderer === 'sprite') sprite.syncPressedKeyboardBindings([])
  }

  public remapKeyboardInputs(inputs: Iterable<{ inputId: string, renderKey: string }>) {
    this.clearKeyboardRenderState()

    for (const { inputId, renderKey } of inputs) {
      this.activeKeyboardInputs.set(inputId, renderKey)
    }

    const activeRenderKeys = this.getActiveRenderKeys()

    for (const renderKey of activeRenderKeys) {
      if (this.renderer === 'sprite' && sprite.hasKeyboardBinding(renderKey)) {
        this.pressedSpriteBindings.add(renderKey)
      }
    }

    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs.keys())

    if (this.renderer !== 'sprite') return activeRenderKeys

    sprite.syncPressedKeyboardBindings([...this.pressedSpriteBindings])

    if (!this.petBehavior.isPetActive) sprite.resumePressedInputBinding()

    return activeRenderKeys
  }

  public getActiveRenderKeys() {
    return [...new Set(this.activeKeyboardInputs.values())].flatMap((renderKey) => {
      return renderKey ? [renderKey] : []
    })
  }

  public handleMouse(button: string, pressed: boolean) {
    if (this.renderer !== 'sprite') return
    if (this.petBehavior.isPetActive) {
      return pressed ? false : sprite.handleMouse(button, false, false)
    }

    return sprite.handleMouse(button, pressed)
  }

  public updatePetRuntimeContext(context: Partial<PetBehaviorRuntimeContext>) {
    if (context.enabled === false
      || context.visible === false
      || context.rendererReady === false
      || context.renderedVisible === false
      || context.inputStatus === 'unavailable') {
      this.petExitGeneration++
      this.pendingSpriteBinding = void 0
    }

    this.petBehavior.updateContext(context)

    if (context.inputStatus !== void 0) {
      this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs.keys())
    }
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
    this.petBehavior.updateContext({ rendererReady: false })
    this.petBehavior.stop()
    this.petBehavior.configure()
    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs.keys())
    this.clearKeyboardRenderState()
    live2d.destroy()
    sprite.destroy()
  }

  private clearKeyboardRenderState() {
    this.petExitGeneration++
    this.pendingSpriteBinding = void 0
    this.pressedSpriteBindings.clear()
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
