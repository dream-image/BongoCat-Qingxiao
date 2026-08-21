import type { MotionInfo } from 'easy-live2d'

import type { ModelRenderer } from '@/stores/model'

import type {
  PetBehaviorRuntimeContext,
  PetBehaviorState,
  PetInteractionInput,
  PetPoint,
} from './pet-behavior'
import type { PetPassiveActivitySignal } from './pet-behavior-passive'

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
  private resumePressedBindingsAfterManualAction = false
  // 菜单期间按下的物理键仍需成对记账，但必须与可渲染绑定隔离到 release 到来为止。
  private readonly menuSuppressedKeyboardInputs = new Set<string>()
  // inputId 表示物理输入身份，value 表示当前模型映射出的动画键。二者分离后，切模型时可以
  // 保留“仍按住”的事实，再用新模型配置重映射，而不会伪造一次新的按键和气泡。
  private readonly activeKeyboardInputs = new Map<string, string | undefined>()
  private readonly pressedSpriteBindings = new Set<string>()
  private readonly petBehavior = new PetBehaviorController(void 0, {
    driver: {
      play: (animation, options) => sprite.play(animation, options),
      // 对话是独立于人物动作的单槽覆盖层；由行为代次负责决定何时显示，渲染器只负责绘制。
      speak: payload => sprite.showSpeechBubble(payload),
      clearSpeech: () => sprite.clearSpeechBubble(),
    },
    onStateChange: state => this.handlePetBehaviorStateChange(state),
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
    // canonical 模型路径同时是被动事件 scope：切回同一模型不会把 startup/当日窗口伪造成新事件。
    this.petBehavior.configure(result.petBehavior, result.defaultAnimation, path)
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
    const wasInputActive = this.activeKeyboardInputs.has(inputId)
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

    if (pressed && this.petBehavior.isActionMenuOpen) {
      // 原生菜单导航键不是模型操作；保留物理 held 事实，但不显示气泡或抢播人物动画。
      if (!wasInputActive) {
        this.menuSuppressedKeyboardInputs.add(inputId)
        this.petBehavior.notifyKeyboardPress(inputId)
      }

      // key repeat 会先经过上方通用映射逻辑；每次都重写为 undefined，
      // 否则第二个重复 down 会把菜单方向键偷偷加回人物按键贴图。
      if (this.menuSuppressedKeyboardInputs.has(inputId)) {
        this.activeKeyboardInputs.set(inputId, void 0)
      }

      result.renderStateChanged = false

      return result
    }

    if (!pressed && this.menuSuppressedKeyboardInputs.delete(inputId)) {
      if (trackInput) this.petBehavior.notifyKeyboardRelease(inputId)

      result.renderStateChanged = false

      return result
    }

    if (!pressed) {
      if (trackInput) this.petBehavior.notifyKeyboardRelease(inputId)

      if (!shouldReleaseRenderState) return result

      this.pressedSpriteBindings.delete(renderKey)
      if (this.pressedSpriteBindings.size === 0) {
        this.resumePressedBindingsAfterManualAction = false
      }
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

  public setKeyboardInputActive(inputId: string, active: boolean, recordActivity = true) {
    // 输入监听可先于模型按键映射建立；undefined 仍代表真实按住，必须阻止空闲宠物激活。
    if (active) {
      if (!this.activeKeyboardInputs.has(inputId)) {
        this.activeKeyboardInputs.set(inputId, void 0)
      }
    } else {
      this.activeKeyboardInputs.delete(inputId)
    }

    // 账本同步与真实用户操作可能共用此入口；recordActivity 明确控制是否生成被动触发信号。
    if (recordActivity) {
      this.petBehavior.notifyPassiveActivity({
        inputId,
        phase: active ? 'start' : 'end',
        source: inputId.startsWith('Gamepad:') ? 'gamepad' : 'keyboard',
      })
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
    this.petBehavior.notifyPassiveActivity({
      inputId: `Mouse:${button}`,
      phase: pressed ? 'start' : 'end',
      source: 'mouse',
    })

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

  public notifyPetPassiveActivity(signal: PetPassiveActivitySignal) {
    this.petBehavior.notifyPassiveActivity(signal)
  }

  public setPetPresenceVisible(visible: boolean) {
    this.petBehavior.setPresenceVisible(visible)
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

  public beginPetActionMenu(locale: string) {
    if (this.renderer !== 'sprite') return null

    // 原生菜单打开期间暂停被动定时器；revision 可让旧菜单回调在切模型后安全失效。
    return this.petBehavior.beginActionMenu(locale)
  }

  public getPetActionCatalog(locale: string) {
    if (this.renderer !== 'sprite') return null

    return this.petBehavior.getActionCatalog(locale)
  }

  public triggerPetActionCatalogItem(itemId: string) {
    if (this.renderer !== 'sprite') return false

    const accepted = this.petBehavior.triggerActionCatalogItem(itemId)

    return this.adoptExplicitPetAction(accepted)
  }

  public selectPetActionMenuAction(revision: number, itemId: string) {
    if (this.renderer !== 'sprite') return false

    return this.petBehavior.selectActionMenuItem(revision, itemId)
  }

  public endPetActionMenu(revision: number) {
    const accepted = this.petBehavior.endActionMenu(revision)

    return this.adoptExplicitPetAction(accepted)
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
    this.resumePressedBindingsAfterManualAction = false
    this.pressedSpriteBindings.clear()
    // 切模/销毁后旧菜单的 release 不应继续命中特殊分支，否则会污染新模型的输入账本。
    this.menuSuppressedKeyboardInputs.clear()
  }

  private adoptExplicitPetAction(accepted: boolean) {
    if (!accepted) return false

    ++this.petExitGeneration
    this.pendingSpriteBinding = void 0
    this.resumePressedBindingsAfterManualAction = this.pressedSpriteBindings.size > 0

    return true
  }

  private handlePetBehaviorStateChange(state: PetBehaviorState) {
    if (state !== 'work-idle' || !this.resumePressedBindingsAfterManualAction) return

    queueMicrotask(() => {
      if (!this.resumePressedBindingsAfterManualAction
        || this.renderer !== 'sprite'
        || this.petBehavior.state !== 'work-idle') {
        return
      }

      this.resumePressedBindingsAfterManualAction = false
      sprite.syncPressedKeyboardBindings([...this.pressedSpriteBindings])
      sprite.resumePressedInputBinding()
    })
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
    // 只有稳定的宠物态能接收指针；进出场过渡和正在交互时禁止重入，避免替换当前手势。
    return this.petBehavior.state === 'pet-idle'
      || this.petBehavior.state === 'pet-action'
  }
}

const modelRuntime = new ModelRuntime()

export default modelRuntime
