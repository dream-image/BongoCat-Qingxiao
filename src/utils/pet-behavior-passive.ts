import type { PetRuntimeTrigger } from './pet-behavior-module'

import {
  delayUntilNextScheduleScan,
  findDuePetDailyWindowOccurrence,
  samplePetDailyWindowDueAt,
} from './pet-behavior-scheduler'

export type ActivitySource = 'keyboard' | 'mouse' | 'gamepad'

export interface PetPassiveActivitySignal {
  source: ActivitySource
  inputId: string
  phase: 'start' | 'end' | 'pulse'
}

export interface PetPassiveOccurrence {
  key: string
  triggerId: string
  actionId: string
  source:
    | 'session'
    | 'visibility-return'
    | 'activity-burst'
    | 'active-session'
    | 'daily-window'
  enterPet: boolean
  dueAt: number
  expiresAt: number
  sequence: number
}

export interface PetPassiveActiveInput {
  source: ActivitySource
  inputId: string
}

type PetPassiveTimer = ReturnType<typeof globalThis.setTimeout>

export interface PetPassiveClock {
  now: () => number
  wallNow?: () => number
  setTimeout: (callback: () => void, delayMs: number) => PetPassiveTimer
  clearTimeout: (timer: PetPassiveTimer) => void
}

export interface PetPassiveTriggerEngineDependencies {
  clock: PetPassiveClock
  random: () => number
  onOccurrence: (occurrence: PetPassiveOccurrence) => void
}

type PassiveTriggerType = PetPassiveOccurrence['source']
type PassiveTrigger = Extract<PetRuntimeTrigger, { type: PassiveTriggerType }>
type SessionTrigger = Extract<PassiveTrigger, { type: 'session' }>
type VisibilityReturnTrigger = Extract<PassiveTrigger, { type: 'visibility-return' }>
type ActivityBurstTrigger = Extract<PassiveTrigger, { type: 'activity-burst' }>
type ActiveSessionTrigger = Extract<PassiveTrigger, { type: 'active-session' }>
type DailyWindowTrigger = Extract<PassiveTrigger, { type: 'daily-window' }>

interface TimerRecord {
  handle: PetPassiveTimer
  generation: number
  token: object
}

interface SessionState {
  dueAt: number
  expiresAt: number
  consumed: boolean
}

interface VisibilityCandidate {
  epoch: number
  dueAt: number
  expiresAt: number
}

interface ActivityBurstCandidate {
  epoch: number
  dueAt: number
  expiresAt: number
}

interface ActivityBurstState {
  timestamps: number[]
  candidate?: ActivityBurstCandidate
}

interface ActiveSessionCandidate {
  epoch: number
  thresholdIndex: number
  dueAt: number
  expiresAt: number
}

interface ActiveSessionState {
  epoch: number
  startedAt?: number
  lastAt?: number
  nextThresholdIndex: number
  candidate?: ActiveSessionCandidate
}

const DAY_MS = 86_400_000
// 长会话会持续产生日期 occurrence 与输入采样；硬上限避免历史集合和滑动窗口无界增长。
const MAX_DAILY_HISTORY = 4_096
const MAX_ACTIVITY_TIMESTAMPS = 256

export class PetPassiveTriggerEngine {
  private readonly clock: PetPassiveClock
  private readonly random: () => number
  private readonly onOccurrence: (occurrence: PetPassiveOccurrence) => void
  private readonly sessionStartedAt: number
  private readonly sessionKey: string
  private triggers: PassiveTrigger[] = []
  private readonly timers = new Map<string, TimerRecord>()
  private readonly sessionStates = new Map<string, SessionState>()
  private readonly visibilityCandidates = new Map<string, VisibilityCandidate>()
  private readonly burstStates = new Map<string, ActivityBurstState>()
  private readonly activeSessionStates = new Map<string, ActiveSessionState>()
  private readonly burstEpochs = new Map<string, number>()
  private readonly activeSessionEpochs = new Map<string, number>()
  private readonly activeInputs = new Set<string>()
  private readonly dailySamples = new Map<string, number>()
  private readonly consumedDailyOccurrences = new Set<string>()
  private scopeId = 'default'
  private presenceVisible: boolean | undefined
  private awaySinceWall: number | undefined
  private visibilityEpoch = 0
  private dailyEpoch = 0
  private generation = 0
  private sequence = 0
  private operational = false
  private paused = false
  private pausedAt: number | undefined
  private accumulatedPausedMs = 0
  private destroyed = false

  public constructor(dependencies: PetPassiveTriggerEngineDependencies) {
    this.clock = dependencies.clock
    this.random = dependencies.random
    this.onOccurrence = dependencies.onOccurrence
    this.sessionStartedAt = this.logicalNow()
    this.sessionKey = String(this.clock.now())
  }

  public get hasActiveInputs() {
    return this.activeInputs.size > 0
  }

  public configure(triggers: Iterable<PetRuntimeTrigger>, scopeId = 'default') {
    if (this.destroyed) return

    this.generation += 1
    this.dailyEpoch += 1
    this.cancelAllTimers()
    this.scopeId = scopeId
    this.triggers = Array.from(triggers).filter(isPassiveTrigger)

    // 输入事件候选依赖旧阈值和旧来源，配置切换后继续沿用会把两套规则拼成一次动作。
    this.visibilityCandidates.clear()
    this.burstStates.clear()
    this.activeSessionStates.clear()

    // session/当日窗口以 scope 为键跨 configure 保留，这是切回同一模型时
    // 不重播 startup、不重抽当日到期时刻的运行期去重凭据。

    for (const trigger of this.sessionTriggers()) this.ensureSessionState(trigger)

    this.scheduleAll()
  }

  public setOperational(operational: boolean) {
    if (this.destroyed || this.operational === operational) return

    this.operational = operational

    if (!operational) {
      // 非运行态只停止观察；session/久别归来的候选仍可在 catch-up 窗口内恢复。
      this.cancelAllTimers()
      return
    }

    this.scheduleAll()
  }

  public setPaused(paused: boolean) {
    if (this.destroyed || this.paused === paused) return

    if (paused) {
      this.pausedAt = this.clock.now()
      this.paused = true
      this.cancelAllTimers()
      return
    }

    const rawNow = this.clock.now()
    const pausedAt = this.pausedAt ?? rawNow

    // 逻辑单调时钟扣除暂停段，因此所有 quiet/settle 剩余量都会冻结，日历墙钟则继续前进。
    this.accumulatedPausedMs += Math.max(0, rawNow - pausedAt)
    this.pausedAt = void 0
    this.paused = false
    this.scheduleAll()
  }

  public setPresenceVisible(visible: boolean) {
    if (this.destroyed || this.presenceVisible === visible) return

    const wallNow = this.wallNow()
    const previous = this.presenceVisible

    this.presenceVisible = visible

    if (!visible) {
      this.awaySinceWall = wallNow
      this.visibilityEpoch += 1
      this.visibilityCandidates.clear()
      this.cancelTimersWithPrefix('visibility:')
      return
    }

    if (previous !== false || this.awaySinceWall === undefined) return

    const awayMs = wallNow - this.awaySinceWall
    const epoch = this.visibilityEpoch

    this.awaySinceWall = void 0

    // 墙钟回拨无法证明真实离开时长，直接丢弃比误报一次“欢迎回来”更可控。
    if (awayMs < 0) return

    const now = this.logicalNow()

    for (const trigger of this.visibilityTriggers()) {
      if (awayMs < trigger.minAwayMs) continue
      // maxAwayMs 是排他的上界，使相邻“短暂离开/长时间离开”区间可以无重叠拼接。
      if (trigger.maxAwayMs !== undefined && awayMs >= trigger.maxAwayMs) continue

      const dueAt = now + trigger.settleMs

      this.visibilityCandidates.set(trigger.id, {
        epoch,
        dueAt,
        expiresAt: dueAt + trigger.catchUpMs,
      })
    }

    this.scheduleVisibilityCandidates()
  }

  public notifyActivity(signal: PetPassiveActivitySignal) {
    if (this.destroyed) return

    const inputKey = makeInputKey(signal.source, signal.inputId)
    const hadActiveInputs = this.activeInputs.size > 0
    let risingEdge = false

    if (signal.phase === 'start') {
      if (!this.activeInputs.has(inputKey)) {
        this.activeInputs.add(inputKey)
        risingEdge = true
      }
    } else if (signal.phase === 'end') {
      this.activeInputs.delete(inputKey)
    } else {
      risingEdge = true
    }

    // 暂停或输入链路不可信时仍同步 held 状态，但不能把这段信号计入行为统计。
    if (!this.operational || this.paused) return

    if (risingEdge) {
      const now = this.logicalNow()

      this.recordBurstActivity(signal.source, now)
      this.recordActiveSessionActivity(signal.source, now)
    }

    if (hadActiveInputs && this.activeInputs.size === 0) this.scheduleAll()
    else this.scheduleActivityCandidates()
  }

  public syncActiveInputs(
    inputs: Iterable<PetPassiveActiveInput>,
    sources: Iterable<ActivitySource> = ['keyboard', 'gamepad'],
  ) {
    if (this.destroyed) return

    const hadActiveInputs = this.activeInputs.size > 0
    const replacedSources = new Set(sources)

    // 键盘/手柄的全量同步不能抹掉鼠标按住状态，否则 quiet 会在拖拽中被误判成立。
    for (const inputKey of Array.from(this.activeInputs)) {
      if (replacedSources.has(inputSourceFromKey(inputKey))) this.activeInputs.delete(inputKey)
    }

    for (const input of inputs) {
      if (replacedSources.has(input.source)) {
        this.activeInputs.add(makeInputKey(input.source, input.inputId))
      }
    }

    // 同步只恢复 held 真相，不制造上升沿；释放后的 quiet 候选则可以继续结算。
    if (!this.operational || this.paused) return

    if (hadActiveInputs && this.activeInputs.size === 0) this.scheduleAll()
    else this.scheduleActivityCandidates()
  }

  public resetUntrustedInput() {
    if (this.destroyed) return

    // 监听失联时 release 事件可能永久丢失，held、burst 和 active-session 统计都已不可信；
    // 必须一起清空，不能把盲区前的输入状态带入恢复后的新会话。
    this.activeInputs.clear()
    this.burstStates.clear()
    this.activeSessionStates.clear()
    this.cancelTimersWithPrefix('burst:')
    this.cancelTimersWithPrefix('active-session:')
  }

  public destroy() {
    if (this.destroyed) return

    this.destroyed = true
    this.generation += 1
    this.cancelAllTimers()
    this.triggers = []
    this.sessionStates.clear()
    this.visibilityCandidates.clear()
    this.burstStates.clear()
    this.activeSessionStates.clear()
    this.activeInputs.clear()
    this.dailySamples.clear()
    this.consumedDailyOccurrences.clear()
  }

  private scheduleAll() {
    if (!this.canSchedule()) return

    this.scheduleSessionTriggers()
    this.scheduleVisibilityCandidates()
    this.scheduleActivityCandidates()
    this.scanDailyWindows()
  }

  private scheduleSessionTriggers() {
    if (!this.canSchedule()) return

    const now = this.logicalNow()

    for (const trigger of this.sessionTriggers()) {
      const state = this.ensureSessionState(trigger)

      if (state.consumed) continue

      // occurrence 有效期是 [dueAt, expiresAt)；先判右边界，避免恰好过期时仍进入派发分支。
      if (now >= state.expiresAt) {
        state.consumed = true
        continue
      }

      if (now >= state.dueAt) {
        if (this.activeInputs.size === 0) {
          state.consumed = true
          this.emitMonotonicOccurrence(
            trigger,
            'session',
            state.dueAt,
            state.expiresAt,
            `${this.scopeId}:${trigger.id}:session:${this.sessionKey}`,
          )
        } else if (now >= state.expiresAt) {
          state.consumed = true
        } else {
          // held 输入若提前释放会由 notifyActivity 主动重扫，否则只需在右边界醒来丢弃候选。
          this.armTimer(
            `session:${trigger.id}`,
            state.expiresAt,
            () => this.sessionStates.get(this.scopedTriggerKey(trigger.id)) === state
              && !state.consumed,
            () => this.scheduleSessionTriggers(),
          )
        }
        continue
      }

      this.armTimer(
        `session:${trigger.id}`,
        state.dueAt,
        () => this.sessionStates.get(this.scopedTriggerKey(trigger.id)) === state && !state.consumed,
        () => this.scheduleSessionTriggers(),
      )
    }
  }

  private ensureSessionState(trigger: SessionTrigger) {
    const stateKey = this.scopedTriggerKey(trigger.id)
    const existing = this.sessionStates.get(stateKey)

    if (existing) return existing

    // startup 的随机延时按 scope 只抽样一次；configure 往返同一模型不能把它伪装成新会话重播。
    const dueAt = this.sessionStartedAt + this.randomDelay(trigger.delayMs)
    const state: SessionState = {
      dueAt,
      expiresAt: dueAt + trigger.catchUpMs,
      consumed: false,
    }

    this.sessionStates.set(stateKey, state)
    return state
  }

  private scheduleVisibilityCandidates() {
    if (!this.canSchedule()) return

    const now = this.logicalNow()

    for (const trigger of this.visibilityTriggers()) {
      const candidate = this.visibilityCandidates.get(trigger.id)

      if (!candidate) continue

      if (this.presenceVisible !== true || candidate.epoch !== this.visibilityEpoch) {
        this.visibilityCandidates.delete(trigger.id)
        continue
      }

      // settle 后的候选只在 [dueAt, expiresAt) 内有效，恢复得太晚就不补播陈旧问候。
      if (now >= candidate.expiresAt) {
        this.visibilityCandidates.delete(trigger.id)
        continue
      }

      if (now >= candidate.dueAt) {
        if (this.activeInputs.size === 0) {
          this.visibilityCandidates.delete(trigger.id)
          this.emitMonotonicOccurrence(
            trigger,
            'visibility-return',
            candidate.dueAt,
            candidate.expiresAt,
            `${trigger.id}:visibility:${candidate.epoch}`,
          )
        } else if (now >= candidate.expiresAt) {
          this.visibilityCandidates.delete(trigger.id)
        } else {
          this.armTimer(
            `visibility:${trigger.id}`,
            candidate.expiresAt,
            () => this.visibilityCandidates.get(trigger.id) === candidate
              && candidate.epoch === this.visibilityEpoch,
            () => this.scheduleVisibilityCandidates(),
          )
        }
        continue
      }

      this.armTimer(
        `visibility:${trigger.id}`,
        candidate.dueAt,
        () => this.visibilityCandidates.get(trigger.id) === candidate
          && candidate.epoch === this.visibilityEpoch,
        () => this.scheduleVisibilityCandidates(),
      )
    }
  }

  private recordBurstActivity(source: ActivitySource, now: number) {
    for (const trigger of this.burstTriggers()) {
      if (!trigger.sources.includes(source)) continue

      const state = this.burstStates.get(trigger.id) ?? { timestamps: [] }

      this.burstStates.set(trigger.id, state)

      if (state.candidate && now >= state.candidate.expiresAt) {
        state.candidate = void 0
        state.timestamps = []
      }

      const cutoff = now - trigger.windowMs

      // 保留闭合采样窗 [now-windowMs, now]，恰好落在左边界的事件仍应计入本次 burst。
      state.timestamps = state.timestamps.filter(timestamp => timestamp >= cutoff)
      state.timestamps.push(now)

      if (state.timestamps.length > MAX_ACTIVITY_TIMESTAMPS) {
        state.timestamps.splice(0, state.timestamps.length - MAX_ACTIVITY_TIMESTAMPS)
      }

      if (!state.candidate && state.timestamps.length >= trigger.minimumEvents) {
        // epoch 把每次达到阈值的 burst 分开，旧 timer 即使晚到也不能消费下一轮候选。
        const epoch = (this.burstEpochs.get(trigger.id) ?? 0) + 1

        this.burstEpochs.set(trigger.id, epoch)
        state.candidate = {
          epoch,
          dueAt: now + trigger.quietMs,
          expiresAt: now + trigger.quietMs + trigger.catchUpMs,
        }
      } else if (state.candidate) {
        // burst 已达阈值后仍持续输入时，quiet 从最后一次事件重新计算。
        state.candidate.dueAt = now + trigger.quietMs
        state.candidate.expiresAt = state.candidate.dueAt + trigger.catchUpMs
      }
    }
  }

  private scheduleBurstCandidates() {
    if (!this.canSchedule()) return

    const now = this.logicalNow()

    for (const trigger of this.burstTriggers()) {
      const state = this.burstStates.get(trigger.id)
      const candidate = state?.candidate

      if (!state || !candidate) continue

      if (now >= candidate.expiresAt) {
        state.candidate = void 0
        state.timestamps = []
        continue
      }

      if (now >= candidate.dueAt && this.activeInputs.size === 0) {
        state.candidate = void 0
        state.timestamps = []
        this.emitMonotonicOccurrence(
          trigger,
          'activity-burst',
          candidate.dueAt,
          candidate.expiresAt,
          `${trigger.id}:burst:${candidate.epoch}`,
        )
        continue
      }

      const nextAt = now < candidate.dueAt
        ? candidate.dueAt
        : candidate.expiresAt

      if (nextAt <= now && this.activeInputs.size > 0) {
        state.candidate = void 0
        state.timestamps = []
        continue
      }

      this.armTimer(
        `burst:${trigger.id}`,
        nextAt,
        () => this.burstStates.get(trigger.id)?.candidate === candidate,
        () => this.scheduleBurstCandidates(),
      )
    }
  }

  private recordActiveSessionActivity(source: ActivitySource, now: number) {
    for (const trigger of this.activeSessionTriggers()) {
      if (!trigger.sources.includes(source)) continue

      const state = this.activeSessionStates.get(trigger.id) ?? {
        epoch: 0,
        nextThresholdIndex: 0,
      }

      this.activeSessionStates.set(trigger.id, state)

      if (state.candidate && now >= state.candidate.expiresAt) {
        this.consumeActiveSessionCandidate(trigger, state, state.candidate, now)
      }

      if (state.startedAt === undefined
        || state.lastAt === undefined
        || now - state.lastAt >= trigger.resetAfterMs) {
        // resetAfterMs 的右边界属于新会话；推进 epoch 可隔离上一会话仍在队列中的回调。
        const epoch = (this.activeSessionEpochs.get(trigger.id) ?? 0) + 1

        this.activeSessionEpochs.set(trigger.id, epoch)
        state.epoch = epoch
        state.startedAt = now
        state.lastAt = now
        state.nextThresholdIndex = 0
      } else {
        state.lastAt = now
      }

      if (state.candidate) {
        state.candidate.dueAt = now + trigger.quietMs
        state.candidate.expiresAt = state.candidate.dueAt + trigger.catchUpMs
      }

      this.latchActiveSessionThreshold(trigger, state, now)
    }
  }

  private scheduleActiveSessionCandidates() {
    if (!this.canSchedule()) return

    const now = this.logicalNow()

    for (const trigger of this.activeSessionTriggers()) {
      const state = this.activeSessionStates.get(trigger.id)

      if (!state) continue

      this.resetInactiveSessionIfNeeded(trigger, state, now)
      this.latchActiveSessionThreshold(trigger, state, now)

      const candidate = state.candidate

      if (candidate) {
        if (now >= candidate.expiresAt) {
          this.consumeActiveSessionCandidate(trigger, state, candidate, now)
        } else if (now >= candidate.dueAt && this.activeInputs.size === 0) {
          this.emitMonotonicOccurrence(
            trigger,
            'active-session',
            candidate.dueAt,
            candidate.expiresAt,
            `${trigger.id}:active:${candidate.epoch}:${candidate.thresholdIndex}`,
          )
          this.consumeActiveSessionCandidate(trigger, state, candidate, now)
        } else {
          const nextAt = now < candidate.dueAt
            ? candidate.dueAt
            : candidate.expiresAt

          if (nextAt > now) {
            this.armTimer(
              `active-session:candidate:${trigger.id}`,
              nextAt,
              () => this.activeSessionStates.get(trigger.id)?.candidate === candidate,
              () => this.scheduleActiveSessionCandidates(),
            )
          } else {
            this.consumeActiveSessionCandidate(trigger, state, candidate, now)
          }
        }
      }

      this.scheduleActiveSessionProgress(trigger, state, now)
    }
  }

  private latchActiveSessionThreshold(
    trigger: ActiveSessionTrigger,
    state: ActiveSessionState,
    now: number,
  ) {
    if (state.candidate || state.startedAt === undefined || state.lastAt === undefined) return

    const thresholdAt = this.activeSessionThresholdAt(trigger, state)

    if (now < thresholdAt) return

    // 达到工作时长后仍需等最后一次输入 quietMs，避免用户正在连续操作时突然插播动作。
    const dueAt = Math.max(thresholdAt, state.lastAt + trigger.quietMs)

    state.candidate = {
      epoch: state.epoch,
      thresholdIndex: state.nextThresholdIndex,
      dueAt,
      expiresAt: dueAt + trigger.catchUpMs,
    }
  }

  private resetInactiveSessionIfNeeded(
    trigger: ActiveSessionTrigger,
    state: ActiveSessionState,
    now: number,
  ) {
    if (state.lastAt === undefined || now - state.lastAt < trigger.resetAfterMs) return

    // 已跨过阈值的候选保留到 catch-up 到期；未跨阈值的连续工作 epoch 立即结束。
    state.startedAt = void 0
    state.lastAt = void 0
    state.nextThresholdIndex = 0
  }

  private consumeActiveSessionCandidate(
    trigger: ActiveSessionTrigger,
    state: ActiveSessionState,
    candidate: ActiveSessionCandidate,
    now: number,
  ) {
    if (state.candidate !== candidate) return

    state.candidate = void 0

    if (state.epoch !== candidate.epoch || state.startedAt === undefined) return

    if (trigger.repeatMs === undefined) {
      state.nextThresholdIndex = Number.POSITIVE_INFINITY
      return
    }

    const elapsedAfterFirst = Math.max(0, now - state.startedAt - trigger.afterMs)
    const firstFutureIndex = Math.floor(elapsedAfterFirst / trigger.repeatMs) + 1

    // 忙碌过久时跳到下一个未来 repeat，避免恢复后一口气补发多次旧提醒。
    state.nextThresholdIndex = Math.max(candidate.thresholdIndex + 1, firstFutureIndex)
  }

  private scheduleActiveSessionProgress(
    trigger: ActiveSessionTrigger,
    state: ActiveSessionState,
    now: number,
  ) {
    if (state.startedAt === undefined || state.lastAt === undefined) return

    const resetAt = state.lastAt + trigger.resetAfterMs
    const thresholdAt = state.candidate
      ? Number.POSITIVE_INFINITY
      : this.activeSessionThresholdAt(trigger, state)
    const nextAt = Math.min(resetAt, thresholdAt)

    if (!Number.isFinite(nextAt) || nextAt <= now) return

    const epoch = state.epoch

    this.armTimer(
      `active-session:progress:${trigger.id}`,
      nextAt,
      () => this.activeSessionStates.get(trigger.id) === state && state.epoch === epoch,
      () => this.scheduleActiveSessionCandidates(),
    )
  }

  private activeSessionThresholdAt(trigger: ActiveSessionTrigger, state: ActiveSessionState) {
    if (state.startedAt === undefined || !Number.isFinite(state.nextThresholdIndex)) {
      return Number.POSITIVE_INFINITY
    }

    if (state.nextThresholdIndex === 0) return state.startedAt + trigger.afterMs
    if (trigger.repeatMs === undefined) return Number.POSITIVE_INFINITY

    return state.startedAt + trigger.afterMs + trigger.repeatMs * state.nextThresholdIndex
  }

  private scheduleActivityCandidates() {
    this.scheduleBurstCandidates()
    this.scheduleActiveSessionCandidates()
  }

  private scanDailyWindows() {
    if (!this.canSchedule()) return

    const triggers = this.dailyWindowTriggers()

    // 没有日窗口的模型不需要常驻的每分钟唤醒。
    if (triggers.length === 0) {
      this.cancelTimer('daily-window:scan')

      return
    }

    const wallNow = this.wallNow()
    const monotonicNow = this.clock.now()
    const dailyEpoch = this.dailyEpoch
    const scopeId = this.scopeId
    let nextDueWall = Number.POSITIVE_INFINITY

    for (const trigger of triggers) {
      const coveredDays = Math.ceil(trigger.catchUpMs / DAY_MS) + 1

      for (let dayOffset = 0; dayOffset >= -coveredDays; dayOffset -= 1) {
        const anchor = localDayOffset(wallNow, dayOffset)
        const sampleKey = dailySampleKey(scopeId, trigger, anchor)
        let sample = this.dailySamples.get(sampleKey)

        if (sample === undefined) {
          sample = this.nextRandom()
          this.dailySamples.set(sampleKey, sample)
          trimOldest(this.dailySamples, MAX_DAILY_HISTORY)
        }

        // 用持久化 sample 先投影唯一 dueAt，再反查完整 occurrence；重复分钟扫描不会重新随机或漂移。
        const probeAt = samplePetDailyWindowDueAt(trigger, anchor, sample)

        if (probeAt === undefined) continue

        const occurrence = findDuePetDailyWindowOccurrence(trigger, probeAt, sample)

        if (!occurrence || occurrence.key !== dailyOccurrenceKey(trigger, anchor)) continue

        const occurrenceKey = `${scopeId}:${occurrence.key}`

        if (this.consumedDailyOccurrences.has(occurrenceKey)) continue
        if (wallNow < occurrence.dueAt) {
          nextDueWall = Math.min(nextDueWall, occurrence.dueAt)
          continue
        }

        if (this.activeInputs.size > 0) {
          if (wallNow < occurrence.expiresAt) {
            // 日历 occurrence 已到点但输入仍按住时只保留候选；release 会主动重扫，过期点负责最终丢弃。
            nextDueWall = Math.min(nextDueWall, occurrence.expiresAt)
            continue
          }

          this.consumedDailyOccurrences.add(occurrenceKey)
          trimOldestSet(this.consumedDailyOccurrences, MAX_DAILY_HISTORY)
          continue
        }

        // 无论是否已过右边界都在本次扫描消费，防止同一陈旧 occurrence 每分钟重复进入判定。
        this.consumedDailyOccurrences.add(occurrenceKey)
        trimOldestSet(this.consumedDailyOccurrences, MAX_DAILY_HISTORY)

        if (wallNow >= occurrence.expiresAt) continue

        // 队列等待使用单调钟：此处只把墙钟上的相对剩余量投影过去，后续系统校时不会篡改有效期。
        this.emitOccurrence({
          key: occurrenceKey,
          triggerId: trigger.id,
          actionId: trigger.actionId,
          source: 'daily-window',
          enterPet: trigger.enterPet,
          dueAt: monotonicNow - Math.max(0, wallNow - occurrence.dueAt),
          expiresAt: monotonicNow + Math.max(0, occurrence.expiresAt - wallNow),
        })
      }
    }

    if (!this.canSchedule() || dailyEpoch !== this.dailyEpoch) return

    const currentWall = this.wallNow()
    const delayMs = Math.min(
      delayUntilNextScheduleScan(currentWall),
      Math.max(0, nextDueWall - currentWall),
    )

    this.armTimer(
      'daily-window:scan',
      this.logicalNow() + delayMs,
      () => dailyEpoch === this.dailyEpoch,
      () => this.scanDailyWindows(),
    )
  }

  private emitMonotonicOccurrence(
    trigger: PassiveTrigger,
    source: PetPassiveOccurrence['source'],
    dueAt: number,
    expiresAt: number,
    key: string,
  ) {
    const logicalNow = this.logicalNow()
    const rawNow = this.clock.now()

    // logicalNow 冻结过暂停段；换回 raw 单调钟后，控制器可与自身 cooldown/队列时间直接比较。
    this.emitOccurrence({
      key,
      triggerId: trigger.id,
      actionId: trigger.actionId,
      source,
      enterPet: trigger.enterPet,
      dueAt: rawNow - Math.max(0, logicalNow - dueAt),
      expiresAt: rawNow + Math.max(0, expiresAt - logicalNow),
    })
  }

  private emitOccurrence(occurrence: Omit<PetPassiveOccurrence, 'sequence'>) {
    if (!this.canSchedule()) return

    this.sequence += 1
    this.onOccurrence({ ...occurrence, sequence: this.sequence })
  }

  private armTimer(
    key: string,
    dueAt: number,
    isCurrent: () => boolean,
    callback: () => void,
  ) {
    if (!this.canSchedule()) return

    this.cancelTimer(key)

    const generation = this.generation
    const token = {}
    const delayMs = Math.max(0, dueAt - this.logicalNow())
    const record: TimerRecord = {
      generation,
      token,
      handle: this.clock.setTimeout(() => {
        const current = this.timers.get(key)

        // clearTimeout 与已排队回调可能竞态；identity、generation、业务 epoch 三层都必须仍有效。
        if (current !== record
          || current.token !== token
          || generation !== this.generation
          || !isCurrent()) {
          return
        }

        this.timers.delete(key)

        if (!this.canSchedule()) return

        callback()
      }, delayMs),
    }

    this.timers.set(key, record)
  }

  private cancelTimer(key: string) {
    const timer = this.timers.get(key)

    if (!timer) return

    this.clock.clearTimeout(timer.handle)
    this.timers.delete(key)
  }

  private cancelTimersWithPrefix(prefix: string) {
    for (const key of Array.from(this.timers.keys())) {
      if (key.startsWith(prefix)) this.cancelTimer(key)
    }
  }

  private cancelAllTimers() {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer.handle)
    this.timers.clear()
  }

  private sessionTriggers() {
    return this.triggers.filter((trigger): trigger is SessionTrigger => trigger.type === 'session')
  }

  private visibilityTriggers() {
    return this.triggers.filter((trigger): trigger is VisibilityReturnTrigger => {
      return trigger.type === 'visibility-return'
    })
  }

  private burstTriggers() {
    return this.triggers.filter((trigger): trigger is ActivityBurstTrigger => {
      return trigger.type === 'activity-burst'
    })
  }

  private activeSessionTriggers() {
    return this.triggers.filter((trigger): trigger is ActiveSessionTrigger => {
      return trigger.type === 'active-session'
    })
  }

  private dailyWindowTriggers() {
    return this.triggers.filter((trigger): trigger is DailyWindowTrigger => {
      return trigger.type === 'daily-window'
    })
  }

  private randomDelay(range: readonly [number, number]) {
    return range[0] + (range[1] - range[0]) * this.nextRandom()
  }

  private nextRandom() {
    const value = this.random()

    if (!Number.isFinite(value)) return 0

    return Math.min(Math.max(value, 0), 1 - Number.EPSILON)
  }

  private wallNow() {
    // 单一虚拟时钟仍能完整驱动测试；生产环境则显式提供 wallNow 隔离系统日历跳变。
    return this.clock.wallNow?.() ?? this.clock.now()
  }

  private logicalNow() {
    const rawNow = this.clock.now()
    const currentPause = this.paused && this.pausedAt !== undefined
      ? Math.max(0, rawNow - this.pausedAt)
      : 0

    // 累计暂停和当前未结束暂停都从轴上扣除，使所有内部 deadline 在菜单期间保持相同剩余量。
    return rawNow - this.accumulatedPausedMs - currentPause
  }

  private canSchedule() {
    return !this.destroyed && this.operational && !this.paused
  }

  private scopedTriggerKey(triggerId: string) {
    // NUL 不可能出现在已校验 ID 中，用它分隔 scope 可避免普通字符串拼接产生碰撞。
    return `${this.scopeId}\u0000${triggerId}`
  }
}

function isPassiveTrigger(trigger: PetRuntimeTrigger): trigger is PassiveTrigger {
  return trigger.type === 'session'
    || trigger.type === 'visibility-return'
    || trigger.type === 'activity-burst'
    || trigger.type === 'active-session'
    || trigger.type === 'daily-window'
}

function makeInputKey(source: ActivitySource, inputId: string) {
  // source 与 NUL 分隔符让同名键盘、鼠标、手柄输入拥有独立身份，避免跨设备误释放。
  return `${source}\u0000${inputId}`
}

function inputSourceFromKey(inputKey: string) {
  return inputKey.slice(0, inputKey.indexOf('\u0000')) as ActivitySource
}

function localDayOffset(now: number, dayOffset: number) {
  const current = new Date(now)

  return new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() + dayOffset,
  )
}

function dailySampleKey(scopeId: string, trigger: DailyWindowTrigger, anchor: Date) {
  return `${scopeId}:${dailyOccurrenceKey(trigger, anchor)}:sample`
}

function dailyOccurrenceKey(trigger: DailyWindowTrigger, anchor: Date) {
  return `${trigger.id}:${formatLocalDate(anchor)}:${trigger.startTime}-${trigger.endTime}`
}

function formatLocalDate(date: Date) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function trimOldest<K, V>(map: Map<K, V>, maxSize: number) {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value

    if (oldest === undefined) return
    map.delete(oldest)
  }
}

function trimOldestSet<T>(set: Set<T>, maxSize: number) {
  while (set.size > maxSize) {
    const oldest = set.values().next().value

    if (oldest === undefined) return
    set.delete(oldest)
  }
}
