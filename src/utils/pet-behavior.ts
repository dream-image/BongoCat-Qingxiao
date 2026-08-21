import type {
  PetBehaviorRuntimeModule,
  PetLocalizedText,
  PetRuntimeAction,
  PetRuntimeIdleTrigger,
  PetRuntimeIntervalTrigger,
  PetRuntimeManualTrigger,
  PetRuntimePointerTrigger,
  PetRuntimeScheduleTrigger,
  PetRuntimeTrigger,
} from './pet-behavior-module'
import type {
  PetPassiveActivitySignal,
  PetPassiveOccurrence,
} from './pet-behavior-passive'

import { resolvePetLocalizedText } from './pet-behavior-module'
import { PetPassiveTriggerEngine } from './pet-behavior-passive'
import {
  delayUntilNextScheduleScan,
  findDuePetScheduleOccurrence,
  PET_MAX_SCHEDULE_CATCH_UP_MS,
} from './pet-behavior-scheduler'

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
  modules?: PetBehaviorRuntimeModule[]
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
  speak?: (payload: PetSpeechPayload) => void
  clearSpeech?: () => void
}

export interface PetSpeechPayload {
  text: string
  durationMs: number
  anchor?: {
    x: number
    y: number
  }
}

export type PetActionSource
  = | 'manual'
    | 'pointer'
    | 'active-session'
    | 'schedule'
    | 'visibility-return'
    | 'session'
    | 'activity-burst'
    | 'daily-window'
    | 'idle'
    | 'interval'

export interface PetManualActionView {
  id: string
  label: string
  group: string
  order: number
  enabled: boolean
}

export interface PetActionMenuView {
  revision: number
  groups: Array<{
    label: string
    actions: PetManualActionView[]
  }>
}

export type PetBehaviorTimer = ReturnType<typeof globalThis.setTimeout>

export interface PetBehaviorClock {
  // now 是单调时间，负责延时/冷却；wallNow 只负责本地日历日程，避免系统回拨锁死动作。
  now: () => number
  wallNow?: () => number
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
  locale: string
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

interface PetActionRequest {
  action: PetRuntimeAction
  source: PetActionSource
  priority: number
  enterPet: boolean
}

interface ActivePetAction {
  actionId: string
  priority: number
  interruptible: boolean
}

interface QueuedPassiveOccurrence extends Omit<PetPassiveOccurrence, 'source'> {
  source: PetActionSource
}

const defaultClock: PetBehaviorClock = {
  now: () => typeof performance === 'undefined' ? Date.now() : performance.now(),
  wallNow: () => Date.now(),
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
  locale: typeof navigator === 'undefined' ? 'en-US' : navigator.language,
}

export const PET_MAX_TAP_DISTANCE = 6
// 浏览器 setTimeout 超过 32 位有符号整数会溢出或被钳制，模型配置必须在入库前拒绝该值。
const PET_MAX_TIMER_DELAY = 2_147_483_647
// 运行时还可能接收缓存或程序直接组装的 normalized config，因此这里必须与 module loader
// 保持同一预算，不能把资源上限只押在文件加载入口上。
const PET_MAX_MODULES = 64
const PET_MAX_MODULE_ACTIONS = 128
const PET_MAX_MODULE_TRIGGERS = 256
const PET_MAX_TOTAL_MODULE_ACTIONS = 512
const PET_MAX_TOTAL_MODULE_TRIGGERS = 256
const PET_MIN_TIMER_DRIVEN_CATCH_UP_MS = 1_000
const PET_MAX_PENDING_PASSIVE_OCCURRENCES = 256
const PET_MAX_DIALOGUE_LINES = 32
const PET_MAX_LOCALIZED_VARIANTS = 16
const PET_MAX_ID_LENGTH = 80
const PET_MAX_TEXT_LENGTH = 240
// 内部合成模组使用外部 safe-id 永远无法表达的前缀，从根上避免导入模块覆盖兼容配置。
const PET_LEGACY_MODULE_ID = '@legacy'
const PET_SAFE_ID_PATTERN = /^[\da-z][\w.-]*$/
const PET_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i
const PET_RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor'])

export class PetBehaviorController {
  private behaviorConfig: PetBehaviorConfig | undefined
  private defaultAnimation: string | undefined
  private readonly driver: PetPlaybackDriver
  private readonly clock: PetBehaviorClock
  private readonly random: () => number
  private readonly passiveEngine: PetPassiveTriggerEngine
  private readonly onStateChange: PetBehaviorDependencies['onStateChange']
  private readonly context: PetBehaviorRuntimeContext
  private currentState: PetBehaviorState = 'work-idle'
  private activationTimer: PetBehaviorTimer | undefined
  private activationNextAt: number | undefined
  private pausedActivationRemainingMs: number | undefined
  private readonly intervalTimers = new Map<string, PetBehaviorTimer>()
  private readonly intervalNextAt = new Map<string, number>()
  private readonly idleTimers = new Map<string, PetBehaviorTimer>()
  private scheduleTimer: PetBehaviorTimer | undefined
  private speechDelayTimer: PetBehaviorTimer | undefined
  private speechClearTimer: PetBehaviorTimer | undefined
  private dialogueOnlyTimer: PetBehaviorTimer | undefined
  // lifecycleGeneration 作废旧定时器，playbackGeneration 作废旧动画回调；两者分开避免
  // 单纯切换动画时误伤当前生命周期，也避免 clearTimeout 竞争下的陈旧回调改状态。
  private lifecycleGeneration = 0
  private playbackGeneration = 0
  private started = false
  private destroyed = false
  private readonly cooldowns = new Map<string, number>()
  private readonly activeKeyboardInputs = new Set<string>()
  private readonly modules = new Map<string, PetBehaviorRuntimeModule>()
  private readonly moduleActions = new Map<string, PetRuntimeAction>()
  private moduleTriggers: PetRuntimeTrigger[] = []
  private moduleScopeId = 'default'
  private readonly consumedScheduleOccurrences = new Map<string, number>()
  // 被动 occurrence 一旦被观察到就进入独立队列；不能借用单槽 pendingAction，
  // 否则多个模块的同批日程、回归和工作提醒会互相覆盖。
  private pendingPassiveOccurrences: QueuedPassiveOccurrence[] = []
  private passiveOccurrenceSequence = 0
  private readonly consumedIdleTriggers = new Set<string>()
  private readonly idleNextAt = new Map<string, number>()
  private readonly lastIntervalAction = new Map<string, string>()
  private idleEpoch = 0
  private activePetAction: ActivePetAction | undefined
  private pendingAction: PetActionRequest | undefined
  private catalogRevision = 0
  private menuPaused = false
  private menuPausedAt: number | undefined
  private selectedMenuAction: string | undefined
  // 多个按键在退出动画期间可能同时到达，共享同一个 Promise 才不会重复播放退出动作。
  private exitingPromise: Promise<boolean> | null = null

  public constructor(config: PetBehaviorConfig | undefined, dependencies: PetBehaviorDependencies) {
    this.behaviorConfig = config
    this.driver = dependencies.driver
    this.clock = dependencies.clock ?? defaultClock
    this.random = dependencies.random ?? Math.random
    this.onStateChange = dependencies.onStateChange
    this.context = { ...defaultContext, ...dependencies.context }
    this.passiveEngine = new PetPassiveTriggerEngine({
      clock: this.clock,
      random: () => this.nextRandom(),
      onOccurrence: occurrence => this.enqueuePassiveOccurrence(occurrence),
    })
    this.rebuildModuleCatalog()
    this.resetIdleEpoch()
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

  public get isActionMenuOpen() {
    return this.menuPaused
  }

  public configure(config?: PetBehaviorConfig, defaultAnimation?: string, scopeId = 'default') {
    if (this.destroyed) return

    this.invalidate()
    this.behaviorConfig = config
    this.defaultAnimation = defaultAnimation
    this.moduleScopeId = scopeId
    this.cooldowns.clear()
    this.activeKeyboardInputs.clear()
    this.rebuildModuleCatalog()
    this.consumedScheduleOccurrences.clear()
    this.resetIdleEpoch()
    this.activePetAction = void 0
    this.pendingAction = void 0
    this.pendingPassiveOccurrences = []
    this.invalidateActionMenu()
    this.exitingPromise = null
    this.setState('work-idle')

    // 运行中切模型时沿用当前运行上下文，但必须从新的完整空闲周期重新计时。
    if (this.started && this.canRun()) this.scheduleOperationalTimers()
  }

  public start() {
    if (this.destroyed) return false

    this.started = true
    this.resetIdleEpoch()

    if (!this.canRun()) return false

    this.scheduleOperationalTimers()

    return true
  }

  public stop() {
    if (this.destroyed) return

    const config = this.behaviorConfig
    const shouldRestore = this.currentState !== 'work-idle' && config

    this.started = false
    this.passiveEngine.setOperational(false)
    this.invalidate()
    this.activeKeyboardInputs.clear()
    this.activePetAction = void 0
    this.pendingAction = void 0
    this.pendingPassiveOccurrences = []
    this.invalidateActionMenu()
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
    this.passiveEngine.destroy()
    this.invalidate()
    this.behaviorConfig = void 0
    this.defaultAnimation = void 0
    this.cooldowns.clear()
    this.activeKeyboardInputs.clear()
    this.modules.clear()
    this.moduleActions.clear()
    this.moduleTriggers = []
    this.activePetAction = void 0
    this.pendingAction = void 0
    this.pendingPassiveOccurrences = []
    this.invalidateActionMenu()
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
      if (patch.inputStatus === 'unavailable') {
        this.activeKeyboardInputs.clear()
        this.passiveEngine.resetUntrustedInput()
      }
    }
    if (patch.mouseInteractions !== void 0) {
      this.context.mouseInteractions = patch.mouseInteractions
    }
    if (patch.locale !== void 0 && patch.locale.trim()) {
      this.context.locale = patch.locale
    }
    if (activationDelayChanged) {
      this.context.activationDelayMs = isPositiveTimerDelay(patch.activationDelayMs)
        ? patch.activationDelayMs
        : void 0
    }

    const isOperational = this.canRun()

    if (!isOperational) {
      this.passiveEngine.setOperational(false)
      // enabled、真实可见性、渲染就绪和输入监听是同一运行闸门；任一失效都必须同时
      // 取消计时器和播放 continuation，不能只隐藏画面却让后台状态机继续推进。
      this.invalidate()
      this.exitingPromise = null
      this.activePetAction = void 0
      this.pendingAction = void 0
      this.pendingPassiveOccurrences = []
      this.invalidateActionMenu()
      this.resetIdleEpoch()

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
      // 不可运行期间经过了多久不能算“无人操作”；恢复门禁时从完整空闲周期重新计时。
      if (!wasOperational) this.resetIdleEpoch()
      this.scheduleOperationalTimers()
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

    // 切模型和监听恢复只同步真实按压，不把重映射误计为一次新的用户活动。
    this.passiveEngine.syncActiveInputs([...nextInputs].map(inputId => ({
      inputId,
      source: getPassiveActivitySource(inputId),
    })))

    // 手柄/摇杆也能在原生菜单打开时改变共享输入账本；此时只同步 held 真相，不能像模型输入
    // 那样作废 revision 或退出宠物态，否则 popup 仍显示但其中所有 action 已经失效。
    if (this.menuPaused) return

    if (this.activeKeyboardInputs.size > 0) {
      // 按住任何物理输入都算工作态，即使当前模型没有对应动画绑定。
      this.clearOperationalTimers()
      this.resetIdleEpoch()
      this.pendingAction = void 0
      this.pendingPassiveOccurrences = []
      this.invalidateActionMenu()
      this.clearSpeech()

      if (this.currentState !== 'work-idle' && this.canRunWithoutKeyboardInput()) {
        void this.exitForInput()
      }

      return
    }

    if (hadActiveInputs && this.canRun() && !this.passiveEngine.hasActiveInputs) {
      // 最后一个输入释放时先消费已观测到的事件；否则它不会被已消费的 trigger 再次唤醒。
      if (this.resumePendingActionFromWorkIdle()) return
      if (this.startNextPassiveOccurrence()) {
        // 菜单在 gamepad held 时关闭会把引擎置为 non-operational；动作已启动后仍需显式恢复观察。
        this.scheduleOperationalTimers()

        return
      }

      if (this.currentState === 'work-idle') {
        // 只有最后一个输入释放后才重新开始完整空闲计时，避免从旧计时进度提前激活。
        this.resetIdleEpoch()
      }

      // pet-idle/action/entering 也可能在菜单期间被关闭观察；统一入口会按当前状态只恢复该有的 timer。
      this.scheduleOperationalTimers()
    }
  }

  public notifyKeyboardPress(key: string) {
    if (this.destroyed) return false

    const isFirstPress = !this.activeKeyboardInputs.has(key)

    if (isFirstPress) {
      this.activeKeyboardInputs.add(key)
      this.passiveEngine.notifyActivity({
        inputId: key,
        phase: 'start',
        source: getPassiveActivitySource(key),
      })

      if (this.activeKeyboardInputs.size === 1 && !this.menuPaused) {
        this.clearOperationalTimers()
        this.resetIdleEpoch()
        this.pendingAction = void 0
        this.pendingPassiveOccurrences = []
        this.invalidateActionMenu()
        this.clearSpeech()
      }
    }

    // 原生菜单的方向键/回车也会经过全局 hook；只记物理按压，不能让它们关闭自己正在操作的菜单。
    if (this.menuPaused) return false

    if (!this.behaviorConfig || !this.started || !this.canRunWithoutKeyboardInput()) return false

    if (this.currentState === 'work-idle') return false

    // key repeat 不重复触发退出；第一个物理 down 已经负责把宠物切回工作态。
    if (isFirstPress) void this.exitForInput()

    return true
  }

  public notifyKeyboardRelease(key: string) {
    if (this.destroyed || !this.activeKeyboardInputs.delete(key)) return false

    this.passiveEngine.notifyActivity({
      inputId: key,
      phase: 'end',
      source: getPassiveActivitySource(key),
    })

    if (this.menuPaused) return false

    if (this.activeKeyboardInputs.size > 0 || !this.canRun()) {
      return false
    }

    if (this.currentState === 'work-idle') {
      if (this.resumePendingActionFromWorkIdle()) return true

      this.resetIdleEpoch()
    }

    // 菜单关闭时导航键可能仍 held，当时的恢复会刻意关闭引擎。
    // 最后一键 release 必须覆盖所有宠物态，否则取消菜单可让自主计时永久停摆。
    this.scheduleOperationalTimers()

    return true
  }

  public notifyPassiveActivity(signal: PetPassiveActivitySignal) {
    if (this.destroyed) return

    const hadActiveInputs = this.passiveEngine.hasActiveInputs

    this.passiveEngine.notifyActivity(signal)

    if (this.menuPaused) return

    // 键盘/手柄还有第二步共享 held 账本同步；只有鼠标没有 controller 侧映射账本，才在这里
    // 直接重排 activation/idle。否则 gamepad release 会先按“全释放”重计一次，再被 sync 重计第二次。
    if (signal.source !== 'mouse') return

    if (!hadActiveInputs && this.passiveEngine.hasActiveInputs) {
      // 按住鼠标时暂停 idle/interval，否则定时器会在拖拽期间突然播放被动动作。
      if (this.currentState === 'work-idle') {
        this.clearActivationTimer()
        this.pausedActivationRemainingMs = void 0
      }
      this.resetIdleEpoch()
    } else if (hadActiveInputs && !this.passiveEngine.hasActiveInputs) {
      if (this.startNextPassiveOccurrence()) return

      if (this.currentState === 'work-idle') {
        this.scheduleActivation()
      } else if (this.currentState === 'pet-idle') {
        // 鼠标 held 期间不累计宠物 idle；释放后从新 epoch 的完整阈值开始。
        this.resetIdleEpoch()
        this.schedulePassiveActions()
      }
    } else if (signal.phase === 'pulse' && !this.passiveEngine.hasActiveInputs) {
      // 无 held 状态的离散活动也要重置空闲轮次，但不伪造一次 press/release。
      this.resetIdleEpoch()

      if (this.currentState === 'work-idle') {
        this.scheduleActivation()
      } else if (this.currentState === 'pet-idle') {
        this.schedulePassiveActions()
      }
    }
  }

  public setPresenceVisible(visible: boolean) {
    if (this.destroyed) return

    this.passiveEngine.setPresenceVisible(visible)
  }

  public exitForInput(): Promise<boolean> {
    if (!this.behaviorConfig || !this.started || this.destroyed) {
      return Promise.resolve(false)
    }

    if (this.currentState === 'work-idle') {
      if (this.canRun()) this.scheduleOperationalTimers()

      return Promise.resolve(false)
    }

    if (this.exitingPromise) return this.exitingPromise

    this.clearTimers()
    this.activePetAction = void 0
    this.pendingAction = void 0
    this.invalidateActionMenu()
    this.setState('pet-exiting')

    const playback = this.beginPlayback(
      this.behaviorConfig.exitAnimation,
      this.defaultAnimation,
    )

    if (!playback) {
      this.setState('work-idle')
      if (this.canRun()) this.scheduleOperationalTimers()

      return Promise.resolve(false)
    }

    const promise = playback.handle.finished.then((result) => {
      // 新模型/新播放已推进 generation 时，本次完成只能结算 Promise，不能覆盖新状态。
      if (!this.isPlaybackCurrent(playback)) return false

      this.exitingPromise = null
      this.setState('work-idle')

      if (this.canRun()) this.scheduleOperationalTimers()

      return result.reason === 'finished'
    }, () => {
      if (!this.isPlaybackCurrent(playback)) return false

      this.exitingPromise = null
      this.setState('work-idle')

      if (this.canRun()) this.scheduleOperationalTimers()

      return false
    })

    this.exitingPromise = promise

    return promise
  }

  public beginActionMenu(locale = this.context.locale): PetActionMenuView | null {
    if (!this.behaviorConfig || this.destroyed || this.menuPaused) return null

    const manualTriggers = this.moduleTriggers.filter((trigger): trigger is PetRuntimeManualTrigger => {
      return trigger.type === 'manual'
    })

    if (manualTriggers.length === 0) return null

    const revision = ++this.catalogRevision

    // 原生菜单会阻塞用户操作一段时间；先冻结工作态激活的剩余时长，避免看菜单也被算作无人输入。
    this.pauseActivationForMenu()
    this.menuPausedAt = this.clock.now()
    this.menuPaused = true
    this.passiveEngine.setPaused(true)
    this.selectedMenuAction = void 0
    this.clearOperationalTimers()

    const groups = new Map<string, PetManualActionView[]>()

    for (const trigger of manualTriggers) {
      const action = this.moduleActions.get(trigger.actionId)

      if (!action) continue

      const module = this.modules.get(trigger.moduleId)
      const group = trigger.group
        ? resolvePetLocalizedText(trigger.group, locale)
        : resolvePetLocalizedText(module?.displayName ?? 'Pet', locale)
      const item: PetManualActionView = {
        id: trigger.id,
        label: resolvePetLocalizedText(trigger.label, locale),
        group,
        // 模块序位乘数大于合法 trigger.order 全跨度，确保局部排序不会越界到相邻模块。
        order: (module?.order ?? 0) * 100_000 + trigger.order,
        enabled: this.canAcceptAction(action, 'manual', trigger.enterPet),
      }

      const entries = groups.get(group) ?? []

      entries.push(item)
      groups.set(group, entries)
    }

    return {
      revision,
      groups: [...groups.entries()]
        .map(([label, actions]) => ({
          label,
          actions: actions.sort((left, right) => left.order - right.order),
        }))
        .sort((left, right) => {
          return (left.actions[0]?.order ?? 0) - (right.actions[0]?.order ?? 0)
        }),
    }
  }

  public selectActionMenuItem(revision: number, triggerId: string) {
    if (!this.menuPaused || revision !== this.catalogRevision) return false

    const trigger = this.moduleTriggers.find((candidate): candidate is PetRuntimeManualTrigger => {
      return candidate.type === 'manual' && candidate.id === triggerId
    })

    if (!trigger) return false

    const action = this.moduleActions.get(trigger.actionId)

    // 菜单打开后输入、冷却或播放状态仍可能变化；选择时必须重新验证快照。
    if (!action || !this.canAcceptAction(action, 'manual', trigger.enterPet)) return false

    this.selectedMenuAction = triggerId

    return true
  }

  public endActionMenu(revision: number) {
    if (!this.menuPaused || revision !== this.catalogRevision) return false

    const selectedTriggerId = this.selectedMenuAction

    this.resumeMenuPassiveDeadlines()
    this.menuPaused = false
    this.selectedMenuAction = void 0

    let accepted = false

    if (selectedTriggerId) {
      const trigger = this.moduleTriggers.find((candidate): candidate is PetRuntimeManualTrigger => {
        return candidate.type === 'manual' && candidate.id === selectedTriggerId
      })

      accepted = Boolean(
        trigger && this.requestAction(trigger.actionId, 'manual', trigger.enterPet),
      )
    }

    if (!accepted && this.currentState === 'pet-idle') this.startPendingAction()

    // popup 暂停了所有定时器；无论有没有选中动作，都要恢复 schedule 扫描和对应状态的计时。
    this.passiveEngine.setPaused(false)
    this.scheduleOperationalTimers()

    return accepted
  }

  public dispatchInteraction(input: PetInteractionInput) {
    if (!this.behaviorConfig || !this.canRun() || !this.context.mouseInteractions) return false

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

    return this.requestAction(interaction.actionId, 'pointer', false)
  }

  public resolveInteraction(input: PetInteractionInput) {
    const areas = input.area
      ? [input.area]
      : input.point
        ? this.hitTest(input.point)
        : []

    return this.moduleTriggers.find((candidate): candidate is PetRuntimePointerTrigger => {
      if (candidate.type !== 'pointer') return false

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

    if (!config
      || !this.canRun()
      || this.passiveEngine.hasActiveInputs
      || this.currentState !== 'work-idle') {
      return
    }

    // gamepad release 会先更新 passive 账本、再同步 controller 键账本；第一次 gate 失败时
    // 不能提前消费菜单冻结的剩余量，等第二步确认所有输入已释放后再真正恢复。
    const resumedDelay = this.pausedActivationRemainingMs

    this.pausedActivationRemainingMs = void 0

    const generation = this.lifecycleGeneration
    const delay = resumedDelay
      ?? this.context.activationDelayMs
      ?? config.activationDelayMs

    this.activationNextAt = this.clock.now() + delay

    const timer = this.clock.setTimeout(() => {
      // 同时核对 timer 身份和 generation，覆盖“计时器已触发排队后才被取消”的竞态。
      if (this.activationTimer !== timer || generation !== this.lifecycleGeneration) return

      this.activationTimer = void 0
      this.activationNextAt = void 0
      this.enterPetMode()
    }, delay)

    this.activationTimer = timer
  }

  private enterPetMode() {
    const config = this.behaviorConfig

    if (!config || !this.canRun() || this.currentState !== 'work-idle') return

    // 任何真正的宠物态进入都已消费工作态激活周期，不能把菜单快照带到下一轮工作空闲期。
    this.pausedActivationRemainingMs = void 0
    this.setState('pet-entering')

    const playback = this.beginPlayback(config.enterAnimation, config.idleAnimation)

    if (!playback) {
      this.pendingAction = void 0
      this.setState('work-idle')
      this.scheduleOperationalTimers()

      return
    }

    void playback.handle.finished.then((result) => {
      if (!this.isPlaybackCurrent(playback)) return

      if (result.reason !== 'finished' || !this.canRun()) {
        this.pendingAction = void 0
        this.setState('work-idle')
        if (this.canRun()) this.scheduleOperationalTimers()

        return
      }

      this.setState('pet-idle')
      // interval 表示“宠物安静多久后再动作”，所以必须从进入完成后的可见 idle 帧重新计时。
      this.restartIntervalDelays()

      // 原生菜单可跨过进入动画结束；暂停期保留单 pending，等 popup finally 统一恢复。
      if (this.menuPaused) return
      if (this.startPendingAction()) return
      // enterPet=false 的日程只能在宠物态执行；进入完成后立即消费已观察到的日程队列。
      if (this.startNextPassiveOccurrence()) return
      this.schedulePassiveActions()
    }, () => {
      if (!this.isPlaybackCurrent(playback)) return

      this.pendingAction = void 0
      this.setState('work-idle')
      if (this.canRun()) this.scheduleOperationalTimers()
    })
  }

  private requestAction(
    actionId: string,
    source: PetActionSource,
    enterPet: boolean,
    allowPending = true,
  ) {
    const action = this.moduleActions.get(actionId)

    if (!action || !this.isActionOperational(action, source)) return false

    const request: PetActionRequest = {
      action,
      source,
      priority: this.sourcePriority(source) + action.priority,
      enterPet,
    }

    if (this.currentState === 'work-idle') {
      if (!enterPet || !this.queuePendingAction(request)) return false

      // schedule/manual 可以主动唤醒宠物；保留 schedule 扫描，只撤掉会与进入动画竞争的计时器。
      this.clearActivationTimer()
      this.clearPassiveTimers()
      this.enterPetMode()

      return true
    }

    if (this.currentState === 'pet-entering') {
      return allowPending && this.queuePendingAction(request)
    }

    if (this.currentState === 'pet-idle') {
      return this.startActionRequest(request)
    }

    if (this.currentState === 'pet-exiting') return false

    if (this.canPreemptActiveAction(request)) return this.startActionRequest(request)

    return allowPending && this.queuePendingAction(request)
  }

  private canAcceptAction(action: PetRuntimeAction, source: PetActionSource, enterPet: boolean) {
    if (!this.isActionOperational(action, source)) return false

    const request: PetActionRequest = {
      action,
      source,
      priority: this.sourcePriority(source) + action.priority,
      enterPet,
    }

    if (this.currentState === 'pet-exiting') return false
    if (this.currentState === 'work-idle') return enterPet
    if (this.currentState === 'pet-entering') return this.canQueuePendingAction(request)
    if (this.currentState === 'pet-idle') return true

    return this.canPreemptActiveAction(request) || this.canQueuePendingAction(request)
  }

  private startActionRequest(request: PetActionRequest) {
    const config = this.behaviorConfig

    if (!config
      || !this.isActionOperational(request.action, request.source)
      || this.currentState === 'pet-exiting') {
      return false
    }

    // 同一动作若已在 pending，较高来源优先级的立即执行应同时消费旧请求，避免结束后重播一次。
    if (this.pendingAction?.action.id === request.action.id) this.pendingAction = void 0

    this.clearPassiveTimers()
    this.clearSpeech()

    if (!request.action.animation) {
      // 对话动作也要重播 pet idle 来中断旧动作；只推进 generation 会让旧雪碧继续留在画面上。
      const playback = this.beginPlayback(config.idleAnimation, config.idleAnimation)
      const generation = playback?.generation ?? this.playbackGeneration

      // loop idle 只会在下一次播放时以 interrupted 结算，此句柄不参与动作完成判定。
      void playback?.handle.finished.catch(() => void 0)

      this.commitActionStart(request)
      this.showActionDialogue(request.action, generation)
      this.scheduleDialogueOnlyCompletion(request.action, generation)

      return true
    }

    const playback = this.beginPlayback(request.action.animation, config.idleAnimation)

    if (!playback) {
      this.finishCurrentAction(false)

      return false
    }

    this.commitActionStart(request)
    this.showActionDialogue(request.action, playback.generation)
    this.finishPetPlayback(playback)

    return true
  }

  private finishPetPlayback(playback: ActivePlayback) {
    void playback.handle.finished.then((result) => {
      // 被按键、交互或模型切换打断的动作不能回到 pet-idle，否则会和工作动画争夺画面。
      if (!this.isPlaybackCurrent(playback)) return

      this.finishCurrentAction(result.reason === 'finished')
    }, () => {
      if (!this.isPlaybackCurrent(playback)) return

      this.finishCurrentAction(false)
    })
  }

  private rebuildModuleCatalog() {
    this.modules.clear()
    this.moduleActions.clear()
    this.moduleTriggers = []

    for (const module of this.behaviorConfig?.modules ?? []) {
      this.modules.set(module.id, module)

      for (const action of module.actions) this.moduleActions.set(action.id, action)

      this.moduleTriggers.push(...module.triggers)
    }

    const legacyActions: PetRuntimeAction[] = []
    const legacyTriggers: PetRuntimeTrigger[] = []
    const autonomous = this.behaviorConfig?.autonomous

    if (autonomous) {
      const choices = autonomous.actions.map((action) => {
        const actionId = `${PET_LEGACY_MODULE_ID}/autonomous-${action.id}`

        legacyActions.push({
          id: actionId,
          moduleId: PET_LEGACY_MODULE_ID,
          animation: action.animation,
          priority: 0,
          cooldownMs: action.cooldownMs ?? 0,
          interruptible: true,
        })

        return { actionId, weight: action.weight }
      })

      legacyTriggers.push({
        id: `${PET_LEGACY_MODULE_ID}/autonomous`,
        moduleId: PET_LEGACY_MODULE_ID,
        type: 'interval',
        delayMs: autonomous.delayMs,
        choices,
      })
    }

    for (const interaction of this.behaviorConfig?.interactions ?? []) {
      const actionId = `${PET_LEGACY_MODULE_ID}/interaction-${interaction.id}`

      legacyActions.push({
        id: actionId,
        moduleId: PET_LEGACY_MODULE_ID,
        animation: interaction.animation,
        priority: 0,
        cooldownMs: interaction.cooldownMs ?? 0,
        interruptible: true,
      })
      legacyTriggers.push({
        id: `${PET_LEGACY_MODULE_ID}/interaction-${interaction.id}`,
        moduleId: PET_LEGACY_MODULE_ID,
        type: 'pointer',
        actionId,
        event: interaction.event,
        area: interaction.area,
        holdMs: interaction.holdMs,
        distance: interaction.distance,
        windowMs: interaction.windowMs,
      })
    }

    if (legacyActions.length > 0) {
      // 旧 autonomous/interactions 先规范化成同一 Module→Action→Trigger 图，后续调度只有一条路径。
      const legacyModule: PetBehaviorRuntimeModule = {
        id: PET_LEGACY_MODULE_ID,
        displayName: { 'zh-CN': '内置行为', 'en-US': 'Built-in' },
        order: -10_000,
        actions: legacyActions,
        triggers: legacyTriggers,
      }

      this.modules.set(legacyModule.id, legacyModule)

      for (const action of legacyActions) this.moduleActions.set(action.id, action)

      this.moduleTriggers.push(...legacyTriggers)
    }

    // 被动引擎只接收模型数据，不持有动作播放器；切模型时整批替换可作废旧事件代次。
    this.passiveEngine.configure(this.moduleTriggers, this.moduleScopeId)
  }

  private resetIdleEpoch() {
    this.clearPassiveTimers()
    this.idleEpoch++
    this.intervalNextAt.clear()
    this.idleNextAt.clear()
    this.consumedIdleTriggers.clear()
    this.lastIntervalAction.clear()
    // idle/interval 属于本轮空闲期；已被观察到的外部 occurrence 由独立队列负责生命周期。
    const now = this.clock.now()

    for (const trigger of this.moduleTriggers) {
      if (trigger.type === 'idle') {
        this.idleNextAt.set(trigger.id, now + trigger.afterMs)
      }
    }
  }

  private restartIntervalDelays() {
    // 动画可在原生菜单打开期间结束；以暂停起点计算，关闭时再整体平移才不会吞掉新 delay。
    const now = this.menuPausedAt ?? this.clock.now()

    this.intervalNextAt.clear()

    for (const trigger of this.moduleTriggers) {
      if (trigger.type === 'interval') {
        this.intervalNextAt.set(trigger.id, now + this.randomDelay(trigger.delayMs))
      }
    }
  }

  private scheduleOperationalTimers() {
    this.passiveEngine.setOperational(this.canRun() && !this.menuPaused)

    if (!this.canRun() || this.menuPaused) {
      this.clearOperationalTimers()

      return
    }

    this.scheduleScheduleScan()

    if (this.currentState === 'work-idle') this.scheduleActivation()
    else this.clearActivationTimer()

    if (this.currentState === 'pet-idle') this.schedulePassiveActions()
    else this.clearPassiveTimers()
  }

  private scheduleScheduleScan() {
    this.clearScheduleTimer()

    if (!this.canRun()
      || this.menuPaused
      || !this.moduleTriggers.some(trigger => trigger.type === 'schedule')) {
      return
    }

    this.scanScheduledActions()
    this.armScheduleScan()
  }

  private armScheduleScan() {
    if (!this.canRun() || this.menuPaused) return

    const generation = this.lifecycleGeneration
    const timer = this.clock.setTimeout(() => {
      if (this.scheduleTimer !== timer || generation !== this.lifecycleGeneration) return

      this.scheduleTimer = void 0
      this.scanScheduledActions()
      this.armScheduleScan()
    }, delayUntilNextScheduleScan(this.wallNow()))

    this.scheduleTimer = timer
  }

  private scanScheduledActions() {
    if (!this.canRun() || this.menuPaused) return false

    const wallNow = this.wallNow()
    const monotonicNow = this.clock.now()

    for (const [key, expiresAt] of this.consumedScheduleOccurrences) {
      if (expiresAt <= wallNow) this.consumedScheduleOccurrences.delete(key)
    }

    const due = this.moduleTriggers
      .filter((trigger): trigger is PetRuntimeScheduleTrigger => trigger.type === 'schedule')
      .flatMap((trigger) => {
        const occurrence = findDuePetScheduleOccurrence(trigger, wallNow)

        if (!occurrence || this.consumedScheduleOccurrences.has(occurrence.key)) return []

        const action = this.moduleActions.get(trigger.actionId)

        return action
          ? [{ trigger, action, occurrence }]
          : []
      })
      .sort((left, right) => {
        const priorityDelta = (this.sourcePriority('schedule') + right.action.priority)
          - (this.sourcePriority('schedule') + left.action.priority)

        return priorityDelta || left.occurrence.dueAt - right.occurrence.dueAt
      })

    for (const candidate of due) {
      // 发现时就登记消费，后续由专用队列持有；分钟扫描和动作完成回调都不会重复入队。
      this.consumedScheduleOccurrences.set(
        candidate.occurrence.key,
        candidate.occurrence.expiresAt,
      )

      // 墙钟 occurrence 只把相对过期量投影到单调钟，排队后不会受用户校时或 DST 回拨影响。
      this.enqueuePassiveOccurrence({
        actionId: candidate.trigger.actionId,
        dueAt: monotonicNow - Math.max(0, wallNow - candidate.occurrence.dueAt),
        enterPet: candidate.trigger.enterPet,
        expiresAt: monotonicNow + Math.max(0, candidate.occurrence.expiresAt - wallNow),
        key: candidate.occurrence.key,
        sequence: 0,
        source: 'schedule',
        triggerId: candidate.trigger.id,
      }, false)
    }

    return this.startNextPassiveOccurrence()
  }

  private enqueuePassiveOccurrence(occurrence: QueuedPassiveOccurrence, drain = true) {
    if (!this.moduleActions.has(occurrence.actionId)
      || this.clock.now() < (this.cooldowns.get(occurrence.actionId) ?? 0)
      || this.activePetAction?.actionId === occurrence.actionId
      || this.pendingAction?.action.id === occurrence.actionId) {
      return false
    }

    const existingIndex = this.pendingPassiveOccurrences.findIndex(
      pending => pending.triggerId === occurrence.triggerId,
    )
    const existing = this.pendingPassiveOccurrences[existingIndex]

    // 事件型 trigger 只保留最新 occurrence，避免长冷却后补播同一种过期反应。
    if (existing && existing.dueAt > occurrence.dueAt) return false
    if (existingIndex >= 0) this.pendingPassiveOccurrences.splice(existingIndex, 1)

    this.pendingPassiveOccurrences.push({
      ...occurrence,
      sequence: ++this.passiveOccurrenceSequence,
    })
    this.pendingPassiveOccurrences.sort((left, right) => {
      const leftAction = this.moduleActions.get(left.actionId)
      const rightAction = this.moduleActions.get(right.actionId)
      const priorityDelta = (this.sourcePriority(right.source) + (rightAction?.priority ?? 0))
        - (this.sourcePriority(left.source) + (leftAction?.priority ?? 0))

      return priorityDelta || left.dueAt - right.dueAt || left.sequence - right.sequence
    })

    // 所有被动来源共用同一有界队列；被截断项不会由各自引擎重复发现。
    if (this.pendingPassiveOccurrences.length > PET_MAX_PENDING_PASSIVE_OCCURRENCES) {
      this.pendingPassiveOccurrences.length = PET_MAX_PENDING_PASSIVE_OCCURRENCES
    }

    return drain ? this.startNextPassiveOccurrence() : false
  }

  private startNextPassiveOccurrence() {
    const now = this.clock.now()

    // occurrence 已记录即不再由引擎复活；冷却或模型引用失效时直接丢弃，避免无事件可唤醒的死队列。
    this.pendingPassiveOccurrences = this.pendingPassiveOccurrences.filter((candidate) => {
      return this.moduleActions.has(candidate.actionId)
        && now >= (this.cooldowns.get(candidate.actionId) ?? 0)
    })

    if (!this.canRun()
      || this.passiveEngine.hasActiveInputs
      || this.menuPaused
      || this.pendingPassiveOccurrences.length === 0) {
      return false
    }

    if (this.currentState === 'work-idle') {
      const canEnterForBatch = this.pendingPassiveOccurrences.some((candidate) => {
        const action = this.moduleActions.get(candidate.actionId)

        return candidate.enterPet
          && action !== void 0
          && this.isActionOperational(action, candidate.source)
      })

      if (!canEnterForBatch) return false

      // enterPet 只给整批日程提供“进入许可”，不代表该低优先级动作能抢占 pending 槽；
      // 进入完成后仍从未删减的优先队列头开始播放，保证同批仲裁与宠物态一致。
      this.clearActivationTimer()
      this.clearPassiveTimers()
      this.enterPetMode()

      return true
    }

    const remaining: QueuedPassiveOccurrence[] = []
    let accepted = false

    for (const candidate of this.pendingPassiveOccurrences) {
      const action = this.moduleActions.get(candidate.actionId)

      if (!action) continue

      if (!accepted
        && this.requestAction(action.id, candidate.source, candidate.enterPet, false)) {
        accepted = true
        continue
      }

      // 当前动作、pending 槽或冷却可能只是暂时阻止接纳；保留事件到下一次动作完成再试。
      remaining.push(candidate)
    }

    this.pendingPassiveOccurrences = remaining

    return accepted
  }

  private schedulePassiveActions() {
    this.clearPassiveTimers()

    if (!this.canRun()
      || this.passiveEngine.hasActiveInputs
      || this.menuPaused
      || this.currentState !== 'pet-idle') {
      return
    }

    const now = this.clock.now()
    const generation = this.lifecycleGeneration
    const epoch = this.idleEpoch

    // timer identity 防同一触发器重排后的旧回调，generation 防 stop/configure 后回调，epoch 防跨空闲轮次误触发。
    for (const trigger of this.moduleTriggers) {
      if (trigger.type === 'interval') {
        const nextAt = this.intervalNextAt.get(trigger.id)
          ?? now + this.randomDelay(trigger.delayMs)

        this.intervalNextAt.set(trigger.id, nextAt)

        const timer = this.clock.setTimeout(() => {
          if (this.intervalTimers.get(trigger.id) !== timer
            || generation !== this.lifecycleGeneration
            || epoch !== this.idleEpoch) {
            return
          }

          this.intervalTimers.delete(trigger.id)
          this.fireIntervalTrigger(trigger)
        }, Math.max(0, nextAt - now))

        this.intervalTimers.set(trigger.id, timer)
      } else if (trigger.type === 'idle' && !this.consumedIdleTriggers.has(trigger.id)) {
        const nextAt = this.idleNextAt.get(trigger.id) ?? now + trigger.afterMs

        this.idleNextAt.set(trigger.id, nextAt)

        const timer = this.clock.setTimeout(() => {
          if (this.idleTimers.get(trigger.id) !== timer
            || generation !== this.lifecycleGeneration
            || epoch !== this.idleEpoch) {
            return
          }

          this.idleTimers.delete(trigger.id)
          this.fireIdleTrigger(trigger)
        }, Math.max(0, nextAt - now))

        this.idleTimers.set(trigger.id, timer)
      }
    }
  }

  private fireIntervalTrigger(trigger: PetRuntimeIntervalTrigger) {
    if (!this.canRun()
      || this.passiveEngine.hasActiveInputs
      || this.menuPaused
      || this.currentState !== 'pet-idle') {
      return
    }

    const now = this.clock.now()

    // 只有实际到期的 interval 重排自己的 deadline；其他模块继续保留原剩余时间，避免长周期饿死。
    this.intervalNextAt.set(trigger.id, now + this.randomDelay(trigger.delayMs))

    let eligible = trigger.choices.filter((choice) => {
      const action = this.moduleActions.get(choice.actionId)

      return action && this.isActionOperational(action, 'interval')
    })
    const lastAction = this.lastIntervalAction.get(trigger.id)

    if (lastAction && eligible.length > 1) {
      eligible = eligible.filter(choice => choice.actionId !== lastAction)
    }

    const selected = this.selectWeighted(eligible)

    if (!selected || !this.requestAction(selected.actionId, 'interval', false)) {
      this.schedulePassiveActions()

      return
    }

    this.lastIntervalAction.set(trigger.id, selected.actionId)
  }

  private fireIdleTrigger(trigger: PetRuntimeIdleTrigger) {
    if (!this.canRun()
      || this.passiveEngine.hasActiveInputs
      || this.menuPaused
      || this.currentState !== 'pet-idle') {
      return
    }

    const now = this.clock.now()

    if (trigger.repeatMs) {
      this.idleNextAt.set(trigger.id, now + this.randomDelay(trigger.repeatMs))
    }

    const accepted = this.requestAction(trigger.actionId, 'idle', false)

    if (accepted && trigger.oncePerIdle) {
      // oncePerIdle 只有进入动作队列后才算消费，冷却中的首次到期仍应在本轮空闲期重试。
      this.consumedIdleTriggers.add(trigger.id)
      this.idleNextAt.delete(trigger.id)
    } else if (!accepted && trigger.oncePerIdle) {
      const cooldownUntil = this.cooldowns.get(trigger.actionId) ?? now

      this.idleNextAt.set(trigger.id, Math.max(now + 1_000, cooldownUntil))
    }

    if (!accepted) this.schedulePassiveActions()
  }

  private randomDelay(range: readonly [number, number]) {
    return range[0] + (range[1] - range[0]) * this.nextRandom()
  }

  private selectWeighted<T extends { weight: number }>(items: readonly T[]) {
    if (items.length === 0) return undefined

    const totalWeight = items.reduce((total, item) => total + item.weight, 0)
    let cursor = this.nextRandom() * totalWeight

    for (const item of items) {
      cursor -= item.weight

      if (cursor < 0) return item
    }

    return items[items.length - 1]
  }

  private sourcePriority(source: PetActionSource) {
    // 每档相隔 100，高于动作配置的 0…99，确保来源优先级不会被模型局部 priority 反转。
    return {
      'manual': 1_000,
      'pointer': 900,
      'active-session': 800,
      'schedule': 700,
      'visibility-return': 600,
      'session': 500,
      'activity-burst': 400,
      'daily-window': 300,
      'idle': 200,
      'interval': 100,
    }[source]
  }

  private isActionOperational(action: PetRuntimeAction, source: PetActionSource) {
    const runtimeReady = source === 'manual'
      ? this.canRunWithoutKeyboardInput()
      : this.canRun()

    if (!runtimeReady || (this.menuPaused && source !== 'manual')) return false
    // 鼠标不进入键盘空闲闸门，但所有被动来源仍必须等拖拽/长按结束；主动菜单和指针交互不受影响。
    if (source !== 'manual'
      && source !== 'pointer'
      && this.passiveEngine.hasActiveInputs) {
      return false
    }
    if (this.moduleActions.get(action.id) !== action) return false

    return this.clock.now() >= (this.cooldowns.get(action.id) ?? 0)
  }

  private canQueuePendingAction(request: PetActionRequest) {
    if (this.activePetAction?.actionId === request.action.id) return false
    if (this.pendingAction?.action.id === request.action.id) return false

    return !this.pendingAction || request.priority > this.pendingAction.priority
  }

  private queuePendingAction(request: PetActionRequest) {
    if (!this.canQueuePendingAction(request)) return false

    // pending 严格保持单槽，较高优先级原子替换旧请求，避免动作完成后形成不可控队列。
    this.pendingAction = request

    return true
  }

  private canPreemptActiveAction(request: PetActionRequest) {
    const active = this.activePetAction

    return Boolean(
      active
      && active.interruptible
      && active.actionId !== request.action.id
      && request.priority > active.priority,
    )
  }

  private commitActionStart(request: PetActionRequest) {
    const now = this.clock.now()

    // 冷却在动作被接纳时写入，防止同一帧的菜单和指针事件同时绕过检查。
    this.cooldowns.set(request.action.id, now + request.action.cooldownMs)
    this.activePetAction = {
      actionId: request.action.id,
      priority: request.priority,
      interruptible: request.action.interruptible,
    }

    this.setState(request.source === 'pointer' ? 'pet-interaction' : 'pet-action')
  }

  private finishCurrentAction(success: boolean) {
    this.activePetAction = void 0

    // 驱动异常不应留下与 idle 画面脱节的旧对白；正常结束则允许气泡按自身时长淡出。
    if (!success) this.clearSpeech()

    if (!this.canRun()) {
      this.pendingAction = void 0
      this.setState('work-idle')
      this.scheduleOperationalTimers()

      return
    }

    this.setState('pet-idle')
    // 动作播放耗时不属于 interval 的安静等待期；完成后所有 interval 都从完整 delay 重新竞争。
    this.restartIntervalDelays()

    // 动画可在原生菜单仍打开时结束；此时不能消费 pending，也不能重启被暂停的被动计时器。
    if (this.menuPaused) return

    if (this.startPendingAction()) return

    if (this.startNextPassiveOccurrence()) return

    // 同一分钟可由多个可插拔模块产生日程。一个动作结束后立即重扫，避免第二个事件
    // 被迫等到下一分钟、越过 catch-up 窗口后永久丢失。
    if (this.scanScheduledActions()) return

    this.schedulePassiveActions()
  }

  private startPendingAction() {
    const pending = this.pendingAction

    this.pendingAction = void 0

    if (!pending) return false

    return this.startActionRequest(pending)
  }

  private resumePendingActionFromWorkIdle() {
    const pending = this.pendingAction

    if (!pending || this.currentState !== 'work-idle') return false

    this.pendingAction = void 0

    // 键盘操作原生菜单时，manual 先留在单槽；最后一键释放后立即入场，不再等 activationDelay。
    const accepted = this.requestAction(pending.action.id, pending.source, pending.enterPet)

    if (accepted) this.scheduleOperationalTimers()

    return accepted
  }

  private showActionDialogue(action: PetRuntimeAction, generation: number) {
    const dialogue = action.dialogue

    if (!dialogue || !this.driver.speak || this.nextRandom() >= dialogue.chance) return

    const line = this.selectWeighted(dialogue.lines)

    if (!line) return

    const show = () => {
      if (generation !== this.playbackGeneration || this.destroyed) return

      this.driver.speak?.({
        text: resolvePetLocalizedText(line.text, this.context.locale),
        durationMs: dialogue.durationMs,
        anchor: dialogue.anchor,
      })

      const clearTimer = this.clock.setTimeout(() => {
        if (this.speechClearTimer !== clearTimer || generation !== this.playbackGeneration) return

        this.speechClearTimer = void 0
        this.driver.clearSpeech?.()
      }, dialogue.durationMs)

      this.speechClearTimer = clearTimer
    }

    if (dialogue.delayMs === 0) {
      show()

      return
    }

    const delayTimer = this.clock.setTimeout(() => {
      if (this.speechDelayTimer !== delayTimer || generation !== this.playbackGeneration) return

      this.speechDelayTimer = void 0
      show()
    }, dialogue.delayMs)

    this.speechDelayTimer = delayTimer
  }

  private scheduleDialogueOnlyCompletion(action: PetRuntimeAction, generation: number) {
    // 没有动画的动作仍要占据一次完整对白周期，否则同帧就回 idle，会让队列并发覆盖气泡。
    const duration = action.dialogue
      ? Math.max(1, action.dialogue.delayMs + action.dialogue.durationMs)
      : 1
    const timer = this.clock.setTimeout(() => {
      if (this.dialogueOnlyTimer !== timer || generation !== this.playbackGeneration) return

      this.dialogueOnlyTimer = void 0
      this.finishCurrentAction(true)
    }, duration)

    this.dialogueOnlyTimer = timer
  }

  private clearSpeech() {
    if (this.speechDelayTimer !== void 0) {
      this.clock.clearTimeout(this.speechDelayTimer)
      this.speechDelayTimer = void 0
    }
    if (this.speechClearTimer !== void 0) {
      this.clock.clearTimeout(this.speechClearTimer)
      this.speechClearTimer = void 0
    }
    if (this.dialogueOnlyTimer !== void 0) {
      this.clock.clearTimeout(this.dialogueOnlyTimer)
      this.dialogueOnlyTimer = void 0
    }

    this.driver.clearSpeech?.()
  }

  private invalidateActionMenu() {
    // revision 既是菜单快照版本，也是关闭后异步 click 的失效令牌，不能复用旧编号。
    const wasPaused = this.menuPaused

    this.catalogRevision++
    this.menuPaused = false
    this.menuPausedAt = void 0
    this.selectedMenuAction = void 0
    this.pausedActivationRemainingMs = void 0

    if (wasPaused) this.passiveEngine.setPaused(false)
  }

  private pauseActivationForMenu() {
    this.pausedActivationRemainingMs = this.currentState === 'work-idle'
      && this.activationNextAt !== void 0
      ? Math.max(0, this.activationNextAt - this.clock.now())
      : void 0
  }

  private resumeMenuPassiveDeadlines() {
    const pausedAt = this.menuPausedAt

    this.menuPausedAt = void 0

    if (pausedAt === void 0) return

    const pausedMs = Math.max(0, this.clock.now() - pausedAt)

    // interval/idle 使用单调截止时间，需显式平移；wall-clock schedule/daily 仍按现实时间扫描。
    for (const [id, nextAt] of this.intervalNextAt) {
      this.intervalNextAt.set(id, nextAt + pausedMs)
    }
    for (const [id, nextAt] of this.idleNextAt) {
      this.idleNextAt.set(id, nextAt + pausedMs)
    }
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

  private wallNow() {
    // 旧测试时钟没有 wallNow 时回退到 now，使注入的单一虚拟时间仍能完全控制行为。
    return this.clock.wallNow?.() ?? this.clock.now()
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
    this.clearOperationalTimers()
    this.clearSpeech()
  }

  private clearOperationalTimers() {
    this.clearActivationTimer()
    this.clearPassiveTimers()
    this.clearScheduleTimer()
  }

  private clearActivationTimer() {
    if (this.activationTimer !== void 0) this.clock.clearTimeout(this.activationTimer)

    this.activationTimer = void 0
    this.activationNextAt = void 0
  }

  private clearPassiveTimers() {
    for (const timer of this.intervalTimers.values()) this.clock.clearTimeout(timer)
    for (const timer of this.idleTimers.values()) this.clock.clearTimeout(timer)

    // 这里只撤句柄，不清 nextAt；动作/菜单结束后要按原剩余时间恢复，不能重置其他模块周期。
    this.intervalTimers.clear()
    this.idleTimers.clear()
  }

  private clearScheduleTimer() {
    if (this.scheduleTimer === void 0) return

    this.clock.clearTimeout(this.scheduleTimer)
    this.scheduleTimer = void 0
  }
}

function getPassiveActivitySource(inputId: string): PetPassiveActivitySignal['source'] {
  return inputId.startsWith('Gamepad:') ? 'gamepad' : 'keyboard'
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
  let legacyActionCount = 0
  let legacyTriggerCount = 0

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

    legacyActionCount += actions.length
    legacyTriggerCount += 1

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
  const semanticBindings = new Set<string>()

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

    legacyActionCount += value.interactions.length
    legacyTriggerCount += value.interactions.length

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

  // 旧 autonomous/interactions 会被合成一个内部 module，必须与外部模块
  // 共用同一模型级预算，否则顶层数组可以绕过 timer/catalog 上限。
  if (legacyActionCount > PET_MAX_MODULE_ACTIONS) {
    throw new RangeError(`Pet behavior legacy actions cannot exceed ${PET_MAX_MODULE_ACTIONS}`)
  }
  if (legacyTriggerCount > PET_MAX_MODULE_TRIGGERS) {
    throw new RangeError(`Pet behavior legacy triggers cannot exceed ${PET_MAX_MODULE_TRIGGERS}`)
  }
  if (legacyActionCount > PET_MAX_TOTAL_MODULE_ACTIONS) {
    throw new RangeError(
      `Pet behavior actions cannot exceed ${PET_MAX_TOTAL_MODULE_ACTIONS}`,
    )
  }
  if (legacyTriggerCount > PET_MAX_TOTAL_MODULE_TRIGGERS) {
    throw new RangeError(
      `Pet behavior triggers cannot exceed ${PET_MAX_TOTAL_MODULE_TRIGGERS}`,
    )
  }

  if (value.modules !== void 0) {
    assertRuntimeModules(
      value.modules,
      context,
      hitAreaIds,
      semanticBindings,
      legacyActionCount,
      legacyTriggerCount,
    )
  }
}

function assertRuntimeModules(
  value: unknown,
  context: PetBehaviorValidationContext,
  hitAreaIds: Set<string>,
  semanticBindings: Set<string>,
  initialActionCount: number,
  initialTriggerCount: number,
) {
  if (!Array.isArray(value)) throw new TypeError('Pet behavior modules must be an array')
  if (value.length > PET_MAX_MODULES) {
    throw new RangeError(`Pet behavior modules cannot exceed ${PET_MAX_MODULES}`)
  }

  const moduleIds = new Set<string>()
  const actionIds = new Set<string>()
  const triggerIds = new Set<string>()
  let totalActions = initialActionCount
  let totalTriggers = initialTriggerCount

  for (const [moduleIndex, module] of value.entries()) {
    const moduleLabel = `Pet behavior modules[${moduleIndex}]`

    // module.json 虽已在读取层规范化，合并后的对象仍属于模型输入；这里二次校验可阻止
    // 类型断言、缓存或未来合并逻辑把不完整运行时图送进状态机。
    assertRecord(module, moduleLabel)
    assertAllowedKeys(module, ['id', 'displayName', 'order', 'actions', 'triggers'], moduleLabel)
    assertSafeId(module.id, `${moduleLabel}.id`)

    if (moduleIds.has(module.id)) throw new TypeError(`${moduleLabel}.id must be unique`)

    moduleIds.add(module.id)
    assertLocalizedText(module.displayName, `${moduleLabel}.displayName`)
    assertBoundedInteger(module.order, -10_000, 10_000, `${moduleLabel}.order`)

    if (!Array.isArray(module.actions) || module.actions.length === 0) {
      throw new TypeError(`${moduleLabel}.actions must be a non-empty array`)
    }
    if (module.actions.length > PET_MAX_MODULE_ACTIONS) {
      throw new RangeError(`${moduleLabel}.actions cannot exceed ${PET_MAX_MODULE_ACTIONS}`)
    }

    totalActions += module.actions.length

    if (totalActions > PET_MAX_TOTAL_MODULE_ACTIONS) {
      throw new RangeError(
        `Pet behavior module actions cannot exceed ${PET_MAX_TOTAL_MODULE_ACTIONS}`,
      )
    }

    const ownActionIds = new Set<string>()

    for (const [actionIndex, action] of module.actions.entries()) {
      const actionLabel = `${moduleLabel}.actions[${actionIndex}]`

      assertRecord(action, actionLabel)
      assertAllowedKeys(
        action,
        ['id', 'moduleId', 'animation', 'priority', 'cooldownMs', 'interruptible', 'dialogue'],
        actionLabel,
      )
      assertQualifiedId(action.id, module.id, `${actionLabel}.id`)

      if (actionIds.has(action.id)) throw new TypeError(`${actionLabel}.id must be globally unique`)

      actionIds.add(action.id)
      ownActionIds.add(action.id)

      if (action.moduleId !== module.id) {
        throw new TypeError(`${actionLabel}.moduleId must match its parent module`)
      }
      if (action.animation !== void 0) {
        assertNonEmptyString(action.animation, `${actionLabel}.animation`)
        assertAnimation(action.animation, false, context, `${actionLabel}.animation`)
      }

      assertBoundedInteger(action.priority, 0, 99, `${actionLabel}.priority`)
      assertNonNegativeTimerDelay(action.cooldownMs, `${actionLabel}.cooldownMs`)
      assertBoolean(action.interruptible, `${actionLabel}.interruptible`)

      if (action.dialogue !== void 0) {
        assertRecord(action.dialogue, `${actionLabel}.dialogue`)
        assertRuntimeDialogue(action.dialogue, context.canvas, `${actionLabel}.dialogue`)
      }
      if (action.animation === void 0 && action.dialogue === void 0) {
        throw new TypeError(`${actionLabel} must define animation or dialogue`)
      }
    }

    if (!Array.isArray(module.triggers) || module.triggers.length === 0) {
      throw new TypeError(`${moduleLabel}.triggers must be a non-empty array`)
    }
    if (module.triggers.length > PET_MAX_MODULE_TRIGGERS) {
      throw new RangeError(`${moduleLabel}.triggers cannot exceed ${PET_MAX_MODULE_TRIGGERS}`)
    }

    totalTriggers += module.triggers.length

    // 运行时二次镜像 loader 总预算，避免未来缓存/合并路径绕过外部 manifest 校验。
    if (totalTriggers > PET_MAX_TOTAL_MODULE_TRIGGERS) {
      throw new RangeError(
        `Pet behavior module triggers cannot exceed ${PET_MAX_TOTAL_MODULE_TRIGGERS}`,
      )
    }

    for (const [triggerIndex, trigger] of module.triggers.entries()) {
      const triggerLabel = `${moduleLabel}.triggers[${triggerIndex}]`

      assertRecord(trigger, triggerLabel)
      assertQualifiedId(trigger.id, module.id, `${triggerLabel}.id`)

      if (triggerIds.has(trigger.id)) throw new TypeError(`${triggerLabel}.id must be globally unique`)
      if (trigger.moduleId !== module.id) {
        throw new TypeError(`${triggerLabel}.moduleId must match its parent module`)
      }

      triggerIds.add(trigger.id)
      assertRuntimeTrigger(
        trigger,
        triggerLabel,
        ownActionIds,
        hitAreaIds,
        semanticBindings,
      )
    }
  }
}

function assertRuntimeDialogue(
  value: Record<string, unknown>,
  canvas: PetBehaviorValidationContext['canvas'],
  label: string,
) {
  assertAllowedKeys(value, ['chance', 'delayMs', 'durationMs', 'anchor', 'lines'], label)
  assertPositiveNumber(value.chance, `${label}.chance`)

  if (value.chance > 1) throw new RangeError(`${label}.chance cannot exceed 1`)

  assertNonNegativeTimerDelay(value.delayMs, `${label}.delayMs`)
  assertPositiveTimerDelay(value.durationMs, `${label}.durationMs`)

  if (value.anchor !== void 0) {
    const anchorLabel = `${label}.anchor`

    assertRecord(value.anchor, anchorLabel)
    assertAllowedKeys(value.anchor, ['x', 'y'], anchorLabel)
    assertNonNegativeNumber(value.anchor.x, `${anchorLabel}.x`)
    assertNonNegativeNumber(value.anchor.y, `${anchorLabel}.y`)

    if (value.anchor.x > canvas.width || value.anchor.y > canvas.height) {
      throw new RangeError(`${anchorLabel} exceeds the model canvas`)
    }
  }

  if (!Array.isArray(value.lines) || value.lines.length === 0) {
    throw new TypeError(`${label}.lines must be a non-empty array`)
  }
  if (value.lines.length > PET_MAX_DIALOGUE_LINES) {
    throw new RangeError(`${label}.lines cannot exceed ${PET_MAX_DIALOGUE_LINES}`)
  }

  let totalWeight = 0

  for (const [index, line] of value.lines.entries()) {
    const lineLabel = `${label}.lines[${index}]`

    assertRecord(line, lineLabel)
    assertAllowedKeys(line, ['text', 'weight'], lineLabel)
    assertLocalizedText(line.text, `${lineLabel}.text`)
    assertPositiveNumber(line.weight, `${lineLabel}.weight`)
    totalWeight += line.weight
  }

  if (!Number.isFinite(totalWeight)) {
    throw new RangeError(`${label}.line weights must have a finite total`)
  }
}

function assertRuntimeTrigger(
  trigger: Record<string, unknown>,
  label: string,
  actionIds: Set<string>,
  hitAreaIds: Set<string>,
  semanticBindings: Set<string>,
) {
  if (trigger.type === 'interval') {
    assertAllowedKeys(trigger, ['id', 'moduleId', 'type', 'delayMs', 'choices'], label)
    assertTimerRange(trigger.delayMs, `${label}.delayMs`)

    if (!Array.isArray(trigger.choices) || trigger.choices.length === 0) {
      throw new TypeError(`${label}.choices must be a non-empty array`)
    }
    if (trigger.choices.length > PET_MAX_MODULE_ACTIONS) {
      throw new RangeError(`${label}.choices cannot exceed ${PET_MAX_MODULE_ACTIONS}`)
    }

    const choiceIds = new Set<string>()
    let totalWeight = 0

    for (const [index, choice] of trigger.choices.entries()) {
      const choiceLabel = `${label}.choices[${index}]`

      assertRecord(choice, choiceLabel)
      assertAllowedKeys(choice, ['actionId', 'weight'], choiceLabel)
      assertActionReference(choice.actionId, actionIds, `${choiceLabel}.actionId`)

      if (choiceIds.has(choice.actionId)) {
        throw new TypeError(`${choiceLabel}.actionId must be unique`)
      }

      choiceIds.add(choice.actionId)
      assertPositiveNumber(choice.weight, `${choiceLabel}.weight`)
      totalWeight += choice.weight
    }

    if (!Number.isFinite(totalWeight)) {
      throw new RangeError(`${label}.choice weights must have a finite total`)
    }

    return
  }

  if (trigger.type === 'idle') {
    assertAllowedKeys(
      trigger,
      ['id', 'moduleId', 'type', 'afterMs', 'repeatMs', 'actionId', 'oncePerIdle'],
      label,
    )
    assertPositiveTimerDelay(trigger.afterMs, `${label}.afterMs`)
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)
    assertBoolean(trigger.oncePerIdle, `${label}.oncePerIdle`)

    if (trigger.repeatMs !== void 0) assertTimerRange(trigger.repeatMs, `${label}.repeatMs`)
    if (trigger.oncePerIdle && trigger.repeatMs !== void 0) {
      throw new TypeError(`${label} cannot combine oncePerIdle with repeatMs`)
    }
    if (!trigger.oncePerIdle && trigger.repeatMs === void 0) {
      throw new TypeError(`${label} requires repeatMs when oncePerIdle is false`)
    }

    return
  }

  if (trigger.type === 'schedule') {
    assertAllowedKeys(
      trigger,
      ['id', 'moduleId', 'type', 'actionId', 'time', 'dates', 'weekdays', 'catchUpMs', 'enterPet'],
      label,
    )
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)
    assertNonEmptyString(trigger.time, `${label}.time`)

    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trigger.time)) {
      throw new TypeError(`${label}.time must use HH:mm in local time`)
    }

    assertRuntimeDates(trigger.dates, `${label}.dates`)
    assertRuntimeWeekdays(trigger.weekdays, `${label}.weekdays`)
    assertBoundedNumber(
      trigger.catchUpMs,
      0,
      PET_MAX_SCHEDULE_CATCH_UP_MS,
      `${label}.catchUpMs`,
    )
    assertBoolean(trigger.enterPet, `${label}.enterPet`)

    return
  }

  if (trigger.type === 'session') {
    assertAllowedKeys(
      trigger,
      ['id', 'moduleId', 'type', 'actionId', 'event', 'delayMs', 'catchUpMs', 'enterPet'],
      label,
    )
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)
    if (trigger.event !== 'startup') throw new TypeError(`${label}.event must be startup`)
    assertTimerRange(trigger.delayMs, `${label}.delayMs`)
    assertBoundedNumber(
      trigger.catchUpMs,
      PET_MIN_TIMER_DRIVEN_CATCH_UP_MS,
      PET_MAX_SCHEDULE_CATCH_UP_MS,
      `${label}.catchUpMs`,
    )
    assertBoolean(trigger.enterPet, `${label}.enterPet`)

    return
  }

  if (trigger.type === 'visibility-return') {
    assertAllowedKeys(
      trigger,
      [
        'id',
        'moduleId',
        'type',
        'actionId',
        'minAwayMs',
        'maxAwayMs',
        'settleMs',
        'catchUpMs',
        'enterPet',
      ],
      label,
    )
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)
    assertPositiveTimerDelay(trigger.minAwayMs, `${label}.minAwayMs`)
    if (trigger.maxAwayMs !== void 0) {
      assertPositiveTimerDelay(trigger.maxAwayMs, `${label}.maxAwayMs`)
      if (trigger.maxAwayMs <= trigger.minAwayMs) {
        throw new RangeError(`${label}.maxAwayMs must be greater than minAwayMs`)
      }
    }
    assertNonNegativeTimerDelay(trigger.settleMs, `${label}.settleMs`)
    assertBoundedNumber(
      trigger.catchUpMs,
      PET_MIN_TIMER_DRIVEN_CATCH_UP_MS,
      PET_MAX_SCHEDULE_CATCH_UP_MS,
      `${label}.catchUpMs`,
    )
    assertBoolean(trigger.enterPet, `${label}.enterPet`)

    return
  }

  if (trigger.type === 'activity-burst') {
    assertAllowedKeys(
      trigger,
      [
        'id',
        'moduleId',
        'type',
        'actionId',
        'sources',
        'windowMs',
        'minimumEvents',
        'quietMs',
        'catchUpMs',
        'enterPet',
      ],
      label,
    )
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)
    assertRuntimeActivitySources(trigger.sources, `${label}.sources`)
    assertPositiveTimerDelay(trigger.windowMs, `${label}.windowMs`)
    assertBoundedInteger(trigger.minimumEvents, 2, 256, `${label}.minimumEvents`)
    assertPositiveTimerDelay(trigger.quietMs, `${label}.quietMs`)
    if (trigger.quietMs >= trigger.windowMs) {
      throw new RangeError(`${label}.quietMs must be less than windowMs`)
    }
    assertBoundedNumber(
      trigger.catchUpMs,
      PET_MIN_TIMER_DRIVEN_CATCH_UP_MS,
      PET_MAX_SCHEDULE_CATCH_UP_MS,
      `${label}.catchUpMs`,
    )
    assertBoolean(trigger.enterPet, `${label}.enterPet`)

    return
  }

  if (trigger.type === 'active-session') {
    assertAllowedKeys(
      trigger,
      [
        'id',
        'moduleId',
        'type',
        'actionId',
        'sources',
        'afterMs',
        'resetAfterMs',
        'repeatMs',
        'quietMs',
        'catchUpMs',
        'enterPet',
      ],
      label,
    )
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)
    assertRuntimeActivitySources(trigger.sources, `${label}.sources`)
    assertPositiveTimerDelay(trigger.afterMs, `${label}.afterMs`)
    assertPositiveTimerDelay(trigger.resetAfterMs, `${label}.resetAfterMs`)
    if (trigger.repeatMs !== void 0) {
      assertPositiveTimerDelay(trigger.repeatMs, `${label}.repeatMs`)
    }
    assertPositiveTimerDelay(trigger.quietMs, `${label}.quietMs`)
    if (trigger.quietMs >= trigger.resetAfterMs) {
      throw new RangeError(`${label}.quietMs must be less than resetAfterMs`)
    }
    assertBoundedNumber(
      trigger.catchUpMs,
      PET_MIN_TIMER_DRIVEN_CATCH_UP_MS,
      PET_MAX_SCHEDULE_CATCH_UP_MS,
      `${label}.catchUpMs`,
    )
    assertBoolean(trigger.enterPet, `${label}.enterPet`)

    return
  }

  if (trigger.type === 'daily-window') {
    assertAllowedKeys(
      trigger,
      [
        'id',
        'moduleId',
        'type',
        'actionId',
        'startTime',
        'endTime',
        'dates',
        'weekdays',
        'catchUpMs',
        'enterPet',
      ],
      label,
    )
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)
    assertNonEmptyString(trigger.startTime, `${label}.startTime`)
    assertNonEmptyString(trigger.endTime, `${label}.endTime`)
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trigger.startTime)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trigger.endTime)) {
      throw new TypeError(`${label} times must use HH:mm in local time`)
    }
    if (trigger.startTime === trigger.endTime) {
      throw new RangeError(`${label}.startTime and endTime must be different`)
    }
    assertRuntimeDates(trigger.dates, `${label}.dates`)
    assertRuntimeWeekdays(trigger.weekdays, `${label}.weekdays`)
    assertNonNegativeTimerDelay(trigger.catchUpMs, `${label}.catchUpMs`)
    assertBoolean(trigger.enterPet, `${label}.enterPet`)

    return
  }

  if (trigger.type === 'manual') {
    assertAllowedKeys(
      trigger,
      ['id', 'moduleId', 'type', 'actionId', 'label', 'group', 'order', 'enterPet'],
      label,
    )
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)
    assertLocalizedText(trigger.label, `${label}.label`)
    if (trigger.group !== void 0) assertLocalizedText(trigger.group, `${label}.group`)
    assertBoundedInteger(trigger.order, -10_000, 10_000, `${label}.order`)
    assertBoolean(trigger.enterPet, `${label}.enterPet`)

    return
  }

  if (trigger.type === 'pointer') {
    assertAllowedKeys(
      trigger,
      ['id', 'moduleId', 'type', 'actionId', 'event', 'area', 'holdMs', 'distance', 'windowMs'],
      label,
    )
    assertActionReference(trigger.actionId, actionIds, `${label}.actionId`)

    if (trigger.event !== 'hover' && trigger.event !== 'tap' && trigger.event !== 'stroke') {
      throw new TypeError(`${label}.event must be hover, tap, or stroke`)
    }

    assertNonEmptyString(trigger.area, `${label}.area`)
    if (!hitAreaIds.has(trigger.area)) {
      throw new TypeError(`${label}.area references an unknown hit area`)
    }

    const semanticBinding = `${trigger.event}:${trigger.area}`

    if (semanticBindings.has(semanticBinding)) {
      throw new TypeError(`${label} duplicates the ${semanticBinding} interaction`)
    }

    semanticBindings.add(semanticBinding)

    if (trigger.holdMs !== void 0) {
      assertPositiveTimerDelay(trigger.holdMs, `${label}.holdMs`)
    }
    if (trigger.distance !== void 0) {
      assertPositiveNumber(trigger.distance, `${label}.distance`)
    }
    if (trigger.windowMs !== void 0) {
      assertPositiveTimerDelay(trigger.windowMs, `${label}.windowMs`)
    }

    if (trigger.event === 'hover'
      && (trigger.distance !== void 0 || trigger.windowMs !== void 0)) {
      throw new TypeError(`${label} hover does not support distance or windowMs`)
    }
    if (trigger.event === 'stroke' && trigger.holdMs !== void 0) {
      throw new TypeError(`${label} stroke does not support holdMs`)
    }
    if (trigger.event === 'tap'
      && trigger.distance !== void 0
      && trigger.distance > PET_MAX_TAP_DISTANCE) {
      throw new RangeError(`${label}.distance cannot exceed ${PET_MAX_TAP_DISTANCE}`)
    }
    if (trigger.event === 'tap'
      && trigger.holdMs !== void 0
      && trigger.windowMs !== void 0
      && trigger.holdMs >= trigger.windowMs) {
      throw new RangeError(`${label}.holdMs must be less than windowMs`)
    }

    return
  }

  throw new TypeError(`${label}.type is unsupported`)
}

function assertRuntimeActivitySources(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new TypeError(`${label} must contain between one and three sources`)
  }

  const sources = new Set<string>()

  for (const source of value) {
    if (source !== 'keyboard' && source !== 'mouse' && source !== 'gamepad') {
      throw new TypeError(`${label} only supports keyboard, mouse, and gamepad`)
    }
    if (sources.has(source)) throw new TypeError(`${label} cannot contain duplicates`)
    sources.add(source)
  }
}

function assertRuntimeDates(value: unknown, label: string) {
  if (value === void 0) return
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  if (value.length > 366) throw new RangeError(`${label} cannot exceed 366 dates`)

  const dates = new Set<string>()

  for (const [index, date] of value.entries()) {
    const dateLabel = `${label}[${index}]`

    assertNonEmptyString(date, dateLabel)

    const match = /^(\d{4}|\*)-(\d{2})-(\d{2})$/.exec(date)

    if (!match) throw new TypeError(`${dateLabel} must use YYYY-MM-DD or *-MM-DD`)

    // 通配日期用闰年 2000 验证，允许合法的 *-02-29；实际触发仍按当前本地年份匹配。
    const year = match[1] === '*' ? 2000 : Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const parsed = new Date(Date.UTC(year, month - 1, day))

    if (parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day) {
      throw new RangeError(`${dateLabel} is not a real calendar date`)
    }
    if (dates.has(date)) throw new TypeError(`${label} cannot contain duplicates`)

    dates.add(date)
  }
}

function assertRuntimeWeekdays(value: unknown, label: string) {
  if (value === void 0) return
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  if (value.length > 7) throw new RangeError(`${label} cannot exceed 7 weekdays`)

  const weekdays = new Set<number>()

  for (const [index, weekday] of value.entries()) {
    assertBoundedInteger(weekday, 1, 7, `${label}[${index}]`)
    if (weekdays.has(weekday)) throw new TypeError(`${label} cannot contain duplicates`)

    weekdays.add(weekday)
  }
}

function assertLocalizedText(value: unknown, label: string): asserts value is PetLocalizedText {
  if (typeof value === 'string') {
    assertDisplayText(value, label)

    return
  }

  assertRecord(value, label)
  const entries = Object.entries(value)

  if (entries.length === 0) throw new TypeError(`${label} cannot be empty`)
  if (entries.length > PET_MAX_LOCALIZED_VARIANTS) {
    throw new RangeError(`${label} cannot exceed ${PET_MAX_LOCALIZED_VARIANTS} locales`)
  }

  for (const [locale, text] of entries) {
    if (!PET_LOCALE_PATTERN.test(locale)) throw new TypeError(`${label} has an invalid locale`)

    assertDisplayText(text, `${label}.${locale}`)
  }
}

function assertDisplayText(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label)

  if (value.length > PET_MAX_TEXT_LENGTH) {
    throw new RangeError(`${label} cannot exceed ${PET_MAX_TEXT_LENGTH} characters`)
  }
}

function assertQualifiedId(value: unknown, moduleId: string, label: string): asserts value is string {
  assertNonEmptyString(value, label)

  const prefix = `${moduleId}/`

  if (!value.startsWith(prefix)) throw new TypeError(`${label} must be qualified by its module`)

  assertSafeId(value.slice(prefix.length), label)
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label)

  if (value.length > PET_MAX_ID_LENGTH
    || value !== value.toLowerCase()
    || !PET_SAFE_ID_PATTERN.test(value)
    || PET_RESERVED_IDS.has(value.toLowerCase())) {
    throw new TypeError(`${label} is not a safe identifier`)
  }
}

function assertActionReference(
  value: unknown,
  actionIds: Set<string>,
  label: string,
): asserts value is string {
  assertNonEmptyString(value, label)

  if (!actionIds.has(value)) throw new TypeError(`${label} references an unknown action`)
}

function assertTimerRange(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${label} must contain exactly two timer values`)
  }

  assertPositiveTimerDelay(value[0], `${label}[0]`)
  assertPositiveTimerDelay(value[1], `${label}[1]`)

  if (value[0] > value[1]) throw new RangeError(`${label} minimum cannot exceed maximum`)
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const allowedKeys = new Set(allowed)

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${label}.${key} is not supported`)
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
}

function assertBoundedInteger(value: unknown, minimum: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
}

function assertBoundedNumber(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`)
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
