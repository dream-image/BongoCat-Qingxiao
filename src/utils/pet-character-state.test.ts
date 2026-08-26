/* eslint-disable test/no-import-node-test -- 项目未引入 Vitest，复用现有 Node 测试运行器避免新增依赖。 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { PetCharacterStateContext, PetStateMachineConfig } from './pet-character-state'

import { PetCharacterStateResolver } from './pet-character-state'

function createStateConfig(): PetStateMachineConfig {
  return {
    dimensions: {
      activity: {
        initial: 'awake',
        values: ['awake', 'relaxed', 'napping', 'sleeping'],
      },
      mood: {
        initial: 'calm',
        values: ['calm', 'happy', 'annoyed'],
      },
    },
    profiles: [
      {
        id: 'pet-sleeping',
        animation: 'pet-sleeping-idle',
        match: { activity: 'sleeping' },
        priority: 800,
        scene: 'pet',
      },
      {
        id: 'pet-annoyed',
        animation: 'pet-annoyed-idle',
        match: { mood: 'annoyed' },
        priority: 500,
        scene: 'pet',
      },
      {
        id: 'pet-awake',
        animation: 'pet-idle',
        match: {},
        priority: 100,
        scene: 'pet',
      },
      {
        id: 'work-awake',
        animation: 'idle',
        match: {},
        priority: 100,
        scene: 'work',
      },
    ],
    rules: [
      {
        id: 'relaxed-after-two-minutes',
        priority: 100,
        set: { activity: 'relaxed' },
        when: { idleForMs: 120_000, scene: 'pet' },
      },
      {
        id: 'midday-nap',
        priority: 300,
        set: { activity: 'napping' },
        when: {
          dailyWindow: { endTime: '13:30', startTime: '12:00' },
          idleForMs: 180_000,
          scene: 'pet',
        },
      },
      {
        id: 'night-sleep',
        priority: 800,
        set: { activity: 'sleeping' },
        when: {
          dailyWindow: { endTime: '06:30', startTime: '23:00' },
          idleForMs: 300_000,
          scene: 'pet',
        },
      },
    ],
  }
}

function context(
  overrides: Partial<PetCharacterStateContext> = {},
): PetCharacterStateContext {
  return {
    idleForMs: 0,
    now: 0,
    scene: 'pet',
    wallNow: new Date('2026-08-26T10:00:00+08:00').getTime(),
    ...overrides,
  }
}

test('resolves defaults, rules, and the highest-priority matching visual profile', () => {
  const resolver = new PetCharacterStateResolver(createStateConfig())

  let result = resolver.evaluate(context())

  assert.deepEqual(result.snapshot.values, { activity: 'awake', mood: 'calm' })
  assert.equal(result.profile?.id, 'pet-awake')

  result = resolver.evaluate(context({ idleForMs: 120_000, now: 120_000 }))
  assert.equal(result.snapshot.values.activity, 'relaxed')
  assert.equal(result.snapshot.revision, 2)

  result = resolver.evaluate(context({
    idleForMs: 300_000,
    now: 300_000,
    wallNow: new Date('2026-08-26T23:15:00+08:00').getTime(),
  }))
  assert.equal(result.snapshot.values.activity, 'sleeping')
  assert.equal(result.profile?.id, 'pet-sleeping')
})

test('matches a cross-midnight state window and leaves it at the ending boundary', () => {
  const resolver = new PetCharacterStateResolver(createStateConfig())
  const sleeping = resolver.evaluate(context({
    idleForMs: 300_000,
    wallNow: new Date('2026-08-27T05:30:00+08:00').getTime(),
  }))

  assert.equal(sleeping.snapshot.values.activity, 'sleeping')

  const awake = resolver.evaluate(context({
    idleForMs: 300_000,
    now: 3_600_000,
    wallNow: new Date('2026-08-27T06:30:00+08:00').getTime(),
  }))

  assert.equal(awake.snapshot.values.activity, 'relaxed')
})

test('duration action effect overrides rules and expires back to the current rule result', () => {
  const resolver = new PetCharacterStateResolver(createStateConfig())
  const baseContext = context({ idleForMs: 120_000, now: 120_000 })

  resolver.evaluate(baseContext)

  let result = resolver.applyEffect({
    lifetime: { durationMs: 90_000, type: 'duration' },
    priority: 0,
    set: { mood: 'annoyed' },
    when: 'finished',
  }, baseContext)

  assert.equal(result.snapshot.values.mood, 'annoyed')
  assert.equal(result.profile?.id, 'pet-annoyed')

  result = resolver.evaluate(context({ idleForMs: 220_000, now: 210_000 }))
  assert.equal(result.snapshot.values.mood, 'calm')
  assert.equal(result.snapshot.values.activity, 'relaxed')
})

test('until-input effects clear without disturbing unrelated state dimensions', () => {
  const resolver = new PetCharacterStateResolver(createStateConfig())
  const idleContext = context({ idleForMs: 300_000, now: 300_000 })

  resolver.evaluate(idleContext)
  resolver.applyEffect({
    lifetime: { type: 'until-input' },
    priority: 0,
    set: { mood: 'happy' },
    when: 'finished',
  }, idleContext)

  const result = resolver.clearUntilInput(context({ idleForMs: 0, now: 301_000 }))

  assert.equal(result.snapshot.values.mood, 'calm')
  assert.equal(result.snapshot.values.activity, 'awake')
})

test('reports the nearest state reevaluation deadline', () => {
  const resolver = new PetCharacterStateResolver(createStateConfig())
  const beforeRelaxed = context({ idleForMs: 90_000, now: 90_000 })

  resolver.evaluate(beforeRelaxed)

  assert.equal(resolver.nextEvaluationDelay(beforeRelaxed), 30_000)
})
