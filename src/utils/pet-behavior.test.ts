/* eslint-disable test/no-import-node-test -- 项目未引入 Vitest，复用现有 Node 测试运行器避免新增依赖。 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  PetBehaviorClock,
  PetBehaviorConfig,
  PetBehaviorTimer,
  PetPlaybackDriver,
  PetPlaybackEndReason,
  PetPlaybackHandle,
  PetPlayOptions,
  PetSpeechPayload,
} from './pet-behavior'

import { assertPetBehaviorConfig, PetBehaviorController } from './pet-behavior'

interface DeferredPlayback {
  animation: string
  finish: (reason?: PetPlaybackEndReason) => void
  finished: Promise<{ reason: PetPlaybackEndReason }>
}

class FakeClock implements PetBehaviorClock {
  private monotonicNow = 0
  private wallClockNow = new Date('2026-08-26T08:00:00+08:00').getTime()
  private timerId = 0
  private readonly timers = new Map<number, {
    callback: () => void
    dueAt: number
  }>()

  public now = () => this.monotonicNow
  public wallNow = () => this.wallClockNow

  public setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.timerId

    this.timers.set(id, {
      callback,
      dueAt: this.monotonicNow + Math.max(0, delayMs),
    })

    // 生产代码只把句柄交还给同一时钟的 clearTimeout；测试使用数字句柄即可稳定比较身份。
    return id as unknown as PetBehaviorTimer
  }

  public clearTimeout = (timer: PetBehaviorTimer) => {
    this.timers.delete(timer as unknown as number)
  }

  public advance(ms: number) {
    const target = this.monotonicNow + ms

    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0]

      if (!next) break

      const [id, timer] = next
      const elapsed = timer.dueAt - this.monotonicNow

      this.monotonicNow = timer.dueAt
      this.wallClockNow += elapsed
      this.timers.delete(id)
      timer.callback()
    }

    const remaining = target - this.monotonicNow

    this.monotonicNow = target
    this.wallClockNow += remaining
  }
}

class RecordingPlaybackDriver implements PetPlaybackDriver {
  public readonly animations: string[] = []
  public readonly options: PetPlayOptions[] = []
  public readonly speeches: PetSpeechPayload[] = []
  public current: DeferredPlayback | undefined

  public play = (animation: string, options: PetPlayOptions = {}): PetPlaybackHandle => {
    this.current?.finish('interrupted')

    let settle!: (result: { reason: PetPlaybackEndReason }) => void
    let settled = false
    const finished = new Promise<{ reason: PetPlaybackEndReason }>((resolve) => {
      settle = resolve
    })
    const playback: DeferredPlayback = {
      animation,
      finished,
      finish: (reason = 'finished') => {
        if (settled) return

        settled = true
        settle({ reason })
      },
    }

    this.animations.push(animation)
    this.options.push(options)
    this.current = playback

    return { animation, finished }
  }

  public finish(reason: PetPlaybackEndReason = 'finished') {
    const current = this.current

    current?.finish(reason)
    if (this.current === current) this.current = void 0
  }

  public speak = (payload: PetSpeechPayload) => {
    this.speeches.push(payload)
  }
}

function createStatefulBehaviorConfig(
  initialForm: 'normal' | 'attack' | 'demon' = 'normal',
): PetBehaviorConfig {
  const config = createBehaviorConfig()
  const routine = config.modules?.[0]
  const wave = routine?.actions[0]

  assert.ok(routine && wave)

  wave.stateEffect = {
    when: 'finished',
    priority: 10,
    set: { mood: 'happy' },
    lifetime: { type: 'duration', durationMs: 2_000 },
  }
  routine.actions.push({
    id: 'routine/bow',
    moduleId: 'routine',
    animation: 'pet-bow',
    dialogue: {
      chance: 1,
      delayMs: 0,
      durationMs: 1_000,
      lines: [{ text: 'A calm bow.', weight: 1 }],
    },
    stateAnimations: [
      { priority: 90, match: { form: 'attack' }, animation: 'pet-attack-bow' },
      { priority: 90, match: { form: 'demon' }, animation: 'pet-demon-bow' },
    ],
    stateDialogues: [
      {
        priority: 90,
        match: { form: 'attack' },
        dialogue: {
          chance: 1,
          delayMs: 0,
          durationMs: 1_000,
          lines: [{ text: 'A decisive combat bow.', weight: 1 }],
        },
      },
      {
        priority: 90,
        match: { form: 'demon' },
        dialogue: {
          chance: 1,
          delayMs: 0,
          durationMs: 1_000,
          lines: [{ text: 'A dangerous demon bow.', weight: 1 }],
        },
      },
    ],
    cooldownMs: 0,
    interruptible: true,
    priority: 0,
  })
  routine.actions.push({
    id: 'routine/attack-transform',
    moduleId: 'routine',
    animation: 'pet-normal-to-attack',
    stateAnimations: [
      { priority: 90, match: { form: 'attack' }, animation: 'pet-attack-flourish' },
      { priority: 90, match: { form: 'demon' }, animation: 'pet-demon-to-attack' },
    ],
    cooldownMs: 0,
    interruptible: true,
    priority: 0,
    stateEffect: {
      when: 'finished',
      priority: 90,
      set: { form: 'attack' },
      lifetime: { type: 'session' },
    },
  })
  routine.actions.push({
    id: 'routine/form-pulse',
    moduleId: 'routine',
    animation: 'pet-normal-attack-return',
    stateAnimations: [
      { priority: 90, match: { form: 'attack' }, animation: 'pet-attack-demon-return' },
      { priority: 90, match: { form: 'demon' }, animation: 'pet-demon-normal-return' },
    ],
    cooldownMs: 0,
    interruptible: true,
    priority: 0,
  })
  config.inputActions = {
    keyboard: {
      Return: 'routine/form-pulse',
      Enter: 'routine/form-pulse',
      KpReturn: 'routine/form-pulse',
    },
  }
  routine.triggers.push({
    id: 'routine/manual-bow',
    moduleId: 'routine',
    type: 'manual',
    actionId: 'routine/bow',
    enterPet: true,
    label: 'Bow',
    order: 1,
  })
  routine.triggers.push({
    id: 'routine/manual-attack-transform',
    moduleId: 'routine',
    type: 'manual',
    actionId: 'routine/attack-transform',
    enterPet: true,
    label: 'Combat form',
    order: 2,
  })
  config.stateMachine = {
    dimensions: {
      activity: { initial: 'awake', values: ['awake', 'relaxed'] },
      mood: { initial: 'calm', values: ['calm', 'happy'] },
      form: { initial: initialForm, values: ['normal', 'attack', 'demon'] },
    },
    profiles: [
      {
        id: 'attack-form',
        priority: 100,
        scene: 'pet',
        match: { form: 'attack' },
        animation: 'pet-attack-idle',
      },
      {
        id: 'demon-form',
        priority: 100,
        scene: 'pet',
        match: { form: 'demon' },
        animation: 'pet-demon-idle',
      },
      {
        id: 'happy',
        priority: 20,
        scene: 'pet',
        match: { mood: 'happy' },
        animation: 'pet-happy',
      },
      {
        id: 'relaxed',
        priority: 10,
        scene: 'pet',
        match: { activity: 'relaxed' },
        animation: 'pet-relaxed',
      },
      {
        id: 'pet-fallback',
        priority: 0,
        scene: 'pet',
        match: {},
        animation: 'pet-idle',
      },
    ],
    rules: [{
      id: 'relax-after-idle',
      priority: 10,
      when: { scene: 'pet', idleForMs: 1_000 },
      set: { activity: 'relaxed' },
    }],
  }

  return config
}

function createStatefulController(initialForm: 'normal' | 'attack' | 'demon' = 'normal') {
  const clock = new FakeClock()
  const driver = new RecordingPlaybackDriver()
  const config = createStatefulBehaviorConfig(initialForm)
  const controller = new PetBehaviorController(config, {
    clock,
    driver,
    context: {
      enabled: true,
      inputStatus: 'ready',
      rendererReady: true,
      renderedVisible: true,
      visible: true,
    },
  })

  controller.configure(config, 'work-idle')
  controller.start()

  return { clock, controller, driver }
}

function createBehaviorConfig(): PetBehaviorConfig {
  return {
    activationDelayMs: 1_000,
    enterAnimation: 'pet-enter',
    idleAnimation: 'pet-idle',
    exitAnimation: 'pet-exit',
    modules: [{
      id: 'routine',
      displayName: 'Routine',
      order: 0,
      actions: [{
        id: 'routine/wave',
        moduleId: 'routine',
        animation: 'pet-wave',
        cooldownMs: 30_000,
        interruptible: true,
        priority: 0,
      }],
      triggers: [{
        id: 'routine/manual-wave',
        moduleId: 'routine',
        type: 'manual',
        actionId: 'routine/wave',
        enterPet: true,
        label: 'Wave',
        order: 0,
      }],
    }],
  }
}

function createController(inputStatus: 'ready' | 'unavailable' = 'ready') {
  const clock = new FakeClock()
  const driver = new RecordingPlaybackDriver()
  const controller = new PetBehaviorController(createBehaviorConfig(), {
    clock,
    driver,
    context: {
      enabled: true,
      inputStatus,
      rendererReady: true,
      renderedVisible: true,
      visible: true,
    },
  })

  controller.configure(createBehaviorConfig(), 'work-idle')
  controller.start()

  return { clock, controller, driver }
}

function manualCatalogItem(controller: PetBehaviorController) {
  const catalog = controller.getActionCatalog('en-US')
  const item = catalog?.activeGroups[0]?.actions[0]

  assert.ok(item, 'manual catalog item should exist')

  return item.id
}

async function flushPlaybackContinuation() {
  // 动画完成会经过 Promise continuation；连续让出两次微任务可覆盖其中继续启动 pending 的分支。
  await Promise.resolve()
  await Promise.resolve()
}

test('legacy lifecycle enters pet mode after the activation delay and exits for input', async () => {
  const { clock, controller, driver } = createController()

  clock.advance(999)
  assert.equal(controller.state, 'work-idle')

  clock.advance(1)
  assert.equal(controller.state, 'pet-entering')
  assert.equal(driver.current?.animation, 'pet-enter')

  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(controller.state, 'pet-idle')

  assert.equal(controller.notifyKeyboardPress('KeyA'), true)
  assert.equal(controller.state, 'pet-exiting')
  assert.equal(driver.current?.animation, 'pet-exit')

  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(controller.state, 'work-idle')
})

test('manual action starts on the first request without waiting for pet-enter', async () => {
  const { controller, driver } = createController()
  const itemId = manualCatalogItem(controller)

  assert.equal(controller.triggerActionCatalogItem(itemId), true)
  assert.equal(controller.state, 'pet-action')
  assert.deepEqual(driver.animations, ['pet-wave'])

  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(controller.state, 'pet-idle')
})

test('manual action remains available when native input monitoring is unavailable', async () => {
  const { controller, driver } = createController('unavailable')

  assert.equal(controller.triggerActionCatalogItem(manualCatalogItem(controller)), true)
  assert.equal(controller.state, 'pet-action')

  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(controller.state, 'pet-idle')
})

test('manual action immediately replaces entering, action, and exiting playback', async () => {
  const { clock, controller, driver } = createController()
  const itemId = manualCatalogItem(controller)

  clock.advance(1_000)
  assert.equal(controller.state, 'pet-entering')
  assert.equal(controller.triggerActionCatalogItem(itemId), true)
  assert.equal(controller.state, 'pet-action')
  assert.deepEqual(driver.animations, ['pet-enter', 'pet-wave'])

  assert.equal(controller.triggerActionCatalogItem(itemId), true)
  assert.deepEqual(driver.animations, ['pet-enter', 'pet-wave', 'pet-wave'])

  assert.equal(controller.notifyKeyboardPress('KeyA'), true)
  assert.equal(controller.state, 'pet-exiting')
  assert.equal(controller.triggerActionCatalogItem(itemId), true)
  assert.equal(controller.state, 'pet-action')
  assert.deepEqual(driver.animations, ['pet-enter', 'pet-wave', 'pet-wave', 'pet-exit', 'pet-wave'])

  controller.notifyKeyboardRelease('KeyA')
  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(controller.state, 'pet-idle')
})

test('reconfigure invalidates an old action completion', async () => {
  const { controller, driver } = createController()

  assert.equal(controller.triggerActionCatalogItem(manualCatalogItem(controller)), true)
  const oldPlayback = driver.current

  controller.configure(createBehaviorConfig(), 'work-idle', 'next-model')
  assert.equal(controller.state, 'work-idle')

  oldPlayback?.finish('finished')
  await flushPlaybackContinuation()
  assert.equal(controller.state, 'work-idle')
})

test('finished action effects select the new steady profile without an old-idle playback', async () => {
  const { controller, driver } = createStatefulController()
  const wave = controller.getActionCatalog('en-US')?.activeGroups[0]?.actions.find(
    action => action.label === 'Wave',
  )

  assert.ok(wave)
  assert.equal(controller.triggerActionCatalogItem(wave.id), true)
  assert.equal(driver.options.at(-1)?.completion, 'hold')

  driver.finish()
  await flushPlaybackContinuation()

  assert.equal(controller.state, 'pet-idle')
  assert.deepEqual(driver.animations, ['pet-wave', 'pet-happy'])
})

test('temporary actions return to the latest state-selected steady profile', async () => {
  const { controller, driver } = createStatefulController()
  const actions = controller.getActionCatalog('en-US')?.activeGroups[0]?.actions
  const wave = actions?.find(action => action.label === 'Wave')
  const bow = actions?.find(action => action.label === 'Bow')

  assert.ok(wave && bow)
  assert.equal(controller.triggerActionCatalogItem(wave.id), true)
  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(driver.current?.animation, 'pet-happy')

  assert.equal(controller.triggerActionCatalogItem(bow.id), true)

  driver.finish()
  await flushPlaybackContinuation()

  assert.deepEqual(driver.animations, ['pet-wave', 'pet-happy', 'pet-bow', 'pet-happy'])
})

test('transformed forms select matching transition, action, and steady animations', async () => {
  const { controller, driver } = createStatefulController()
  const actions = controller.getActionCatalog('en-US')?.activeGroups[0]?.actions
  const combat = actions?.find(action => action.label === 'Combat form')
  const bow = actions?.find(action => action.label === 'Bow')

  assert.ok(combat && bow)

  // 普通形态先使用基础对白；后面同一个 action 会随形态一起更换动画和语气。
  assert.equal(controller.triggerActionCatalogItem(bow.id), true)
  assert.equal(driver.current?.animation, 'pet-bow')
  assert.equal(driver.speeches.at(-1)?.text, 'A calm bow.')
  driver.finish()
  await flushPlaybackContinuation()

  // 第一次从普通形态进入战斗形态，结束后常态和后续动作都必须保持战斗配色。
  assert.equal(controller.triggerActionCatalogItem(combat.id), true)
  assert.equal(driver.current?.animation, 'pet-normal-to-attack')
  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(driver.current?.animation, 'pet-attack-idle')

  assert.equal(controller.triggerActionCatalogItem(bow.id), true)
  assert.equal(driver.current?.animation, 'pet-attack-bow')
  assert.equal(driver.speeches.at(-1)?.text, 'A decisive combat bow.')
  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(driver.current?.animation, 'pet-attack-idle')

  // 已处于战斗形态时再次触发，只播放同形态强调动作，不闪回普通人物。
  assert.equal(controller.triggerActionCatalogItem(combat.id), true)
  assert.equal(driver.current?.animation, 'pet-attack-flourish')
})

test('configured keyboard action temporarily visits the next form and restores its source form', async () => {
  const cases = [
    ['normal', 'pet-normal-attack-return', 'pet-idle', 'Return'],
    ['attack', 'pet-attack-demon-return', 'pet-attack-idle', 'Enter'],
    ['demon', 'pet-demon-normal-return', 'pet-demon-idle', 'KpReturn'],
  ] as const

  for (const [form, actionAnimation, steadyAnimation, key] of cases) {
    const { controller, driver } = createStatefulController(form)

    assert.equal(controller.hasKeyboardAction(key), true)
    assert.equal(controller.notifyKeyboardActionPress(key, key), true)
    assert.equal(controller.state, 'pet-action')
    assert.equal(driver.current?.animation, actionAnimation)

    // 同一物理按压的 key repeat 只能产生按键反馈，不能重启 one-shot 动作。
    assert.equal(controller.notifyKeyboardActionPress(key, key), true)
    assert.equal(driver.animations.filter(animation => animation === actionAnimation).length, 1)

    driver.finish()
    await flushPlaybackContinuation()

    // action 没有 stateEffect；即使 Enter 尚未抬起，也要回来源形态的常态而非默认 idle。
    assert.equal(controller.state, 'pet-idle')
    assert.equal(driver.current?.animation, steadyAnimation)
    assert.equal(controller.notifyKeyboardRelease(key), true)
  }
})

test('keyboard input action validation rejects unknown module actions before model playback', () => {
  const config = createBehaviorConfig()
  const context = {
    animations: {
      'pet-enter': { loop: false },
      'pet-idle': { loop: true },
      'pet-exit': { loop: false },
      'pet-wave': { loop: false },
    },
    canvas: { width: 512, height: 512 },
  }

  config.inputActions = { keyboard: { Enter: 'routine/wave' } }
  assert.doesNotThrow(() => assertPetBehaviorConfig(config, context))

  config.inputActions.keyboard = { Enter: 'routine/missing' }
  assert.throws(
    () => assertPetBehaviorConfig(config, context),
    /references an unknown module action/,
  )
})

test('duration state effects reevaluate and restore the matching steady profile', async () => {
  const { clock, controller, driver } = createStatefulController()
  const wave = controller.getActionCatalog('en-US')?.activeGroups[0]?.actions.find(
    action => action.label === 'Wave',
  )

  assert.ok(wave)
  assert.equal(controller.triggerActionCatalogItem(wave.id), true)
  driver.finish()
  await flushPlaybackContinuation()
  assert.equal(driver.current?.animation, 'pet-happy')

  clock.advance(2_000)

  assert.equal(driver.current?.animation, 'pet-relaxed')
})
