export type PetStateScene = 'work' | 'pet'

export interface PetStateDimensionConfig {
  initial: string
  values: string[]
}

export interface PetStateDailyWindowConfig {
  startTime: string
  endTime: string
  dates?: string[]
  weekdays?: number[]
}

export interface PetStateRuleConditionConfig {
  scene?: PetStateScene
  idleForMs?: number
  dailyWindow?: PetStateDailyWindowConfig
}

export interface PetStateRuleConfig {
  id: string
  priority: number
  when: PetStateRuleConditionConfig
  set: Record<string, string>
}

export interface PetVisualProfileConfig {
  id: string
  priority: number
  scene: PetStateScene
  match: Record<string, string>
  animation: string
}

export interface PetStateMachineConfig {
  dimensions: Record<string, PetStateDimensionConfig>
  profiles: PetVisualProfileConfig[]
  rules: PetStateRuleConfig[]
}

export type PetStateEffectLifetime
  = | { type: 'session' }
    | { type: 'duration', durationMs: number }
    | { type: 'until-input' }

export interface PetStateEffectConfig {
  when: 'started' | 'finished'
  priority: number
  set: Record<string, string>
  lifetime: PetStateEffectLifetime
}

// 同一个语义 action 可以按人物当前状态选择不同完整雪碧图；该配置只决定像素资源，
// 不改变 action 的 id、冷却、优先级、对白、音频或 stateEffect 提交时机。
export interface PetStateAnimationVariantConfig {
  priority: number
  match: Record<string, string>
  animation: string
}

export interface PetCharacterStateContext {
  scene: PetStateScene
  now: number
  wallNow: number
  idleForMs: number
}

export interface PetCharacterStateSnapshot {
  scene: PetStateScene
  values: Readonly<Record<string, string>>
  revision: number
  changedAt: number
}

export interface PetCharacterStateEvaluation {
  snapshot: PetCharacterStateSnapshot
  profile?: PetVisualProfileConfig
  changed: boolean
}

interface PetStateAssignment {
  value: string
  priority: number
  sequence: number
  expiresAt?: number
  clearOnInput: boolean
}

interface PetStateCandidate {
  value: string
  priority: number
  sequence: number
}

// action effect 必须稳定压过环境 rule；同一层仍由模型的 0..99 局部 priority 决定。
// scene/input 等系统事实不作为 assignment，而是直接进入 evaluation context，避免模型反转安全门禁。
const PET_ACTION_STATE_PRIORITY_BASE = 10_000

export class PetCharacterStateResolver {
  private config: PetStateMachineConfig | undefined
  private readonly assignments = new Map<string, PetStateAssignment>()
  private sequence = 0
  private snapshot: PetCharacterStateSnapshot = {
    scene: 'work',
    values: Object.freeze({}),
    revision: 0,
    changedAt: 0,
  }

  public constructor(config?: PetStateMachineConfig) {
    this.configure(config)
  }

  public configure(config?: PetStateMachineConfig, context?: PetCharacterStateContext) {
    this.config = config
    this.assignments.clear()
    this.sequence = 0
    this.snapshot = {
      scene: context?.scene ?? 'work',
      values: Object.freeze(this.initialValues()),
      revision: 0,
      changedAt: context?.now ?? 0,
    }

    if (context) return this.evaluate(context)

    return {
      snapshot: this.snapshot,
      profile: this.resolveProfile(this.snapshot.scene, this.snapshot.values),
      changed: false,
    }
  }

  public get current() {
    return this.snapshot
  }

  public applyEffect(
    effect: PetStateEffectConfig,
    context: PetCharacterStateContext,
  ) {
    for (const [dimension, value] of Object.entries(effect.set)) {
      this.assertStateValue(dimension, value)

      const assignment: PetStateAssignment = {
        value,
        priority: PET_ACTION_STATE_PRIORITY_BASE + effect.priority,
        sequence: ++this.sequence,
        clearOnInput: effect.lifetime.type === 'until-input',
      }

      if (effect.lifetime.type === 'duration') {
        assignment.expiresAt = context.now + effect.lifetime.durationMs
      }

      // 每个维度只保留最后一次显式 action assignment；新情绪或形态自然替换旧值，
      // 不建立容易恢复到过期状态的历史栈。
      this.assignments.set(dimension, assignment)
    }

    return this.evaluate(context)
  }

  public clearUntilInput(context: PetCharacterStateContext) {
    for (const [dimension, assignment] of this.assignments) {
      if (assignment.clearOnInput) this.assignments.delete(dimension)
    }

    return this.evaluate(context)
  }

  public evaluate(context: PetCharacterStateContext): PetCharacterStateEvaluation {
    this.removeExpiredAssignments(context.now)

    const values = this.initialValues()
    const candidates = new Map<string, PetStateCandidate>()

    for (const [dimension, value] of Object.entries(values)) {
      candidates.set(dimension, {
        value,
        priority: Number.NEGATIVE_INFINITY,
        sequence: -1,
      })
    }

    for (const [index, rule] of (this.config?.rules ?? []).entries()) {
      if (!matchesStateRule(rule.when, context)) continue

      for (const [dimension, value] of Object.entries(rule.set)) {
        const current = candidates.get(dimension)
        const candidate = { value, priority: rule.priority, sequence: -index }

        // 相同 priority 时保留 manifest 中更早的 rule，使结果与文件顺序稳定且可读。
        if (!current || isCandidateHigher(candidate, current)) candidates.set(dimension, candidate)
      }
    }

    for (const [dimension, assignment] of this.assignments) {
      const current = candidates.get(dimension)
      const candidate = {
        value: assignment.value,
        priority: assignment.priority,
        sequence: assignment.sequence,
      }

      if (!current || isCandidateHigher(candidate, current)) candidates.set(dimension, candidate)
    }

    for (const [dimension, candidate] of candidates) values[dimension] = candidate.value

    const changed = context.scene !== this.snapshot.scene
      || !sameStateValues(values, this.snapshot.values)

    if (changed) {
      this.snapshot = {
        scene: context.scene,
        values: Object.freeze(values),
        revision: this.snapshot.revision + 1,
        changedAt: context.now,
      }
    }

    return {
      snapshot: this.snapshot,
      profile: this.resolveProfile(context.scene, values),
      changed,
    }
  }

  public nextEvaluationDelay(context: PetCharacterStateContext) {
    let nextAt = Number.POSITIVE_INFINITY

    for (const assignment of this.assignments.values()) {
      if (assignment.expiresAt !== undefined && assignment.expiresAt > context.now) {
        nextAt = Math.min(nextAt, assignment.expiresAt - context.now)
      }
    }

    for (const rule of this.config?.rules ?? []) {
      if (rule.when.scene !== undefined && rule.when.scene !== context.scene) continue

      if (rule.when.idleForMs !== undefined && context.idleForMs < rule.when.idleForMs) {
        nextAt = Math.min(nextAt, rule.when.idleForMs - context.idleForMs)
      }

      if (rule.when.dailyWindow) {
        const boundaryDelay = nextDailyWindowBoundaryDelay(rule.when.dailyWindow, context.wallNow)

        if (boundaryDelay !== undefined) nextAt = Math.min(nextAt, boundaryDelay)
      }
    }

    return Number.isFinite(nextAt) ? Math.max(0, nextAt) : undefined
  }

  private initialValues() {
    return Object.fromEntries(
      Object.entries(this.config?.dimensions ?? {}).map(([dimension, config]) => {
        return [dimension, config.initial]
      }),
    )
  }

  private resolveProfile(scene: PetStateScene, values: Readonly<Record<string, string>>) {
    const profiles = (this.config?.profiles ?? [])
      .map((profile, index) => ({ profile, index }))
      .filter(({ profile }) => profile.scene === scene
        && Object.entries(profile.match).every(([dimension, value]) => values[dimension] === value))
      .sort((left, right) => {
        return right.profile.priority - left.profile.priority
          || Object.keys(right.profile.match).length - Object.keys(left.profile.match).length
          || left.index - right.index
      })

    return profiles[0]?.profile
  }

  private removeExpiredAssignments(now: number) {
    for (const [dimension, assignment] of this.assignments) {
      if (assignment.expiresAt !== undefined && assignment.expiresAt <= now) {
        this.assignments.delete(dimension)
      }
    }
  }

  private assertStateValue(dimension: string, value: string) {
    const dimensionConfig = this.config?.dimensions[dimension]

    if (!dimensionConfig || !dimensionConfig.values.includes(value)) {
      throw new TypeError(`Unknown pet state value ${dimension}=${value}`)
    }
  }
}

function isCandidateHigher(candidate: PetStateCandidate, current: PetStateCandidate) {
  return candidate.priority > current.priority
    || (candidate.priority === current.priority && candidate.sequence > current.sequence)
}

function sameStateValues(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) {
  const leftEntries = Object.entries(left)
  const rightKeys = Object.keys(right)

  return leftEntries.length === rightKeys.length
    && leftEntries.every(([dimension, value]) => right[dimension] === value)
}

function matchesStateRule(
  condition: PetStateRuleConditionConfig,
  context: PetCharacterStateContext,
) {
  if (condition.scene !== undefined && condition.scene !== context.scene) return false
  if (condition.idleForMs !== undefined && context.idleForMs < condition.idleForMs) return false
  if (condition.dailyWindow
    && !isWithinDailyWindow(condition.dailyWindow, context.wallNow)) {
    return false
  }

  return true
}

function isWithinDailyWindow(config: PetStateDailyWindowConfig, wallNow: number) {
  const now = new Date(wallNow)

  // 跨午夜窗口可能由今天或昨天作为起始日；两次投影覆盖 23:00→06:30 这类场景。
  for (const dayOffset of [-1, 0]) {
    const interval = projectDailyWindow(config, now, dayOffset)

    if (interval && wallNow >= interval.start && wallNow < interval.end) return true
  }

  return false
}

function nextDailyWindowBoundaryDelay(config: PetStateDailyWindowConfig, wallNow: number) {
  const now = new Date(wallNow)
  let nextBoundary = Number.POSITIVE_INFINITY

  // dates 最多在校验层受限；向后一天覆盖正在进行的跨午夜窗口，向前八天覆盖完整星期。
  for (let dayOffset = -1; dayOffset <= 8; dayOffset++) {
    const interval = projectDailyWindow(config, now, dayOffset)

    if (!interval) continue
    if (interval.start > wallNow) nextBoundary = Math.min(nextBoundary, interval.start)
    if (interval.end > wallNow) nextBoundary = Math.min(nextBoundary, interval.end)
  }

  return Number.isFinite(nextBoundary) ? nextBoundary - wallNow : undefined
}

function projectDailyWindow(
  config: PetStateDailyWindowConfig,
  reference: Date,
  dayOffset: number,
) {
  const anchor = new Date(reference)

  anchor.setHours(0, 0, 0, 0)
  anchor.setDate(anchor.getDate() + dayOffset)

  if (!matchesDailyWindowDate(config, anchor)) return undefined

  const startMinutes = parseClockTime(config.startTime)
  const endMinutes = parseClockTime(config.endTime)
  const start = new Date(anchor)
  const end = new Date(anchor)

  start.setMinutes(startMinutes)
  end.setMinutes(endMinutes)

  if (endMinutes <= startMinutes) end.setDate(end.getDate() + 1)

  return { start: start.getTime(), end: end.getTime() }
}

function matchesDailyWindowDate(config: PetStateDailyWindowConfig, anchor: Date) {
  if (config.weekdays && !config.weekdays.includes(anchor.getDay())) return false

  if (config.dates) {
    const dateKey = [
      anchor.getFullYear(),
      String(anchor.getMonth() + 1).padStart(2, '0'),
      String(anchor.getDate()).padStart(2, '0'),
    ].join('-')

    if (!config.dates.includes(dateKey)) return false
  }

  return true
}

function parseClockTime(value: string) {
  const [hours = 0, minutes = 0] = value.split(':').map(Number)

  return hours * 60 + minutes
}
