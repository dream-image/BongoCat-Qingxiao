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
  inputStatus: 'unavailable',
  mouseInteractions: true,
}

export const PET_MAX_TAP_DISTANCE = 6
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
  private lifecycleGeneration = 0
  private playbackGeneration = 0
  private started = false
  private destroyed = false
  private lastAutonomousAction: string | undefined
  private readonly cooldowns = new Map<string, number>()
  private readonly activeKeyboardInputs = new Set<string>()
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
      if (!this.context.visible && this.defaultAnimation) {
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

    const activationDelayChanged = 'activationDelayMs' in patch

    const wasOperational = this.canRun()
    const wasInPetMode = this.currentState !== 'work-idle'

    if (patch.enabled !== void 0) this.context.enabled = patch.enabled
    if (patch.visible !== void 0) this.context.visible = patch.visible
    if (patch.inputStatus !== void 0) {
      this.context.inputStatus = patch.inputStatus

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
      this.invalidate()
      this.exitingPromise = null

      if (wasInPetMode && this.behaviorConfig) {
        if (!this.context.visible && this.defaultAnimation) {
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
      this.clearActivationTimer()

      if (this.currentState !== 'work-idle' && this.canRunWithoutKeyboardInput()) {
        void this.exitForInput()
      }

      return
    }

    if (hadActiveInputs && this.currentState === 'work-idle' && this.canRun()) {
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
    return this.canRunWithoutKeyboardInput() && this.activeKeyboardInputs.size === 0
  }

  private canRunWithoutKeyboardInput() {
    return Boolean(
      this.behaviorConfig
      && this.started
      && this.context.enabled
      && this.context.visible
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

  assertRecord(value, 'Pet behavior')
  assertPositiveTimerDelay(value.activationDelayMs, 'Pet behavior activationDelayMs')
  assertNonEmptyString(value.enterAnimation, 'Pet behavior enterAnimation')
  assertNonEmptyString(value.idleAnimation, 'Pet behavior idleAnimation')
  assertNonEmptyString(value.exitAnimation, 'Pet behavior exitAnimation')
  assertAnimation(value.enterAnimation, false, context, 'Pet behavior enterAnimation')
  assertAnimation(value.idleAnimation, true, context, 'Pet behavior idleAnimation')
  assertAnimation(value.exitAnimation, false, context, 'Pet behavior exitAnimation')

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
