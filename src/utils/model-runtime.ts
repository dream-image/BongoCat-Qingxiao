import type { MotionInfo } from 'easy-live2d'

import type { ModelRenderer } from '@/stores/model'

import type { PetBehaviorRuntimeContext, PetInteractionInput, PetPoint } from './pet-behavior'

import live2d from './live2d'
import { PetBehaviorController } from './pet-behavior'
import sprite from './sprite'

class ModelRuntime {
  private renderer: ModelRenderer = 'live2d'
  private mirrored = false
  // 模型加载和宠物退出都是跨帧异步流程；generation 让旧 Promise 只能自然结束，不能回写新模型。
  private loadGeneration = 0
  private petExitGeneration = 0
  private pendingSpriteBinding: string | undefined
  // inputId 表示物理输入身份，value 表示当前模型映射出的动画键。二者分离后，切模型时可以
  // 保留“仍按住”的事实，再用新模型配置重映射，而不会伪造一次新的按键和气泡。
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

      // 快速连续切换模型时，较慢的旧加载不能覆盖最后一次选择。
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
    // 行为控制器依赖当前精灵模型的动画名，因此必须等资源和配置完整校验后再启动。
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

        // 自动重复或映射配置变化时，沿用首次按下时的 renderKey，保证 down/up 成对释放
        // 同一个动画；只有显式 remap 才允许迁移到新模型的映射。
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
      // 没有 behaviors.pet 的旧模型继续走原渲染路径，保持模型配置向后兼容。
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
      // delete/add 会把重复按下的绑定移到 Set 尾部；宠物退出后按“最近按下”顺序恢复动作。
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
      // 退出动画期间只登记按下状态，不抢播工作动画；退出完成后再恢复最后仍按住的绑定。
      this.pendingSpriteBinding = renderKey
      sprite.markKeyboardBindingPressed(renderKey)
    }

    const generation = ++this.petExitGeneration

    void this.playPendingBindingAfterPetExit(generation)

    return result
  }

  public setKeyboardInputActive(inputId: string, active: boolean) {
    // 输入监听可先于模型按键映射建立；undefined 仍代表真实按住，必须阻止空闲宠物激活。
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
    // 切模型期间保留物理输入集合，但清空旧模型的动画身份，避免 keyup 使用过期绑定。
    for (const inputId of inputIds) {
      this.activeKeyboardInputs.set(inputId, void 0)
    }

    this.clearKeyboardRenderState()
    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs.keys())

    if (this.renderer === 'sprite') sprite.syncPressedKeyboardBindings([])
  }

  public remapKeyboardInputs(inputs: Iterable<{ inputId: string, renderKey: string }>) {
    // 新模型就绪后一次性重建渲染状态；这里不显示气泡，因为用户没有再次实际按键。
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
    // 多个物理键可映射到同一组动作，渲染层只需要一份去重后的动画键集合。
    return [...new Set(this.activeKeyboardInputs.values())].flatMap((renderKey) => {
      return renderKey ? [renderKey] : []
    })
  }

  public handleMouse(button: string, pressed: boolean) {
    if (this.renderer !== 'sprite') return
    if (this.petBehavior.isPetActive) {
      // 宠物形态下鼠标由命中区状态机处理，但 release 仍要清掉进入宠物前遗留的循环动作。
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
      // 渲染或输入能力失效意味着等待中的“退出后播放按键”已无效，提前作废异步续播。
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
    // 先停行为控制器再销毁画布，使其能结算播放 Promise，同时禁止旧回调恢复已销毁的动画。
    this.petBehavior.updateContext({ rendererReady: false })
    this.petBehavior.stop()
    this.petBehavior.configure()
    this.petBehavior.syncActiveKeyboardInputs(this.activeKeyboardInputs.keys())
    this.clearKeyboardRenderState()
    live2d.destroy()
    sprite.destroy()
  }

  private clearKeyboardRenderState() {
    // 所有重映射/销毁入口统一经过这里，确保等待中的退出链路看见新的 generation。
    this.petExitGeneration++
    this.pendingSpriteBinding = void 0
    this.pressedSpriteBindings.clear()
  }

  private async playPendingBindingAfterPetExit(generation: number) {
    await this.petBehavior.exitForInput()

    // 等待期间可能切模型、关闭行为或出现更新的按键，旧 continuation 不能再操作精灵。
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
      // 按键仍按住时恢复循环/一次性绑定；若已经释放，则只补播一次触发动画后回到仍按住项。
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
