// 宠物行为只负责“何时进入/退出、选择哪个动作”，不直接依赖 Canvas、Tauri 或 Pinia。
// 渲染、时钟和随机数都从依赖注入，目的是让模型配置可扩展，同时把平台输入与动画实现隔离开。
export type PetBehaviorState
  = | 'work-idle'
    | 'pet-entering'
    | 'pet-idle'
    | 'pet-action'
    | 'pet-interaction'
    | 'pet-exiting'

export type PetInputStatus = 'unavailable' | 'starting' | 'ready'

export type PetInteractionEvent = 'hover' | 'tap' | 'stroke'

export interface PetPoint {
  x: number
  y: number
}

export interface PetRectHitArea {
  shape: 'rect'
  x: number
  y: number
  width: number
  height: number
}

export interface PetEllipseHitArea {
  shape: 'ellipse'
  centerX: number
  centerY: number
  radiusX: number
  radiusY: number
}

export interface PetPolygonHitArea {
  shape: 'polygon'
  points: PetPoint[]
}

export type PetHitArea = PetRectHitArea | PetEllipseHitArea | PetPolygonHitArea

export interface PetAutonomousActionConfig {
  id: string
  animation: string
  weight: number
  cooldownMs?: number
}

export interface PetAutonomousBehaviorConfig {
  delayMs: [number, number]
  actions: PetAutonomousActionConfig[]
}

interface PetInteractionBaseConfig {
  id: string
  area: string
  animation: string
  cooldownMs?: number
}

export interface PetHoverInteractionConfig extends PetInteractionBaseConfig {
  event: 'hover'
  holdMs?: number
  distance?: never
  windowMs?: never
}

export interface PetTapInteractionConfig extends PetInteractionBaseConfig {
  event: 'tap'
  holdMs?: number
  distance?: number
  windowMs?: number
}

export interface PetStrokeInteractionConfig extends PetInteractionBaseConfig {
  event: 'stroke'
  holdMs?: never
  distance?: number
  windowMs?: number
}

export type PetInteractionConfig
  = | PetHoverInteractionConfig
    | PetTapInteractionConfig
    | PetStrokeInteractionConfig

export interface PetBehaviorConfig {
  activationDelayMs: number
  enterAnimation: string
  idleAnimation: string
  exitAnimation: string
  autonomous?: PetAutonomousBehaviorConfig
  hitAreas?: Record<string, PetHitArea>
  interactions?: PetInteractionConfig[]
}

export type PetPlaybackEndReason = 'finished' | 'interrupted' | 'destroyed'

export interface PetPlaybackResult {
  reason: PetPlaybackEndReason
}

export interface PetPlaybackHandle {
  animation: string
  finished: Promise<PetPlaybackResult>
}

export interface PetPlayOptions {
  returnTo?: string
}

export interface PetPlaybackDriver {
  play: (animation: string, options?: PetPlayOptions) => PetPlaybackHandle | null
}

export type PetBehaviorTimer = ReturnType<typeof globalThis.setTimeout>

export interface PetBehaviorClock {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => PetBehaviorTimer
  clearTimeout: (timer: PetBehaviorTimer) => void
}

export interface PetBehaviorRuntimeContext {
  enabled: boolean
  visible: boolean
  rendererReady: boolean
  renderedVisible: boolean
  inputStatus: PetInputStatus
  mouseInteractions: boolean
  activationDelayMs?: number
}

export interface PetBehaviorDependencies {
  driver: PetPlaybackDriver
  clock?: PetBehaviorClock
  random?: () => number
  context?: Partial<PetBehaviorRuntimeContext>
  onStateChange?: (state: PetBehaviorState, previous: PetBehaviorState) => void
}

export interface PetInteractionInput {
  event: PetInteractionEvent
  area?: string
  point?: PetPoint
  holdMs?: number
  distance?: number
  elapsedMs?: number
}

export interface PetBehaviorValidationContext {
  animations: Record<string, { loop: boolean }>
  canvas: {
    width: number
    height: number
  }
}

interface ActivePlayback {
  generation: number
  handle: PetPlaybackHandle
}

const defaultClock: PetBehaviorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: timer => globalThis.clearTimeout(timer),
}

const defaultContext: PetBehaviorRuntimeContext = {
  enabled: true,
  visible: true,
  rendererReady: false,
  renderedVisible: false,
  inputStatus: 'unavailable',
  mouseInteractions: true,
}

export const PET_MAX_TAP_DISTANCE = 6
// 浏览器 setTimeout 超过 32 位有符号整数会溢出或被钳制，模型配置必须在入库前拒绝该值。
const PET_MAX_TIMER_DELAY = 2_147_483_647

export class PetBehaviorController {
  private behaviorConfig: PetBehaviorConfig | undefined
  private defaultAnimation: string | undefined
  private readonly driver: PetPlaybackDriver
  private readonly clock: PetBehaviorClock
  private readonly random: () => number
  private readonly onStateChange: PetBehaviorDependencies['onStateChange']
  private readonly context: PetBehaviorRuntimeContext
  private currentState: PetBehaviorState = 'work-idle'
  private activationTimer: PetBehaviorTimer | undefined
  private autonomousTimer: PetBehaviorTimer | undefined
  // lifecycleGeneration 作废旧定时器，playbackGeneration 作废旧动画回调；两者分开避免
  // 单纯切换动画时误伤当前生命周期，也避免 clearTimeout 竞争下的陈旧回调改状态。
  private lifecycleGeneration = 0
  private playbackGeneration = 0
  private started = false
  private destroyed = false
  private lastAutonomousAction: string | undefined
  private readonly cooldowns = new Map<string, number>()
  private readonly activeKeyboardInputs = new Set<string>()
  // 多个按键在退出动画期间可能同时到达，共享同一个 Promise 才不会重复播放退出动作。
  private exitingPromise: Promise<boolean> | null = null

  public constructor(config: PetBehaviorConfig | undefined, dependencies: PetBehaviorDependencies) {
    this.behaviorConfig = config
    this.driver = dependencies.driver
    this.clock = dependencies.clock ?? defaultClock
    this.random = dependencies.random ?? Math.random
    this.onStateChange = dependencies.onStateChange
    this.context = { ...defaultContext, ...dependencies.context }
  }

  public get state() {
    return this.currentState
  }

  public get config() {
    return this.behaviorConfig
  }

  public get hasConfig() {
    return this.behaviorConfig !== void 0
  }

  public get isPetActive() {
    return this.behaviorConfig !== void 0 && this.currentState !== 'work-idle'
  }

  public configure(config?: PetBehaviorConfig, defaultAnimation?: string) {
    if (this.destroyed) return

    this.invalidate()
    this.behaviorConfig = config
    this.defaultAnimation = defaultAnimation
    this.cooldowns.clear()
    this.activeKeyboardInputs.clear()
    this.lastAutonomousAction = void 0
    this.exitingPromise = null
    this.setState('work-idle')

    // 运行中切模型时沿用当前运行上下文，但必须从新的完整空闲周期重新计时。
    if (this.started && this.canRun()) this.scheduleActivation()
  }

  public start() {
    if (this.destroyed) return false

    this.started = true

    if (!this.canRun()) return false

    if (this.currentState === 'work-idle') this.scheduleActivation()

    return true
  }

  public stop() {
    if (this.destroyed) return

    const config = this.behaviorConfig
    const shouldRestore = this.currentState !== 'work-idle' && config

    this.started = false
    this.invalidate()
    this.activeKeyboardInputs.clear()
    this.exitingPromise = null

    if (shouldRestore) {
      // 窗口/画布已经不可见时不再播放退出过渡，直接恢复默认帧，避免下次显示停在半截宠物帧。
      if ((!this.context.visible
        || !this.context.rendererReady
        || !this.context.renderedVisible)
      && this.defaultAnimation) {
        this.driver.play(this.defaultAnimation, { returnTo: this.defaultAnimation })
      } else {
        this.driver.play(shouldRestore.exitAnimation, {
          returnTo: this.defaultAnimation,
        })
      }
    }

    this.setState('work-idle')
  }

  public destroy() {
    if (this.destroyed) return

    this.destroyed = true
    this.started = false
    this.invalidate()
    this.behaviorConfig = void 0
    this.defaultAnimation = void 0
    this.cooldowns.clear()
    this.activeKeyboardInputs.clear()
    this.exitingPromise = null
    this.setState('work-idle')
  }

  public updateContext(patch: Partial<PetBehaviorRuntimeContext>) {
    if (this.destroyed) return

    // 用属性存在性而不是值判断，调用方才能通过显式传入 undefined 清除持久化延时覆盖。
    const activationDelayChanged = 'activationDelayMs' in patch

    const wasOperational = this.canRun()
    const wasInPetMode = this.currentState !== 'work-idle'

    if (patch.enabled !== void 0) this.context.enabled = patch.enabled
    if (patch.visible !== void 0) this.context.visible = patch.visible
    if (patch.rendererReady !== void 0) this.context.rendererReady = patch.rendererReady
    if (patch.renderedVisible !== void 0) {
      this.context.renderedVisible = patch.renderedVisible
    }
    if (patch.inputStatus !== void 0) {
      this.context.inputStatus = patch.inputStatus

      // 监听中断后不保证还能收到 release；旧按压账本已不可信，恢复时由输入层重新同步。
      if (patch.inputStatus === 'unavailable') this.activeKeyboardInputs.clear()
    }
    if (patch.mouseInteractions !== void 0) {
      this.context.mouseInteractions = patch.mouseInteractions
    }
    if (activationDelayChanged) {
      this.context.activationDelayMs = isPositiveTimerDelay(patch.activationDelayMs)
        ? patch.activationDelayMs
        : void 0
    }

    const isOperational = this.canRun()

    if (!isOperational) {
      // enabled、真实可见性、渲染就绪和输入监听是同一运行闸门；任一失效都必须同时
      // 取消计时器和播放 continuation，不能只隐藏画面却让后台状态机继续推进。
      this.invalidate()
      this.exitingPromise = null

      if (wasInPetMode && this.behaviorConfig) {
        // 渲染不可用时不能依赖退出动画完成回调，直接落回默认动作最安全。
        if ((!this.context.visible
          || !this.context.rendererReady
          || !this.context.renderedVisible)
        && this.defaultAnimation) {
          this.driver.play(this.defaultAnimation, { returnTo: this.defaultAnimation })
        } else {
          this.driver.play(this.behaviorConfig.exitAnimation, {
            returnTo: this.defaultAnimation,
          })
        }
      }

      this.setState('work-idle')

      return
    }

    if (!wasOperational || activationDelayChanged) {
      if (this.currentState === 'work-idle') this.scheduleActivation()
    }
  }

  public syncActiveKeyboardInputs(inputs: Iterable<string>) {
    if (this.destroyed) return

    const nextInputs = new Set(inputs)

    if (nextInputs.size === this.activeKeyboardInputs.size
      && [...nextInputs].every(key => this.activeKeyboardInputs.has(key))) {
      return
    }

    const hadActiveInputs = this.activeKeyboardInputs.size > 0

    this.activeKeyboardInputs.clear()

    for (const key of nextInputs) this.activeKeyboardInputs.add(key)

    if (this.activeKeyboardInputs.size > 0) {
      // 按住任何物理输入都算工作态，即使当前模型没有对应动画绑定。
      this.clearActivationTimer()

      if (this.currentState !== 'work-idle' && this.canRunWithoutKeyboardInput()) {
        void this.exitForInput()
      }

      return
    }

    if (hadActiveInputs && this.currentState === 'work-idle' && this.canRun()) {
      // 只有最后一个输入释放后才重新开始完整空闲计时，避免从旧计时进度提前激活。
      this.scheduleActivation()
    }
  }

  public notifyKeyboardPress(key: string) {
    if (this.destroyed) return false

    const isFirstPress = !this.activeKeyboardInputs.has(key)

    if (isFirstPress) {
      this.activeKeyboardInputs.add(key)

      if (this.activeKeyboardInputs.size === 1) this.clearActivationTimer()
    }

    if (!this.behaviorConfig || !this.started || !this.canRunWithoutKeyboardInput()) return false

    if (this.currentState === 'work-idle') return false

    // key repeat 不重复触发退出；第一个物理 down 已经负责把宠物切回工作态。
    if (isFirstPress) void this.exitForInput()

    return true
  }

  public notifyKeyboardRelease(key: string) {
    if (this.destroyed || !this.activeKeyboardInputs.delete(key)) return false

    if (this.activeKeyboardInputs.size > 0
      || this.currentState !== 'work-idle'
      || !this.canRun()) {
      return false
    }

    this.scheduleActivation()

    return true
  }

  public exitForInput(): Promise<boolean> {
    if (!this.behaviorConfig || !this.started || this.destroyed) {
      return Promise.resolve(false)
    }

    if (this.currentState === 'work-idle') {
      if (this.canRun()) this.scheduleActivation()

      return Promise.resolve(false)
    }

    if (this.exitingPromise) return this.exitingPromise

    this.clearTimers()
    this.setState('pet-exiting')

    const playback = this.beginPlayback(
      this.behaviorConfig.exitAnimation,
      this.defaultAnimation,
    )

    if (!playback) {
      this.setState('work-idle')
      if (this.canRun()) this.scheduleActivation()

      return Promise.resolve(false)
    }

    const promise = playback.handle.finished.then((result) => {
      // 新模型/新播放已推进 generation 时，本次完成只能结算 Promise，不能覆盖新状态。
      if (!this.isPlaybackCurrent(playback)) return false

      this.exitingPromise = null
      this.setState('work-idle')

      if (this.canRun()) this.scheduleActivation()

      return result.reason === 'finished'
    }, () => {
      if (!this.isPlaybackCurrent(playback)) return false

      this.exitingPromise = null
      this.setState('work-idle')

      if (this.canRun()) this.scheduleActivation()

      return false
    })

    this.exitingPromise = promise

    return promise
  }

  public dispatchInteraction(input: PetInteractionInput) {
    const config = this.behaviorConfig

    if (!config || !this.canRun() || !this.context.mouseInteractions) return false
    // 过渡动画和既有交互动作不可重入；否则一次移动会不断打断并重启动画首帧。
    if (this.currentState === 'work-idle'
      || this.currentState === 'pet-entering'
      || this.currentState === 'pet-exiting'
      || this.currentState === 'pet-interaction') {
      return false
    }

    const interaction = this.resolveInteraction(input)

    if (!interaction) return false
    if (interaction.holdMs !== void 0 && (input.holdMs ?? 0) < interaction.holdMs) return false
    if (interaction.distance !== void 0) {
      const distance = input.distance

      if (distance === void 0) return false
      if (interaction.event === 'tap' && distance > interaction.distance) return false
      if (interaction.event === 'stroke' && distance < interaction.distance) return false
    }
    if (interaction.windowMs !== void 0
      && (input.elapsedMs === void 0 || input.elapsedMs > interaction.windowMs)) {
      return false
    }

    const now = this.clock.now()
    const lastPlayedAt = this.cooldowns.get(interaction.id)

    if (lastPlayedAt !== void 0
      && now - lastPlayedAt < (interaction.cooldownMs ?? 0)) {
      return false
    }

    this.clearAutonomousTimer()
    // 冷却在播放前写入，防止同一帧的多个重叠命中区绕过限制并发触发。
    this.cooldowns.set(interaction.id, now)
    this.setState('pet-interaction')

    const playback = this.beginPlayback(interaction.animation, config.idleAnimation)

    if (!playback) {
      this.setState('pet-idle')
      this.scheduleAutonomousAction()

      return false
    }

    this.finishPetPlayback(playback)

    return true
  }

  public resolveInteraction(input: PetInteractionInput) {
    const areas = input.area
      ? [input.area]
      : input.point
        ? this.hitTest(input.point)
        : []

    return this.behaviorConfig?.interactions?.find((candidate) => {
      return candidate.event === input.event && areas.includes(candidate.area)
    })
  }

  public hitTest(point: PetPoint) {
    const areas = this.behaviorConfig?.hitAreas

    if (!areas || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return []

    return Object.entries(areas)
      .filter(([, area]) => isPointInHitArea(point, area))
      .map(([id]) => id)
  }

  private canRun() {
    // 输入集合是独立闸门：没有动画绑定的键也必须阻止宠物把用户误判为空闲。
    return this.canRunWithoutKeyboardInput() && this.activeKeyboardInputs.size === 0
  }

  private canRunWithoutKeyboardInput() {
    // visible 是业务设置，renderedVisible 是 DOM/窗口实际展示结果；两者都成立才允许计时。
    return Boolean(
      this.behaviorConfig
      && this.started
      && this.context.enabled
      && this.context.visible
      && this.context.rendererReady
      && this.context.renderedVisible
      && this.context.inputStatus === 'ready',
    )
  }

  private scheduleActivation() {
    const config = this.behaviorConfig

    this.clearActivationTimer()

    if (!config || !this.canRun() || this.currentState !== 'work-idle') return

    const generation = this.lifecycleGeneration
    const delay = this.context.activationDelayMs ?? config.activationDelayMs
    const timer = this.clock.setTimeout(() => {
      // 同时核对 timer 身份和 generation，覆盖“计时器已触发排队后才被取消”的竞态。
      if (this.activationTimer !== timer || generation !== this.lifecycleGeneration) return

      this.activationTimer = void 0
      this.enterPetMode()
    }, delay)

    this.activationTimer = timer
  }

  private enterPetMode() {
    const config = this.behaviorConfig

    if (!config || !this.canRun() || this.currentState !== 'work-idle') return

    this.setState('pet-entering')

    const playback = this.beginPlayback(config.enterAnimation, config.idleAnimation)

    if (!playback) {
      this.setState('work-idle')
      this.scheduleActivation()

      return
    }

    void playback.handle.finished.then((result) => {
      if (!this.isPlaybackCurrent(playback)) return

      if (result.reason !== 'finished' || !this.canRun()) {
        this.setState('work-idle')
        if (this.canRun()) this.scheduleActivation()

        return
      }

      this.setState('pet-idle')
      this.scheduleAutonomousAction()
    }, () => {
      if (!this.isPlaybackCurrent(playback)) return

      this.setState('work-idle')
      if (this.canRun()) this.scheduleActivation()
    })
  }

  private scheduleAutonomousAction() {
    const autonomous = this.behaviorConfig?.autonomous

    this.clearAutonomousTimer()

    if (!autonomous || !this.canRun() || this.currentState !== 'pet-idle') return

    const generation = this.lifecycleGeneration
    const [minimum, maximum] = autonomous.delayMs
    const delay = minimum + (maximum - minimum) * this.nextRandom()
    const timer = this.clock.setTimeout(() => {
      // 配置、可见性或状态在等待期间变化时，旧随机动作不得落到新的生命周期。
      if (this.autonomousTimer !== timer || generation !== this.lifecycleGeneration) return

      this.autonomousTimer = void 0
      this.playAutonomousAction()
    }, delay)

    this.autonomousTimer = timer
  }

  private playAutonomousAction() {
    const config = this.behaviorConfig
    const autonomous = config?.autonomous

    if (!config || !autonomous || !this.canRun() || this.currentState !== 'pet-idle') return

    const now = this.clock.now()
    let eligible = autonomous.actions.filter((action) => {
      const lastPlayedAt = this.cooldowns.get(action.id)

      return lastPlayedAt === void 0 || now - lastPlayedAt >= (action.cooldownMs ?? 0)
    })

    if (eligible.length > 1 && this.lastAutonomousAction) {
      // 有替代项时避免连续选择同一动作，让有限雪碧动作看起来不机械；仅一项时仍允许重播。
      eligible = eligible.filter(action => action.id !== this.lastAutonomousAction)
    }

    if (eligible.length === 0) {
      this.scheduleAutonomousAction()

      return
    }

    const totalWeight = eligible.reduce((total, action) => total + action.weight, 0)
    let cursor = this.nextRandom() * totalWeight
    let selected = eligible[eligible.length - 1]

    for (const action of eligible) {
      // 使用累计权重而非数组下标随机，模型作者可以稳定调节动作出现频率。
      cursor -= action.weight

      if (cursor < 0) {
        selected = action

        break
      }
    }

    this.cooldowns.set(selected.id, now)
    this.lastAutonomousAction = selected.id
    this.setState('pet-action')

    const playback = this.beginPlayback(selected.animation, config.idleAnimation)

    if (!playback) {
      this.setState('pet-idle')
      this.scheduleAutonomousAction()

      return
    }

    this.finishPetPlayback(playback)
  }

  private finishPetPlayback(playback: ActivePlayback) {
    void playback.handle.finished.then((result) => {
      // 被按键、交互或模型切换打断的动作不能回到 pet-idle，否则会和工作动画争夺画面。
      if (!this.isPlaybackCurrent(playback)) return

      if (result.reason !== 'finished' || !this.canRun()) {
        this.setState('work-idle')
        if (this.canRun()) this.scheduleActivation()

        return
      }

      this.setState('pet-idle')
      this.scheduleAutonomousAction()
    }, () => {
      if (!this.isPlaybackCurrent(playback)) return

      this.setState('work-idle')
      if (this.canRun()) this.scheduleActivation()
    })
  }

  private beginPlayback(animation: string, returnTo?: string): ActivePlayback | null {
    // 每次播放先推进代次，因此旧 finished 即使晚到也无法驱动当前状态机。
    const generation = ++this.playbackGeneration
    const handle = this.driver.play(animation, { returnTo })

    if (!handle) return null

    return { generation, handle }
  }

  private isPlaybackCurrent(playback: ActivePlayback) {
    return playback.generation === this.playbackGeneration && !this.destroyed
  }

  private nextRandom() {
    const value = this.random()

    // 自定义随机源也可能返回异常值；钳制到 [0, 1) 可避免权重游标越界。
    if (!Number.isFinite(value)) return 0

    return Math.min(Math.max(value, 0), 1 - Number.EPSILON)
  }

  private setState(state: PetBehaviorState) {
    if (state === this.currentState) return

    const previous = this.currentState

    this.currentState = state
    this.onStateChange?.(state, previous)
  }

  private invalidate() {
    // clearTimeout 不能保证撤回已进入任务队列的回调，generation 才是最终的失效凭证。
    this.lifecycleGeneration++
    this.playbackGeneration++
    this.clearTimers()
  }

  private clearTimers() {
    this.clearActivationTimer()
    this.clearAutonomousTimer()
  }

  private clearActivationTimer() {
    if (this.activationTimer === void 0) return

    this.clock.clearTimeout(this.activationTimer)
    this.activationTimer = void 0
  }

  private clearAutonomousTimer() {
    if (this.autonomousTimer === void 0) return

    this.clock.clearTimeout(this.autonomousTimer)
    this.autonomousTimer = void 0
  }
}

export function assertPetBehaviorConfig(
  value: unknown,
  context: PetBehaviorValidationContext,
): asserts value is PetBehaviorConfig | undefined {
  if (value === void 0) return

  // 行为配置来自模型文件，必须在资源加载阶段一次性拒绝无效引用；运行中静默跳过会让
  // 状态机停在过渡态，并把问题伪装成偶发的鼠标/键盘失灵。
  assertRecord(value, 'Pet behavior')
  assertPositiveTimerDelay(value.activationDelayMs, 'Pet behavior activationDelayMs')
  assertNonEmptyString(value.enterAnimation, 'Pet behavior enterAnimation')
  assertNonEmptyString(value.idleAnimation, 'Pet behavior idleAnimation')
  assertNonEmptyString(value.exitAnimation, 'Pet behavior exitAnimation')
  assertAnimation(value.enterAnimation, false, context, 'Pet behavior enterAnimation')
  // idle 必须循环，进入/退出和动作必须结束，控制器才能可靠收到完成信号推进状态。
  assertAnimation(value.idleAnimation, true, context, 'Pet behavior idleAnimation')
  assertAnimation(value.exitAnimation, false, context, 'Pet behavior exitAnimation')

  // 自主动作和交互共用 cooldown Map，ID 也必须共用一个命名空间，避免互相覆盖冷却时间。
  const ids = new Set<string>()

  if (value.autonomous !== void 0) {
    assertRecord(value.autonomous, 'Pet behavior autonomous')

    const { actions, delayMs } = value.autonomous

    if (!Array.isArray(delayMs) || delayMs.length !== 2) {
      throw new TypeError('Pet behavior autonomous.delayMs must contain exactly two values')
    }

    assertPositiveTimerDelay(delayMs[0], 'Pet behavior autonomous.delayMs[0]')
    assertPositiveTimerDelay(delayMs[1], 'Pet behavior autonomous.delayMs[1]')

    if (delayMs[0] > delayMs[1]) {
      throw new RangeError('Pet behavior autonomous.delayMs minimum cannot exceed maximum')
    }

    if (!Array.isArray(actions) || actions.length === 0) {
      throw new TypeError('Pet behavior autonomous.actions must be a non-empty array')
    }

    for (const [index, action] of actions.entries()) {
      const label = `Pet behavior autonomous.actions[${index}]`

      assertRecord(action, label)
      assertUniqueId(action.id, ids, `${label}.id`)
      assertNonEmptyString(action.animation, `${label}.animation`)
      assertAnimation(action.animation, false, context, `${label}.animation`)
      assertPositiveNumber(action.weight, `${label}.weight`)

      if (action.cooldownMs !== void 0) {
        assertNonNegativeTimerDelay(action.cooldownMs, `${label}.cooldownMs`)
      }
    }

    const totalWeight = actions.reduce((total, action) => total + action.weight, 0)

    // 单项权重虽都有限，加总仍可能溢出；无限总权重会破坏累计权重选择。
    if (!Number.isFinite(totalWeight)) {
      throw new RangeError('Pet behavior autonomous action weights total must be finite')
    }
  }

  const hitAreaIds = new Set<string>()

  if (value.hitAreas !== void 0) {
    assertRecord(value.hitAreas, 'Pet behavior hitAreas')

    for (const [id, area] of Object.entries(value.hitAreas)) {
      assertNonEmptyString(id, 'Pet behavior hit area id')
      hitAreaIds.add(id)
      assertHitArea(area, context.canvas, `Pet behavior hitAreas.${id}`)
    }
  }

  if (value.interactions !== void 0) {
    if (!Array.isArray(value.interactions)) {
      throw new TypeError('Pet behavior interactions must be an array')
    }

    const semanticBindings = new Set<string>()

    for (const [index, interaction] of value.interactions.entries()) {
      const label = `Pet behavior interactions[${index}]`

      assertRecord(interaction, label)
      assertUniqueId(interaction.id, ids, `${label}.id`)

      if (interaction.event !== 'hover'
        && interaction.event !== 'tap'
        && interaction.event !== 'stroke') {
        throw new TypeError(`${label}.event must be hover, tap, or stroke`)
      }

      assertNonEmptyString(interaction.area, `${label}.area`)

      if (!hitAreaIds.has(interaction.area)) {
        throw new TypeError(`${label}.area references an unknown hit area`)
      }

      const semanticBinding = `${interaction.event}:${interaction.area}`

      // 同一区域同一事件只允许一个动作，避免配置顺序悄悄决定实际行为。
      if (semanticBindings.has(semanticBinding)) {
        throw new TypeError(`${label} duplicates the ${semanticBinding} interaction`)
      }

      semanticBindings.add(semanticBinding)
      assertNonEmptyString(interaction.animation, `${label}.animation`)
      assertAnimation(interaction.animation, false, context, `${label}.animation`)

      if (interaction.cooldownMs !== void 0) {
        assertNonNegativeTimerDelay(interaction.cooldownMs, `${label}.cooldownMs`)
      }

      if (interaction.event === 'hover') {
        assertUnsupportedInteractionField(interaction, 'distance', label)
        assertUnsupportedInteractionField(interaction, 'windowMs', label)

        if (interaction.holdMs !== void 0) {
          assertPositiveTimerDelay(interaction.holdMs, `${label}.holdMs`)
        }
      } else if (interaction.event === 'tap') {
        if (interaction.holdMs !== void 0) {
          assertPositiveTimerDelay(interaction.holdMs, `${label}.holdMs`)
        }
        if (interaction.distance !== void 0) {
          assertPositiveNumber(interaction.distance, `${label}.distance`)

          // 轻点判定的全局手势阈值是硬上限，模型不能把明显拖动重新定义成 tap。
          if (interaction.distance > PET_MAX_TAP_DISTANCE) {
            throw new RangeError(`${label}.distance cannot exceed ${PET_MAX_TAP_DISTANCE}`)
          }
        }
        if (interaction.windowMs !== void 0) {
          assertPositiveTimerDelay(interaction.windowMs, `${label}.windowMs`)
        }
        if (interaction.holdMs !== void 0
          && interaction.windowMs !== void 0
          && interaction.holdMs >= interaction.windowMs) {
          throw new RangeError(`${label}.holdMs must be less than windowMs`)
        }
      } else {
        assertUnsupportedInteractionField(interaction, 'holdMs', label)

        if (interaction.distance !== void 0) {
          assertPositiveNumber(interaction.distance, `${label}.distance`)
        }
        if (interaction.windowMs !== void 0) {
          assertPositiveTimerDelay(interaction.windowMs, `${label}.windowMs`)
        }
      }
    }
  }
}

function assertUnsupportedInteractionField(
  interaction: Record<string, unknown>,
  field: 'holdMs' | 'distance' | 'windowMs',
  label: string,
) {
  if (interaction[field] !== void 0) {
    throw new TypeError(`${label}.${field} is not supported for ${String(interaction.event)}`)
  }
}

function assertHitArea(value: unknown, canvas: { width: number, height: number }, label: string) {
  assertRecord(value, label)

  if (value.shape === 'rect') {
    assertNonNegativeNumber(value.x, `${label}.x`)
    assertNonNegativeNumber(value.y, `${label}.y`)
    assertPositiveNumber(value.width, `${label}.width`)
    assertPositiveNumber(value.height, `${label}.height`)

    if (value.x + value.width > canvas.width || value.y + value.height > canvas.height) {
      throw new RangeError(`${label} exceeds the model canvas`)
    }

    return
  }

  if (value.shape === 'ellipse') {
    assertNonNegativeNumber(value.centerX, `${label}.centerX`)
    assertNonNegativeNumber(value.centerY, `${label}.centerY`)
    assertPositiveNumber(value.radiusX, `${label}.radiusX`)
    assertPositiveNumber(value.radiusY, `${label}.radiusY`)

    if (value.centerX - value.radiusX < 0
      || value.centerX + value.radiusX > canvas.width
      || value.centerY - value.radiusY < 0
      || value.centerY + value.radiusY > canvas.height) {
      throw new RangeError(`${label} exceeds the model canvas`)
    }

    return
  }

  if (value.shape === 'polygon') {
    if (!Array.isArray(value.points) || value.points.length < 3) {
      throw new TypeError(`${label}.points must contain at least three points`)
    }

    const points: PetPoint[] = []
    const uniquePoints = new Set<string>()

    for (const [index, point] of value.points.entries()) {
      const pointLabel = `${label}.points[${index}]`

      assertRecord(point, pointLabel)
      assertNonNegativeNumber(point.x, `${pointLabel}.x`)
      assertNonNegativeNumber(point.y, `${pointLabel}.y`)

      if (point.x > canvas.width || point.y > canvas.height) {
        throw new RangeError(`${pointLabel} exceeds the model canvas`)
      }

      const signature = `${point.x}\0${point.y}`

      if (uniquePoints.has(signature)) {
        throw new TypeError(`${label}.points cannot contain duplicate points`)
      }

      uniquePoints.add(signature)
      points.push({ x: point.x, y: point.y })
    }

    const twiceArea = points.reduce((area, point, index) => {
      const nextPoint = points[(index + 1) % points.length]

      return area + point.x * nextPoint.y - nextPoint.x * point.y
    }, 0)

    if (twiceArea === 0) {
      // 三个以上共线点仍不是可命中的多边形，必须显式拒绝退化区域。
      throw new TypeError(`${label}.points must form a non-zero-area polygon`)
    }

    return
  }

  throw new TypeError(`${label}.shape must be rect, ellipse, or polygon`)
}

function assertAnimation(
  name: string,
  loop: boolean,
  context: PetBehaviorValidationContext,
  label: string,
) {
  // 不使用普通属性读取，防止模型键名命中 Object.prototype 而被误判成真实动画。
  const animation = Object.prototype.hasOwnProperty.call(context.animations, name)
    ? context.animations[name]
    : void 0

  if (!animation) throw new TypeError(`${label} references an unknown animation`)
  if (animation.loop !== loop) {
    throw new TypeError(`${label} must reference a ${loop ? 'looping' : 'non-looping'} animation`)
  }
}

function assertUniqueId(value: unknown, ids: Set<string>, label: string) {
  assertNonEmptyString(value, label)

  if (ids.has(value)) throw new TypeError(`${label} must be unique`)

  ids.add(value)
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertPositiveNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`)
  }
}

function isPositiveTimerDelay(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 1
    && value <= PET_MAX_TIMER_DELAY
}

function assertPositiveTimerDelay(value: unknown, label: string): asserts value is number {
  if (!isPositiveTimerDelay(value)) {
    throw new TypeError(`${label} must be between 1 and ${PET_MAX_TIMER_DELAY}`)
  }
}

function assertNonNegativeTimerDelay(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > PET_MAX_TIMER_DELAY) {
    throw new TypeError(`${label} must be between 0 and ${PET_MAX_TIMER_DELAY}`)
  }
}

function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number`)
  }
}

function isPointInHitArea(point: PetPoint, area: PetHitArea) {
  if (area.shape === 'rect') {
    return point.x >= area.x
      && point.x <= area.x + area.width
      && point.y >= area.y
      && point.y <= area.y + area.height
  }

  if (area.shape === 'ellipse') {
    const normalizedX = (point.x - area.centerX) / area.radiusX
    const normalizedY = (point.y - area.centerY) / area.radiusY

    return normalizedX ** 2 + normalizedY ** 2 <= 1
  }

  let inside = false

  // 射线奇偶规则同时支持凹多边形，模型作者不必把复杂角色区域拆成多个矩形。
  for (let index = 0, previous = area.points.length - 1; index < area.points.length; previous = index++) {
    const currentPoint = area.points[index]
    const previousPoint = area.points[previous]
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < (previousPoint.x - currentPoint.x)
      * (point.y - currentPoint.y)
      / (previousPoint.y - currentPoint.y)
      + currentPoint.x

    if (crosses) inside = !inside
  }

  return inside
}
