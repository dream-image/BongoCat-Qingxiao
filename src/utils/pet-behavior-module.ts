import { sep } from '@tauri-apps/api/path'

import type {
  PetStateAnimationVariantConfig,
  PetStateEffectConfig,
} from './pet-character-state'

import { readBoundedTextFile, resolveModelResourcePath } from './path'

export type PetLocalizedText = string | Record<string, string>

export interface PetBehaviorModuleAnimationConfig {
  file: string
  frameWidth: number
  frameHeight: number
  frames: number
  columns: number
  fps: number
  loop: boolean
  frameDurations?: number[]
}

export interface PetBehaviorModuleReference {
  source: string
  enabled?: boolean
}

export interface PetModuleV1 {
  version: 1
  id: string
  displayName: PetLocalizedText
  order?: number
  animations?: Record<string, PetBehaviorModuleAnimationConfig>
  actions: Record<string, PetModuleActionV1>
  triggers: PetModuleTriggerV1[]
}

export interface PetModuleActionV1 {
  label?: PetLocalizedText
  animation?: string
  priority?: number
  cooldownMs?: number
  interruptible?: boolean
  dialogue?: PetModuleDialogueV1
  audio?: PetModuleAudioV1
  stateEffect?: PetModuleStateEffectV1
  // 持久形态必须引用各自完整 one-shot，避免运行时给普通人物临时叠色或叠附件。
  stateAnimations?: PetModuleStateAnimationV1[]
  // 对白和动画使用同一人物状态快照，防止化形后仍沿用普通形态的说话语气。
  stateDialogues?: PetModuleStateDialogueV1[]
}

export interface PetModuleStateAnimationV1 {
  priority?: number
  match: Record<string, string>
  animation: string
}

export interface PetModuleStateDialogueV1 {
  priority?: number
  match: Record<string, string>
  dialogue: PetModuleDialogueV1
}

export interface PetModuleStateEffectV1 {
  when?: 'started' | 'finished'
  priority?: number
  set: Record<string, string>
  lifetime?:
    | { type: 'session' }
    | { type: 'duration', durationMs: number }
    | { type: 'until-input' }
}

export interface PetModuleAudioV1 {
  file: string
  chance?: number
  delayMs?: number
  volume?: number
}

export interface PetModuleDialogueV1 {
  chance?: number
  delayMs?: number
  durationMs?: number
  anchor?: {
    x: number
    y: number
  }
  lines: Array<PetLocalizedText | {
    text: PetLocalizedText
    weight?: number
  }>
}

interface PetModuleTriggerBaseV1 {
  id: string
  type:
    | 'interval'
    | 'idle'
    | 'schedule'
    | 'manual'
    | 'pointer'
    | 'session'
    | 'visibility-return'
    | 'activity-burst'
    | 'active-session'
    | 'daily-window'
}

export type PetActivitySource = 'keyboard' | 'mouse' | 'gamepad'

export interface PetModuleIntervalTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'interval'
  delayMs: [number, number]
  choices: Array<{
    action: string
    weight: number
  }>
}

export interface PetModuleIdleTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'idle'
  afterMs: number
  repeatMs?: [number, number]
  action: string
  oncePerIdle?: boolean
}

export interface PetModuleScheduleTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'schedule'
  action: string
  time: string
  dates?: string[]
  weekdays?: number[]
  catchUpMs?: number
  enterPet?: boolean
}

export interface PetModuleManualTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'manual'
  action: string
  label: PetLocalizedText
  group?: PetLocalizedText
  order?: number
  enterPet?: boolean
}

export interface PetModulePointerTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'pointer'
  action: string
  event: 'hover' | 'tap' | 'stroke'
  area: string
  holdMs?: number
  distance?: number
  windowMs?: number
}

export interface PetModuleSessionTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'session'
  action: string
  event: 'startup'
  delayMs?: [number, number]
  catchUpMs?: number
  enterPet?: boolean
}

export interface PetModuleVisibilityReturnTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'visibility-return'
  action: string
  minAwayMs: number
  maxAwayMs?: number
  settleMs?: number
  catchUpMs?: number
  enterPet?: boolean
}

export interface PetModuleActivityBurstTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'activity-burst'
  action: string
  sources?: PetActivitySource[]
  windowMs: number
  minimumEvents: number
  quietMs: number
  catchUpMs?: number
  enterPet?: boolean
}

export interface PetModuleActiveSessionTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'active-session'
  action: string
  sources?: PetActivitySource[]
  afterMs: number
  resetAfterMs: number
  repeatMs?: number
  quietMs?: number
  catchUpMs?: number
  enterPet?: boolean
}

export interface PetModuleDailyWindowTriggerV1 extends PetModuleTriggerBaseV1 {
  type: 'daily-window'
  action: string
  startTime: string
  endTime: string
  dates?: string[]
  weekdays?: number[]
  catchUpMs?: number
  enterPet?: boolean
}

export type PetModuleTriggerV1
  = | PetModuleIntervalTriggerV1
    | PetModuleIdleTriggerV1
    | PetModuleScheduleTriggerV1
    | PetModuleManualTriggerV1
    | PetModulePointerTriggerV1
    | PetModuleSessionTriggerV1
    | PetModuleVisibilityReturnTriggerV1
    | PetModuleActivityBurstTriggerV1
    | PetModuleActiveSessionTriggerV1
    | PetModuleDailyWindowTriggerV1

export interface PetRuntimeDialogue {
  chance: number
  delayMs: number
  durationMs: number
  anchor?: {
    x: number
    y: number
  }
  lines: Array<{
    text: PetLocalizedText
    weight: number
  }>
}

export interface PetRuntimeStateDialogue {
  priority: number
  match: Record<string, string>
  dialogue: PetRuntimeDialogue
}

export interface PetRuntimeAudio {
  file: string
  chance: number
  delayMs: number
  volume: number
}

export interface PetRuntimeAction {
  id: string
  moduleId: string
  label?: PetLocalizedText
  animation?: string
  priority: number
  cooldownMs: number
  interruptible: boolean
  dialogue?: PetRuntimeDialogue
  audio?: PetRuntimeAudio
  stateEffect?: PetStateEffectConfig
  stateAnimations?: PetStateAnimationVariantConfig[]
  stateDialogues?: PetRuntimeStateDialogue[]
}

interface PetRuntimeTriggerBase {
  id: string
  moduleId: string
  type: PetModuleTriggerBaseV1['type']
}

export interface PetRuntimeIntervalTrigger extends PetRuntimeTriggerBase {
  type: 'interval'
  delayMs: [number, number]
  choices: Array<{
    actionId: string
    weight: number
  }>
}

export interface PetRuntimeIdleTrigger extends PetRuntimeTriggerBase {
  type: 'idle'
  afterMs: number
  repeatMs?: [number, number]
  actionId: string
  oncePerIdle: boolean
}

export interface PetRuntimeScheduleTrigger extends PetRuntimeTriggerBase {
  type: 'schedule'
  actionId: string
  time: string
  dates?: string[]
  weekdays?: number[]
  catchUpMs: number
  enterPet: boolean
}

export interface PetRuntimeManualTrigger extends PetRuntimeTriggerBase {
  type: 'manual'
  actionId: string
  label: PetLocalizedText
  group?: PetLocalizedText
  order: number
  enterPet: boolean
}

export interface PetRuntimePointerTrigger extends PetRuntimeTriggerBase {
  type: 'pointer'
  actionId: string
  event: PetModulePointerTriggerV1['event']
  area: string
  holdMs?: number
  distance?: number
  windowMs?: number
}

export interface PetRuntimeSessionTrigger extends PetRuntimeTriggerBase {
  type: 'session'
  actionId: string
  event: 'startup'
  delayMs: [number, number]
  catchUpMs: number
  enterPet: boolean
}

export interface PetRuntimeVisibilityReturnTrigger extends PetRuntimeTriggerBase {
  type: 'visibility-return'
  actionId: string
  minAwayMs: number
  maxAwayMs?: number
  settleMs: number
  catchUpMs: number
  enterPet: boolean
}

export interface PetRuntimeActivityBurstTrigger extends PetRuntimeTriggerBase {
  type: 'activity-burst'
  actionId: string
  sources: PetActivitySource[]
  windowMs: number
  minimumEvents: number
  quietMs: number
  catchUpMs: number
  enterPet: boolean
}

export interface PetRuntimeActiveSessionTrigger extends PetRuntimeTriggerBase {
  type: 'active-session'
  actionId: string
  sources: PetActivitySource[]
  afterMs: number
  resetAfterMs: number
  repeatMs?: number
  quietMs: number
  catchUpMs: number
  enterPet: boolean
}

export interface PetRuntimeDailyWindowTrigger extends PetRuntimeTriggerBase {
  type: 'daily-window'
  actionId: string
  startTime: string
  endTime: string
  dates?: string[]
  weekdays?: number[]
  catchUpMs: number
  enterPet: boolean
}

export type PetRuntimeTrigger
  = | PetRuntimeIntervalTrigger
    | PetRuntimeIdleTrigger
    | PetRuntimeScheduleTrigger
    | PetRuntimeManualTrigger
    | PetRuntimePointerTrigger
    | PetRuntimeSessionTrigger
    | PetRuntimeVisibilityReturnTrigger
    | PetRuntimeActivityBurstTrigger
    | PetRuntimeActiveSessionTrigger
    | PetRuntimeDailyWindowTrigger

export interface PetBehaviorRuntimeModule {
  id: string
  displayName: PetLocalizedText
  order: number
  actions: PetRuntimeAction[]
  triggers: PetRuntimeTrigger[]
}

export interface PetBehaviorModuleLoadContext {
  animations: Record<string, PetBehaviorModuleAnimationConfig>
  canvas: {
    width: number
    height: number
  }
  hitAreas?: Record<string, unknown>
  assertActive?: () => void
}

export interface PetBehaviorModuleLoadResult {
  animations: Record<string, PetBehaviorModuleAnimationConfig>
  modules: PetBehaviorRuntimeModule[]
}

// 这些总量门共同限制第三方 manifest 的 fan-out、定时器数量与本地化字符串驻留；
// 配合文件字节上限，可在解析后继续约束小文件展开成巨型运行时 catalog 的风险。
const MAX_TIMER_DELAY = 2_147_483_647
const MAX_MODULE_COUNT = 64
const MAX_MODULE_ANIMATIONS = 128
const MAX_MODULE_ACTIONS = 128
const MAX_MODULE_TRIGGERS = 256
const MAX_TOTAL_MODULE_ACTIONS = 512
const MAX_TOTAL_MODULE_TRIGGERS = 256
const MAX_DIALOGUE_LINES = 32
const MAX_STATE_EFFECT_DIMENSIONS = 8
const MAX_STATE_ANIMATIONS = 16
const MAX_STATE_DIALOGUES = 16
const MAX_LOCALIZED_VARIANTS = 16
const MAX_ID_LENGTH = 80
const MAX_TEXT_LENGTH = 240
const MAX_PATH_LENGTH = 512
const MAX_MODULE_MANIFEST_BYTES = 256 * 1024
const MAX_TAP_DISTANCE = 6
const DEFAULT_DIALOGUE_DURATION = 2200
const DEFAULT_SCHEDULE_CATCH_UP = 60_000
const DEFAULT_SESSION_DELAY: [number, number] = [1500, 5000]
const DEFAULT_SESSION_CATCH_UP = 120_000
const DEFAULT_VISIBILITY_SETTLE = 1000
const DEFAULT_VISIBILITY_CATCH_UP = 30_000
const DEFAULT_ACTIVITY_CATCH_UP = 15_000
const DEFAULT_ACTIVE_SESSION_QUIET = 1500
const DEFAULT_ACTIVE_SESSION_CATCH_UP = 300_000
const DEFAULT_DAILY_WINDOW_CATCH_UP = 30 * 60_000
const MIN_TIMER_DRIVEN_CATCH_UP = 1_000
const MAX_SCHEDULE_CATCH_UP = 86_400_000
const MIN_ACTIVITY_EVENTS = 2
const MAX_ACTIVITY_EVENTS = 256
const DEFAULT_ACTIVITY_SOURCES: PetActivitySource[] = ['keyboard', 'mouse', 'gamepad']
const SAFE_ID_PATTERN = /^[\da-z][\w.-]*$/
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * 模型文本允许直接写字符串，也允许内置自己的语言表；解析器只做确定性回退，
 * 不依赖应用 i18n，保证导入的第三方模型在任意界面语言下始终有可显示文本。
 */
export function resolvePetLocalizedText(value: PetLocalizedText, locale: string) {
  if (typeof value === 'string') return value

  const entries = Object.entries(value)

  if (entries.length === 0) return ''

  const normalizedLocale = locale.toLowerCase()
  const exact = entries.find(([key]) => key.toLowerCase() === normalizedLocale)

  if (exact) return exact[1]

  const language = normalizedLocale.split('-')[0]
  const languageOnly = entries.find(([key]) => key.toLowerCase() === language)

  if (languageOnly) return languageOnly[1]

  const sameLanguage = entries.find(([key]) => key.toLowerCase().split('-')[0] === language)

  if (sameLanguage) return sameLanguage[1]

  // 非中文界面优先退回英语；否则葡语、越南语等缺少翻译时会意外显示中文。
  const fallbackLocales = language === 'zh' ? ['zh-cn', 'en-us'] : ['en-us', 'zh-cn']

  return fallbackLocales
    .map(fallback => entries.find(([key]) => key.toLowerCase() === fallback)?.[1])
    .find(text => text !== void 0)
    ?? entries[0][1]
}

/**
 * 外部模块在模型资源解码前完成读取和规范化。局部 ID 与资源路径都会加上模块作用域，
 * 因此多个独立模块可以安全组合，且任何一个坏引用都会让整个模型在加载期失败。
 */
export async function loadPetBehaviorModules(
  modelPath: string,
  references: unknown,
  context: PetBehaviorModuleLoadContext,
): Promise<PetBehaviorModuleLoadResult> {
  if (!Array.isArray(references)) {
    throw new TypeError('Pet behavior modules must be an array')
  }

  if (references.length > MAX_MODULE_COUNT) {
    throw new RangeError(`Pet behavior modules cannot exceed ${MAX_MODULE_COUNT}`)
  }

  const animations = { ...context.animations }
  const modules: PetBehaviorRuntimeModule[] = []
  const moduleIds = new Set<string>()
  const sources = new Set<string>()
  let totalActions = 0
  let totalTriggers = 0

  for (const [index, rawReference] of references.entries()) {
    // 切换模型后旧加载只允许收口当前 I/O，不能继续顺序读取剩余最多 64 个模块。
    context.assertActive?.()

    const label = `Pet behavior modules[${index}]`

    assertRecord(rawReference, label)
    assertAllowedKeys(rawReference, ['source', 'enabled'], label)

    const sourceParts = assertSafeRelativePath(rawReference.source, `${label}.source`)
    const source = sourceParts.join('/')

    if (!source.toLowerCase().endsWith('.json')) {
      throw new TypeError(`${label}.source must reference a JSON file`)
    }
    // 资源会随模型跨 macOS/Windows 文件系统分发，按大小写不敏感身份去重可避免同文件被别名加载两次。
    const sourceIdentity = source.toLowerCase()

    if (sources.has(sourceIdentity)) throw new TypeError(`${label}.source must be unique`)

    sources.add(sourceIdentity)

    if (rawReference.enabled !== undefined && typeof rawReference.enabled !== 'boolean') {
      throw new TypeError(`${label}.enabled must be a boolean`)
    }
    if (rawReference.enabled === false) continue

    // module.json 本身也属于外部模型资源；读取前走 Rust canonicalize，避免目录内符号链接越界。
    const modulePath = await resolveModelResourcePath(modelPath, source)

    context.assertActive?.()

    let rawModule: unknown

    try {
      // 每个模块在 JSON.parse 前独立限制字节，防止少量引用携带超大 manifest 抢占 WebView 内存。
      rawModule = JSON.parse(await readBoundedTextFile(
        modulePath,
        MAX_MODULE_MANIFEST_BYTES,
        `Pet behavior module "${source}"`,
      )) as unknown
    } catch (error) {
      throw new Error(`Failed to read pet behavior module "${source}": ${String(error)}`)
    }

    context.assertActive?.()

    const moduleDirectory = sourceParts.slice(0, -1)
    const normalized = normalizeModule(
      rawModule,
      source,
      moduleDirectory,
      animations,
      context,
    )

    if (moduleIds.has(normalized.module.id)) {
      throw new TypeError(`Pet behavior module id "${normalized.module.id}" must be unique`)
    }

    totalActions += normalized.module.actions.length
    totalTriggers += normalized.module.triggers.length

    // per-module 上限不能阻止多模块累加出数千 timer，合并阶段再施加模型级总预算。
    if (totalActions > MAX_TOTAL_MODULE_ACTIONS) {
      throw new RangeError(`Pet behavior module actions cannot exceed ${MAX_TOTAL_MODULE_ACTIONS}`)
    }
    if (totalTriggers > MAX_TOTAL_MODULE_TRIGGERS) {
      throw new RangeError(`Pet behavior module triggers cannot exceed ${MAX_TOTAL_MODULE_TRIGGERS}`)
    }

    moduleIds.add(normalized.module.id)

    for (const [name, animation] of Object.entries(normalized.animations)) {
      if (Object.prototype.hasOwnProperty.call(animations, name)) {
        throw new TypeError(`Pet behavior module animation "${name}" conflicts with another animation`)
      }

      animations[name] = animation
    }

    modules.push(normalized.module)

    context.assertActive?.()
  }

  return { animations, modules }
}

function normalizeModule(
  rawModule: unknown,
  source: string,
  moduleDirectory: string[],
  modelAnimations: Record<string, PetBehaviorModuleAnimationConfig>,
  context: PetBehaviorModuleLoadContext,
) {
  const label = `Pet behavior module "${source}"`

  assertRecord(rawModule, label)
  assertAllowedKeys(
    rawModule,
    ['version', 'id', 'displayName', 'order', 'animations', 'actions', 'triggers'],
    label,
  )

  if (rawModule.version !== 1) throw new TypeError(`${label}.version must be 1`)

  const moduleId = assertSafeId(rawModule.id, `${label}.id`)
  const displayName = normalizeLocalizedText(rawModule.displayName, `${label}.displayName`)
  const order = rawModule.order === undefined
    ? 0
    : assertBoundedInteger(rawModule.order, -10_000, 10_000, `${label}.order`)
  const localAnimations = normalizeAnimations(
    rawModule.animations,
    label,
    moduleId,
    moduleDirectory,
  )

  if (Object.keys(localAnimations).length > MAX_MODULE_ANIMATIONS) {
    throw new RangeError(`${label}.animations cannot exceed ${MAX_MODULE_ANIMATIONS}`)
  }

  // 动作可以显式引用模型动画，但模块内动画始终带 moduleId 作用域，避免多个模组同名时互相覆盖。
  const availableAnimations = { ...modelAnimations, ...localAnimations }
  const actions = normalizeActions(
    rawModule.actions,
    label,
    moduleId,
    availableAnimations,
    new Set(Object.keys(localAnimations)),
    context.canvas,
    moduleDirectory,
  )
  const actionIds = new Set(actions.map(action => action.id))
  const triggers = normalizeTriggers(
    rawModule.triggers,
    label,
    moduleId,
    actionIds,
    context.hitAreas,
  )

  return {
    animations: localAnimations,
    module: {
      id: moduleId,
      displayName,
      order,
      actions,
      triggers,
    } satisfies PetBehaviorRuntimeModule,
  }
}

function normalizeAnimations(
  value: unknown,
  moduleLabel: string,
  moduleId: string,
  moduleDirectory: string[],
) {
  if (value === undefined) return {}

  assertRecord(value, `${moduleLabel}.animations`)

  const animations: Record<string, PetBehaviorModuleAnimationConfig> = {}

  for (const [localId, rawAnimation] of Object.entries(value)) {
    const label = `${moduleLabel}.animations.${localId}`

    assertSafeId(localId, `${moduleLabel} animation id`)
    assertRecord(rawAnimation, label)
    assertAllowedKeys(
      rawAnimation,
      ['file', 'frameWidth', 'frameHeight', 'frames', 'columns', 'fps', 'loop', 'frameDurations'],
      label,
    )

    const fileParts = assertSafeRelativePath(rawAnimation.file, `${label}.file`)
    const animation: PetBehaviorModuleAnimationConfig = {
      file: [...moduleDirectory, ...fileParts].join(sep()),
      frameWidth: assertPositiveInteger(rawAnimation.frameWidth, `${label}.frameWidth`),
      frameHeight: assertPositiveInteger(rawAnimation.frameHeight, `${label}.frameHeight`),
      frames: assertPositiveInteger(rawAnimation.frames, `${label}.frames`),
      columns: assertPositiveInteger(rawAnimation.columns, `${label}.columns`),
      fps: assertPositiveNumber(rawAnimation.fps, `${label}.fps`),
      loop: assertBoolean(rawAnimation.loop, `${label}.loop`),
    }

    if (rawAnimation.frameDurations !== undefined) {
      if (!Array.isArray(rawAnimation.frameDurations)
        || rawAnimation.frameDurations.length !== animation.frames) {
        throw new TypeError(`${label}.frameDurations must contain one value per frame`)
      }

      animation.frameDurations = rawAnimation.frameDurations.map((duration, index) => {
        return assertPositiveNumber(duration, `${label}.frameDurations[${index}]`)
      })
    }

    animations[qualify(moduleId, localId)] = animation
  }

  return animations
}

function normalizeActions(
  value: unknown,
  moduleLabel: string,
  moduleId: string,
  animations: Record<string, PetBehaviorModuleAnimationConfig>,
  localAnimationIds: Set<string>,
  canvas: PetBehaviorModuleLoadContext['canvas'],
  moduleDirectory: string[],
) {
  assertRecord(value, `${moduleLabel}.actions`)

  const entries = Object.entries(value)

  if (entries.length === 0) throw new TypeError(`${moduleLabel}.actions cannot be empty`)
  if (entries.length > MAX_MODULE_ACTIONS) {
    throw new RangeError(`${moduleLabel}.actions cannot exceed ${MAX_MODULE_ACTIONS}`)
  }

  return entries.map(([localId, rawAction]) => {
    const label = `${moduleLabel}.actions.${localId}`

    assertSafeId(localId, `${moduleLabel} action id`)
    assertRecord(rawAction, label)
    assertAllowedKeys(
      rawAction,
      [
        'label',
        'animation',
        'priority',
        'cooldownMs',
        'interruptible',
        'dialogue',
        'audio',
        'stateEffect',
        'stateAnimations',
        'stateDialogues',
      ],
      label,
    )

    // 非 manual 动作没有 trigger.label，动作自身的可选名称让菜单仍能展示可读文案。
    const actionDisplayLabel = rawAction.label === undefined
      ? undefined
      : normalizeLocalizedText(rawAction.label, `${label}.label`)

    const animation = rawAction.animation === undefined
      ? undefined
      : normalizeActionAnimationReference(
          rawAction.animation,
          `${label}.animation`,
          moduleId,
          animations,
          localAnimationIds,
        )

    const dialogue = rawAction.dialogue === undefined
      ? undefined
      : normalizeDialogue(rawAction.dialogue, label, canvas)
    const audio = rawAction.audio === undefined
      ? undefined
      : normalizeAudio(rawAction.audio, label, moduleDirectory)
    const stateEffect = rawAction.stateEffect === undefined
      ? undefined
      : normalizeStateEffect(rawAction.stateEffect, label)
    const stateAnimations = rawAction.stateAnimations === undefined
      ? undefined
      : normalizeStateAnimations(
          rawAction.stateAnimations,
          label,
          moduleId,
          animations,
          localAnimationIds,
        )
    const stateDialogues = rawAction.stateDialogues === undefined
      ? undefined
      : normalizeStateDialogues(rawAction.stateDialogues, label, canvas)

    // 音频只增强一个已有动作，不单独决定状态机时长；否则无法从配置判断何时释放动作队列。
    if (!animation && !dialogue) {
      throw new TypeError(`${label} must define animation or dialogue`)
    }

    return {
      id: qualify(moduleId, localId),
      moduleId,
      label: actionDisplayLabel,
      animation,
      priority: rawAction.priority === undefined
        ? 0
        : assertBoundedInteger(rawAction.priority, 0, 99, `${label}.priority`),
      cooldownMs: rawAction.cooldownMs === undefined
        ? 0
        : assertTimerDelay(rawAction.cooldownMs, true, `${label}.cooldownMs`),
      interruptible: rawAction.interruptible === undefined
        ? true
        : assertBoolean(rawAction.interruptible, `${label}.interruptible`),
      dialogue,
      audio,
      stateEffect,
      stateAnimations,
      stateDialogues,
    } satisfies PetRuntimeAction
  })
}

function normalizeActionAnimationReference(
  value: unknown,
  label: string,
  moduleId: string,
  animations: Record<string, PetBehaviorModuleAnimationConfig>,
  localAnimationIds: Set<string>,
) {
  assertNonEmptyString(value, label)

  let animation: string

  if (value.startsWith('@model/')) {
    // 跨作用域引用必须显式写 @model/，防止模块拼写错误悄悄命中同名模型动画。
    animation = value.slice('@model/'.length)
    if (!animation || animation.includes('/')) {
      throw new TypeError(`${label} contains an invalid @model reference`)
    }
  } else {
    assertSafeId(value, label)
    animation = qualify(moduleId, value)
    if (!localAnimationIds.has(animation)) {
      throw new TypeError(`${label} references an unknown local animation`)
    }
  }

  const animationConfig = Object.prototype.hasOwnProperty.call(animations, animation)
    ? animations[animation]
    : undefined

  if (!animationConfig) throw new TypeError(`${label} references an unknown animation`)
  if (animationConfig.loop) throw new TypeError(`${label} must reference a non-looping animation`)

  return animation
}

function normalizeStateAnimations(
  value: unknown,
  actionLabel: string,
  moduleId: string,
  animations: Record<string, PetBehaviorModuleAnimationConfig>,
  localAnimationIds: Set<string>,
): PetStateAnimationVariantConfig[] {
  // 这里只解析命名空间和资源引用；match 中的 dimension/value 会在顶层状态机就绪后
  // 由 pet-behavior 的模型级校验统一确认，避免模块加载顺序影响合法性。
  const label = `${actionLabel}.stateAnimations`

  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  if (value.length > MAX_STATE_ANIMATIONS) {
    throw new RangeError(`${label} cannot exceed ${MAX_STATE_ANIMATIONS} variants`)
  }

  return value.map((candidate, index) => {
    const variantLabel = `${label}[${index}]`

    assertRecord(candidate, variantLabel)
    assertAllowedKeys(candidate, ['priority', 'match', 'animation'], variantLabel)
    assertRecord(candidate.match, `${variantLabel}.match`)
    const entries = Object.entries(candidate.match)
    if (entries.length === 0) throw new TypeError(`${variantLabel}.match cannot be empty`)
    if (entries.length > MAX_STATE_EFFECT_DIMENSIONS) {
      throw new RangeError(
        `${variantLabel}.match cannot exceed ${MAX_STATE_EFFECT_DIMENSIONS} dimensions`,
      )
    }

    const match: Record<string, string> = {}
    for (const [dimension, stateValue] of entries) {
      const normalizedDimension = assertSafeId(dimension, `${variantLabel}.match dimension`)
      match[normalizedDimension] = assertSafeId(
        stateValue,
        `${variantLabel}.match.${dimension}`,
      )
    }

    return {
      priority: candidate.priority === undefined
        ? 0
        : assertBoundedInteger(candidate.priority, 0, 99, `${variantLabel}.priority`),
      match,
      animation: normalizeActionAnimationReference(
        candidate.animation,
        `${variantLabel}.animation`,
        moduleId,
        animations,
        localAnimationIds,
      ),
    }
  })
}

function normalizeStateDialogues(
  value: unknown,
  actionLabel: string,
  canvas: PetBehaviorModuleLoadContext['canvas'],
): PetRuntimeStateDialogue[] {
  const label = `${actionLabel}.stateDialogues`

  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  if (value.length > MAX_STATE_DIALOGUES) {
    throw new RangeError(`${label} cannot exceed ${MAX_STATE_DIALOGUES} variants`)
  }

  return value.map((candidate, index) => {
    const variantLabel = `${label}[${index}]`

    assertRecord(candidate, variantLabel)
    assertAllowedKeys(candidate, ['priority', 'match', 'dialogue'], variantLabel)
    assertRecord(candidate.match, `${variantLabel}.match`)
    const entries = Object.entries(candidate.match)

    if (entries.length === 0) throw new TypeError(`${variantLabel}.match cannot be empty`)
    if (entries.length > MAX_STATE_EFFECT_DIMENSIONS) {
      throw new RangeError(
        `${variantLabel}.match cannot exceed ${MAX_STATE_EFFECT_DIMENSIONS} dimensions`,
      )
    }

    const match: Record<string, string> = {}
    for (const [dimension, stateValue] of entries) {
      const normalizedDimension = assertSafeId(dimension, `${variantLabel}.match dimension`)
      match[normalizedDimension] = assertSafeId(
        stateValue,
        `${variantLabel}.match.${dimension}`,
      )
    }

    return {
      priority: candidate.priority === undefined
        ? 0
        : assertBoundedInteger(candidate.priority, 0, 99, `${variantLabel}.priority`),
      match,
      dialogue: normalizeDialogue(candidate.dialogue, variantLabel, canvas),
    }
  })
}

function normalizeStateEffect(value: unknown, actionLabel: string): PetStateEffectConfig {
  const label = `${actionLabel}.stateEffect`

  assertRecord(value, label)
  assertAllowedKeys(value, ['when', 'priority', 'set', 'lifetime'], label)
  assertRecord(value.set, `${label}.set`)

  const stateEntries = Object.entries(value.set)

  if (stateEntries.length === 0) throw new TypeError(`${label}.set cannot be empty`)
  if (stateEntries.length > MAX_STATE_EFFECT_DIMENSIONS) {
    throw new RangeError(`${label}.set cannot exceed ${MAX_STATE_EFFECT_DIMENSIONS} dimensions`)
  }

  const set: Record<string, string> = {}

  for (const [dimension, stateValue] of stateEntries) {
    // 显式写入已校验后的字符串，避免 Object.fromEntries 保留 unknown 而削弱运行时配置类型。
    const normalizedDimension = assertSafeId(dimension, `${label}.set dimension`)
    const normalizedStateValue = assertSafeId(stateValue, `${label}.set.${dimension}`)

    set[normalizedDimension] = normalizedStateValue
  }
  const when = value.when ?? 'finished'

  if (when !== 'started' && when !== 'finished') {
    throw new TypeError(`${label}.when must be started or finished`)
  }

  const priority = value.priority === undefined
    ? 0
    : assertBoundedInteger(value.priority, 0, 99, `${label}.priority`)

  if (value.lifetime === undefined) {
    return { when, priority, set, lifetime: { type: 'session' } }
  }

  const lifetimeLabel = `${label}.lifetime`

  assertRecord(value.lifetime, lifetimeLabel)

  if (value.lifetime.type === 'session' || value.lifetime.type === 'until-input') {
    assertAllowedKeys(value.lifetime, ['type'], lifetimeLabel)

    return { when, priority, set, lifetime: { type: value.lifetime.type } }
  }

  if (value.lifetime.type === 'duration') {
    assertAllowedKeys(value.lifetime, ['type', 'durationMs'], lifetimeLabel)

    return {
      when,
      priority,
      set,
      lifetime: {
        type: 'duration',
        durationMs: assertTimerDelay(
          value.lifetime.durationMs,
          false,
          `${lifetimeLabel}.durationMs`,
        ),
      },
    }
  }

  throw new TypeError(`${lifetimeLabel}.type must be session, duration, or until-input`)
}

function normalizeAudio(
  value: unknown,
  actionLabel: string,
  moduleDirectory: string[],
): PetRuntimeAudio {
  const label = `${actionLabel}.audio`

  assertRecord(value, label)
  assertAllowedKeys(value, ['file', 'chance', 'delayMs', 'volume'], label)
  assertNonEmptyString(value.file, `${label}.file`)

  let fileParts: string[]

  if (value.file.startsWith('@model/')) {
    // 共享语音放在模型根目录时使用 @model/；不带前缀的路径仍相对当前模组，保持可移植性。
    fileParts = assertSafeRelativePath(value.file.slice('@model/'.length), `${label}.file`)
  } else {
    fileParts = [
      ...moduleDirectory,
      ...assertSafeRelativePath(value.file, `${label}.file`),
    ]
  }

  const chance = value.chance === undefined
    ? 1
    : assertPositiveNumber(value.chance, `${label}.chance`)
  const volume = value.volume === undefined
    ? 1
    : assertPositiveNumber(value.volume, `${label}.volume`)

  if (chance > 1) throw new RangeError(`${label}.chance cannot exceed 1`)
  if (volume > 1) throw new RangeError(`${label}.volume cannot exceed 1`)

  return {
    file: fileParts.join(sep()),
    chance,
    delayMs: value.delayMs === undefined
      ? 0
      : assertTimerDelay(value.delayMs, true, `${label}.delayMs`),
    volume,
  }
}

function normalizeDialogue(
  value: unknown,
  actionLabel: string,
  canvas: PetBehaviorModuleLoadContext['canvas'],
): PetRuntimeDialogue {
  const label = `${actionLabel}.dialogue`

  assertRecord(value, label)
  assertAllowedKeys(value, ['chance', 'delayMs', 'durationMs', 'anchor', 'lines'], label)

  if (!Array.isArray(value.lines) || value.lines.length === 0) {
    throw new TypeError(`${label}.lines must be a non-empty array`)
  }
  if (value.lines.length > MAX_DIALOGUE_LINES) {
    throw new RangeError(`${label}.lines cannot exceed ${MAX_DIALOGUE_LINES}`)
  }

  const lines = value.lines.map((line, index) => {
    const lineLabel = `${label}.lines[${index}]`

    if (typeof line === 'string'
      || (isRecord(line) && !Object.prototype.hasOwnProperty.call(line, 'text'))) {
      return { text: normalizeLocalizedText(line, lineLabel), weight: 1 }
    }

    assertRecord(line, lineLabel)
    assertAllowedKeys(line, ['text', 'weight'], lineLabel)

    return {
      text: normalizeLocalizedText(line.text, `${lineLabel}.text`),
      weight: line.weight === undefined
        ? 1
        : assertPositiveNumber(line.weight, `${lineLabel}.weight`),
    }
  })

  const totalWeight = lines.reduce((total, line) => total + line.weight, 0)

  if (!Number.isFinite(totalWeight)) throw new RangeError(`${label}.line weights must have a finite total`)

  let anchor: PetRuntimeDialogue['anchor']

  if (value.anchor !== undefined) {
    assertRecord(value.anchor, `${label}.anchor`)
    assertAllowedKeys(value.anchor, ['x', 'y'], `${label}.anchor`)

    const x = assertNonNegativeNumber(value.anchor.x, `${label}.anchor.x`)
    const y = assertNonNegativeNumber(value.anchor.y, `${label}.anchor.y`)

    if (x > canvas.width || y > canvas.height) {
      throw new RangeError(`${label}.anchor exceeds the model canvas`)
    }

    anchor = { x, y }
  }

  const chance = value.chance === undefined
    ? 1
    : assertPositiveNumber(value.chance, `${label}.chance`)

  if (chance > 1) throw new RangeError(`${label}.chance cannot exceed 1`)

  return {
    chance,
    delayMs: value.delayMs === undefined
      ? 0
      : assertTimerDelay(value.delayMs, true, `${label}.delayMs`),
    durationMs: value.durationMs === undefined
      ? DEFAULT_DIALOGUE_DURATION
      : assertTimerDelay(value.durationMs, false, `${label}.durationMs`),
    anchor,
    lines,
  }
}

function normalizeTriggers(
  value: unknown,
  moduleLabel: string,
  moduleId: string,
  actionIds: Set<string>,
  hitAreas: Record<string, unknown> | undefined,
) {
  if (!Array.isArray(value)) throw new TypeError(`${moduleLabel}.triggers must be an array`)
  if (value.length === 0) throw new TypeError(`${moduleLabel}.triggers cannot be empty`)
  if (value.length > MAX_MODULE_TRIGGERS) {
    throw new RangeError(`${moduleLabel}.triggers cannot exceed ${MAX_MODULE_TRIGGERS}`)
  }

  const ids = new Set<string>()

  return value.map((rawTrigger, index): PetRuntimeTrigger => {
    const label = `${moduleLabel}.triggers[${index}]`

    assertRecord(rawTrigger, label)

    const localId = assertSafeId(rawTrigger.id, `${label}.id`)

    if (ids.has(localId)) throw new TypeError(`${label}.id must be unique within its module`)

    ids.add(localId)

    const base = {
      id: qualify(moduleId, localId),
      moduleId,
    }

    if (rawTrigger.type === 'interval') {
      assertAllowedKeys(rawTrigger, ['id', 'type', 'delayMs', 'choices'], label)

      if (!Array.isArray(rawTrigger.choices) || rawTrigger.choices.length === 0) {
        throw new TypeError(`${label}.choices must be a non-empty array`)
      }
      if (rawTrigger.choices.length > MAX_MODULE_ACTIONS) {
        throw new RangeError(`${label}.choices cannot exceed ${MAX_MODULE_ACTIONS}`)
      }

      const choiceIds = new Set<string>()
      const choices = rawTrigger.choices.map((rawChoice, choiceIndex) => {
        const choiceLabel = `${label}.choices[${choiceIndex}]`

        assertRecord(rawChoice, choiceLabel)
        assertAllowedKeys(rawChoice, ['action', 'weight'], choiceLabel)

        const actionId = resolveActionId(rawChoice.action, moduleId, actionIds, `${choiceLabel}.action`)

        if (choiceIds.has(actionId)) throw new TypeError(`${choiceLabel}.action must be unique`)

        choiceIds.add(actionId)

        return {
          actionId,
          weight: assertPositiveNumber(rawChoice.weight, `${choiceLabel}.weight`),
        }
      })
      const totalWeight = choices.reduce((total, choice) => total + choice.weight, 0)

      if (!Number.isFinite(totalWeight)) {
        throw new RangeError(`${label}.choice weights must have a finite total`)
      }

      return {
        ...base,
        type: 'interval',
        delayMs: normalizeTimerRange(rawTrigger.delayMs, `${label}.delayMs`),
        choices,
      }
    }

    if (rawTrigger.type === 'idle') {
      assertAllowedKeys(
        rawTrigger,
        ['id', 'type', 'afterMs', 'repeatMs', 'action', 'oncePerIdle'],
        label,
      )

      const repeatMs = rawTrigger.repeatMs === undefined
        ? undefined
        : normalizeTimerRange(rawTrigger.repeatMs, `${label}.repeatMs`)
      const oncePerIdle = rawTrigger.oncePerIdle === undefined
        ? repeatMs === undefined
        : assertBoolean(rawTrigger.oncePerIdle, `${label}.oncePerIdle`)

      if (oncePerIdle && repeatMs) {
        throw new TypeError(`${label} cannot combine oncePerIdle with repeatMs`)
      }
      if (!oncePerIdle && !repeatMs) {
        throw new TypeError(`${label} requires repeatMs when oncePerIdle is false`)
      }

      return {
        ...base,
        type: 'idle',
        afterMs: assertTimerDelay(rawTrigger.afterMs, false, `${label}.afterMs`),
        repeatMs,
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        oncePerIdle,
      }
    }

    if (rawTrigger.type === 'schedule') {
      assertAllowedKeys(
        rawTrigger,
        ['id', 'type', 'action', 'time', 'dates', 'weekdays', 'catchUpMs', 'enterPet'],
        label,
      )

      assertNonEmptyString(rawTrigger.time, `${label}.time`)

      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rawTrigger.time)) {
        throw new TypeError(`${label}.time must use HH:mm in local time`)
      }

      return {
        ...base,
        type: 'schedule',
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        time: rawTrigger.time,
        dates: normalizeDates(rawTrigger.dates, `${label}.dates`),
        weekdays: normalizeWeekdays(rawTrigger.weekdays, `${label}.weekdays`),
        catchUpMs: rawTrigger.catchUpMs === undefined
          ? DEFAULT_SCHEDULE_CATCH_UP
          : assertBoundedNumber(
              rawTrigger.catchUpMs,
              0,
              MAX_SCHEDULE_CATCH_UP,
              `${label}.catchUpMs`,
            ),
        enterPet: rawTrigger.enterPet === undefined
          ? true
          : assertBoolean(rawTrigger.enterPet, `${label}.enterPet`),
      }
    }

    if (rawTrigger.type === 'session') {
      assertAllowedKeys(
        rawTrigger,
        ['id', 'type', 'action', 'event', 'delayMs', 'catchUpMs', 'enterPet'],
        label,
      )

      if (rawTrigger.event !== 'startup') {
        throw new TypeError(`${label}.event must be startup`)
      }

      return {
        ...base,
        type: 'session',
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        event: 'startup',
        delayMs: rawTrigger.delayMs === undefined
          ? [...DEFAULT_SESSION_DELAY]
          : normalizeTimerRange(rawTrigger.delayMs, `${label}.delayMs`),
        catchUpMs: normalizeTimerDrivenCatchUp(
          rawTrigger.catchUpMs,
          DEFAULT_SESSION_CATCH_UP,
          `${label}.catchUpMs`,
        ),
        enterPet: rawTrigger.enterPet === undefined
          ? true
          : assertBoolean(rawTrigger.enterPet, `${label}.enterPet`),
      }
    }

    if (rawTrigger.type === 'visibility-return') {
      assertAllowedKeys(
        rawTrigger,
        [
          'id',
          'type',
          'action',
          'minAwayMs',
          'maxAwayMs',
          'settleMs',
          'catchUpMs',
          'enterPet',
        ],
        label,
      )

      const minAwayMs = assertTimerDelay(rawTrigger.minAwayMs, false, `${label}.minAwayMs`)
      const maxAwayMs = rawTrigger.maxAwayMs === undefined
        ? undefined
        : assertTimerDelay(rawTrigger.maxAwayMs, false, `${label}.maxAwayMs`)

      // 空区间永远无法命中，加载时拒绝比在运行期静默失效更容易定位模型配置错误。
      if (maxAwayMs !== undefined && maxAwayMs <= minAwayMs) {
        throw new RangeError(`${label}.maxAwayMs must be greater than minAwayMs`)
      }

      return {
        ...base,
        type: 'visibility-return',
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        minAwayMs,
        maxAwayMs,
        settleMs: rawTrigger.settleMs === undefined
          ? DEFAULT_VISIBILITY_SETTLE
          : assertTimerDelay(rawTrigger.settleMs, true, `${label}.settleMs`),
        catchUpMs: normalizeTimerDrivenCatchUp(
          rawTrigger.catchUpMs,
          DEFAULT_VISIBILITY_CATCH_UP,
          `${label}.catchUpMs`,
        ),
        enterPet: rawTrigger.enterPet === undefined
          ? true
          : assertBoolean(rawTrigger.enterPet, `${label}.enterPet`),
      }
    }

    if (rawTrigger.type === 'activity-burst') {
      assertAllowedKeys(
        rawTrigger,
        [
          'id',
          'type',
          'action',
          'sources',
          'windowMs',
          'minimumEvents',
          'quietMs',
          'catchUpMs',
          'enterPet',
        ],
        label,
      )

      const windowMs = assertTimerDelay(rawTrigger.windowMs, false, `${label}.windowMs`)
      const quietMs = assertTimerDelay(rawTrigger.quietMs, false, `${label}.quietMs`)

      // quietMs 必须落在采样窗口内，否则满足事件数后，最早可执行时样本已经全部过期。
      if (quietMs >= windowMs) {
        throw new RangeError(`${label}.quietMs must be less than windowMs`)
      }

      return {
        ...base,
        type: 'activity-burst',
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        sources: normalizeActivitySources(rawTrigger.sources, `${label}.sources`),
        windowMs,
        minimumEvents: assertBoundedInteger(
          rawTrigger.minimumEvents,
          MIN_ACTIVITY_EVENTS,
          MAX_ACTIVITY_EVENTS,
          `${label}.minimumEvents`,
        ),
        quietMs,
        catchUpMs: normalizeTimerDrivenCatchUp(
          rawTrigger.catchUpMs,
          DEFAULT_ACTIVITY_CATCH_UP,
          `${label}.catchUpMs`,
        ),
        enterPet: rawTrigger.enterPet === undefined
          ? true
          : assertBoolean(rawTrigger.enterPet, `${label}.enterPet`),
      }
    }

    if (rawTrigger.type === 'active-session') {
      assertAllowedKeys(
        rawTrigger,
        [
          'id',
          'type',
          'action',
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

      const resetAfterMs = assertTimerDelay(
        rawTrigger.resetAfterMs,
        false,
        `${label}.resetAfterMs`,
      )
      const quietMs = rawTrigger.quietMs === undefined
        ? DEFAULT_ACTIVE_SESSION_QUIET
        : assertTimerDelay(rawTrigger.quietMs, false, `${label}.quietMs`)

      // quiet 是动作前的短暂停顿，reset 才代表会话结束；反过来会让一次会话永远无法结算动作。
      if (quietMs >= resetAfterMs) {
        throw new RangeError(`${label}.quietMs must be less than resetAfterMs`)
      }

      return {
        ...base,
        type: 'active-session',
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        sources: normalizeActivitySources(rawTrigger.sources, `${label}.sources`),
        afterMs: assertTimerDelay(rawTrigger.afterMs, false, `${label}.afterMs`),
        resetAfterMs,
        repeatMs: rawTrigger.repeatMs === undefined
          ? undefined
          : assertTimerDelay(rawTrigger.repeatMs, false, `${label}.repeatMs`),
        quietMs,
        catchUpMs: normalizeTimerDrivenCatchUp(
          rawTrigger.catchUpMs,
          DEFAULT_ACTIVE_SESSION_CATCH_UP,
          `${label}.catchUpMs`,
        ),
        enterPet: rawTrigger.enterPet === undefined
          ? true
          : assertBoolean(rawTrigger.enterPet, `${label}.enterPet`),
      }
    }

    if (rawTrigger.type === 'daily-window') {
      assertAllowedKeys(
        rawTrigger,
        [
          'id',
          'type',
          'action',
          'startTime',
          'endTime',
          'dates',
          'weekdays',
          'catchUpMs',
          'enterPet',
        ],
        label,
      )

      const startTime = normalizeLocalTime(rawTrigger.startTime, `${label}.startTime`)
      const endTime = normalizeLocalTime(rawTrigger.endTime, `${label}.endTime`)

      // 相同端点无法区分“空窗口”和“全天窗口”，拒绝歧义后跨午夜语义才保持唯一。
      if (startTime === endTime) {
        throw new RangeError(`${label}.startTime and endTime must be different`)
      }

      return {
        ...base,
        type: 'daily-window',
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        startTime,
        endTime,
        dates: normalizeDates(rawTrigger.dates, `${label}.dates`),
        weekdays: normalizeWeekdays(rawTrigger.weekdays, `${label}.weekdays`),
        catchUpMs: normalizeOccurrenceCatchUp(
          rawTrigger.catchUpMs,
          DEFAULT_DAILY_WINDOW_CATCH_UP,
          `${label}.catchUpMs`,
        ),
        enterPet: rawTrigger.enterPet === undefined
          ? true
          : assertBoolean(rawTrigger.enterPet, `${label}.enterPet`),
      }
    }

    if (rawTrigger.type === 'manual') {
      assertAllowedKeys(
        rawTrigger,
        ['id', 'type', 'action', 'label', 'group', 'order', 'enterPet'],
        label,
      )

      return {
        ...base,
        type: 'manual',
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        label: normalizeLocalizedText(rawTrigger.label, `${label}.label`),
        group: rawTrigger.group === undefined
          ? undefined
          : normalizeLocalizedText(rawTrigger.group, `${label}.group`),
        order: rawTrigger.order === undefined
          ? 0
          : assertBoundedInteger(rawTrigger.order, -10_000, 10_000, `${label}.order`),
        enterPet: rawTrigger.enterPet === undefined
          ? true
          : assertBoolean(rawTrigger.enterPet, `${label}.enterPet`),
      }
    }

    if (rawTrigger.type === 'pointer') {
      assertAllowedKeys(
        rawTrigger,
        ['id', 'type', 'action', 'event', 'area', 'holdMs', 'distance', 'windowMs'],
        label,
      )

      if (rawTrigger.event !== 'hover'
        && rawTrigger.event !== 'tap'
        && rawTrigger.event !== 'stroke') {
        throw new TypeError(`${label}.event must be hover, tap, or stroke`)
      }

      assertNonEmptyString(rawTrigger.area, `${label}.area`)

      if (!hitAreas || !Object.prototype.hasOwnProperty.call(hitAreas, rawTrigger.area)) {
        throw new TypeError(`${label}.area references an unknown hit area`)
      }

      const holdMs = rawTrigger.holdMs === undefined
        ? undefined
        : assertTimerDelay(rawTrigger.holdMs, false, `${label}.holdMs`)
      const distance = rawTrigger.distance === undefined
        ? undefined
        : assertPositiveNumber(rawTrigger.distance, `${label}.distance`)
      const windowMs = rawTrigger.windowMs === undefined
        ? undefined
        : assertTimerDelay(rawTrigger.windowMs, false, `${label}.windowMs`)

      if (rawTrigger.event === 'hover' && (distance !== undefined || windowMs !== undefined)) {
        throw new TypeError(`${label} hover does not support distance or windowMs`)
      }
      if (rawTrigger.event === 'stroke' && holdMs !== undefined) {
        throw new TypeError(`${label} stroke does not support holdMs`)
      }
      if (rawTrigger.event === 'tap' && distance !== undefined && distance > MAX_TAP_DISTANCE) {
        throw new RangeError(`${label}.distance cannot exceed ${MAX_TAP_DISTANCE}`)
      }
      if (rawTrigger.event === 'tap'
        && holdMs !== undefined
        && windowMs !== undefined
        && holdMs >= windowMs) {
        throw new RangeError(`${label}.holdMs must be less than windowMs`)
      }

      return {
        ...base,
        type: 'pointer',
        actionId: resolveActionId(rawTrigger.action, moduleId, actionIds, `${label}.action`),
        event: rawTrigger.event,
        area: rawTrigger.area,
        holdMs,
        distance,
        windowMs,
      }
    }

    throw new TypeError(`${label}.type is unsupported`)
  })
}

function normalizeDates(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  if (value.length > 366) throw new RangeError(`${label} cannot exceed 366 dates`)

  const dates = value.map((date, index) => {
    assertNonEmptyString(date, `${label}[${index}]`)

    const match = /^(\d{4}|\*)-(\d{2})-(\d{2})$/.exec(date)

    if (!match) throw new TypeError(`${label}[${index}] must use YYYY-MM-DD or *-MM-DD`)

    // 通配日期用闰年 2000 验证，允许合法的 *-02-29；是否命中仍由 scheduler 按实际年份判断。
    const year = match[1] === '*' ? 2000 : Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const parsed = new Date(Date.UTC(year, month - 1, day))

    if (parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day) {
      throw new RangeError(`${label}[${index}] is not a real calendar date`)
    }

    return date
  })

  if (new Set(dates).size !== dates.length) throw new TypeError(`${label} cannot contain duplicates`)

  return dates
}

function normalizeActivitySources(value: unknown, label: string): PetActivitySource[] {
  if (value === undefined) return [...DEFAULT_ACTIVITY_SOURCES]
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  if (value.length > DEFAULT_ACTIVITY_SOURCES.length) {
    throw new RangeError(`${label} cannot exceed ${DEFAULT_ACTIVITY_SOURCES.length} sources`)
  }

  const sources = value.map((source, index): PetActivitySource => {
    if (source !== 'keyboard' && source !== 'mouse' && source !== 'gamepad') {
      throw new TypeError(`${label}[${index}] must be keyboard, mouse, or gamepad`)
    }

    return source
  })

  // 去重可避免运行期一次物理事件被同一 trigger 重复计数。
  if (new Set(sources).size !== sources.length) {
    throw new TypeError(`${label} cannot contain duplicates`)
  }

  return sources
}

function normalizeLocalTime(value: unknown, label: string) {
  assertNonEmptyString(value, label)

  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new TypeError(`${label} must use HH:mm in local time`)
  }

  return value
}

function normalizeOccurrenceCatchUp(value: unknown, fallback: number, label: string) {
  return value === undefined
    ? fallback
    : assertBoundedNumber(value, 0, MAX_SCHEDULE_CATCH_UP, label)
}

function normalizeTimerDrivenCatchUp(value: unknown, fallback: number, label: string) {
  // 这四类 occurrence 由 setTimeout 直接派发；至少留一个事件循环宽限，避免合法的 0ms
  // 因回调必然晚于理论 dueAt 几个微秒而在真正执行前先被判过期。日窗口按 wall-clock 扫描，不受此限。
  return value === undefined
    ? fallback
    : assertBoundedNumber(value, MIN_TIMER_DRIVEN_CATCH_UP, MAX_SCHEDULE_CATCH_UP, label)
}

function normalizeWeekdays(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  if (value.length > 7) throw new RangeError(`${label} cannot exceed 7 weekdays`)

  const weekdays = value.map((weekday, index) => {
    return assertBoundedInteger(weekday, 1, 7, `${label}[${index}]`)
  })

  if (new Set(weekdays).size !== weekdays.length) {
    throw new TypeError(`${label} cannot contain duplicates`)
  }

  return weekdays
}

function normalizeTimerRange(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${label} must contain exactly two timer values`)
  }

  const minimum = assertTimerDelay(value[0], false, `${label}[0]`)
  const maximum = assertTimerDelay(value[1], false, `${label}[1]`)

  if (minimum > maximum) throw new RangeError(`${label} minimum cannot exceed maximum`)

  return [minimum, maximum]
}

function resolveActionId(
  value: unknown,
  moduleId: string,
  actionIds: Set<string>,
  label: string,
) {
  const localId = assertSafeId(value, label)
  const actionId = qualify(moduleId, localId)

  if (!actionIds.has(actionId)) throw new TypeError(`${label} references an unknown action`)

  return actionId
}

function normalizeLocalizedText(value: unknown, label: string): PetLocalizedText {
  if (typeof value === 'string') {
    const text = value.trim()

    if (!text) throw new TypeError(`${label} must not be empty`)
    if (text.length > MAX_TEXT_LENGTH) {
      throw new RangeError(`${label} cannot exceed ${MAX_TEXT_LENGTH} characters`)
    }

    return text
  }

  assertRecord(value, label)

  const entries = Object.entries(value)

  if (entries.length === 0) throw new TypeError(`${label} must not be empty`)
  if (entries.length > MAX_LOCALIZED_VARIANTS) {
    throw new RangeError(`${label} cannot exceed ${MAX_LOCALIZED_VARIANTS} locales`)
  }

  const normalized: Record<string, string> = {}
  const localeIds = new Set<string>()

  for (const [locale, rawText] of entries) {
    if (!LOCALE_PATTERN.test(locale) || RESERVED_IDS.has(locale.toLowerCase())) {
      throw new TypeError(`${label} contains invalid locale "${locale}"`)
    }

    const normalizedLocale = locale.toLowerCase()

    if (localeIds.has(normalizedLocale)) {
      throw new TypeError(`${label} contains duplicate locale "${locale}"`)
    }

    localeIds.add(normalizedLocale)

    if (typeof rawText !== 'string' || rawText.trim().length === 0) {
      throw new TypeError(`${label}.${locale} must be a non-empty string`)
    }
    if (rawText.trim().length > MAX_TEXT_LENGTH) {
      throw new RangeError(`${label}.${locale} cannot exceed ${MAX_TEXT_LENGTH} characters`)
    }

    normalized[locale] = rawText.trim()
  }

  return normalized
}

function assertSafeRelativePath(value: unknown, label: string) {
  assertNonEmptyString(value, label)

  // 这里先拒绝绝对路径、scheme 和目录穿越；读取时仍由 Rust canonicalize 处理符号链接边界。
  if (value.length > MAX_PATH_LENGTH
    || value.includes('\0')
    || /^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(value)) {
    throw new TypeError(`${label} must be a safe relative path`)
  }

  const parts = value.split(/[\\/]/)

  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new TypeError(`${label} must not contain empty, dot, or parent segments`)
  }

  return parts
}

function assertSafeId(value: unknown, label: string) {
  assertNonEmptyString(value, label)

  if (value.length > MAX_ID_LENGTH
    || value !== value.toLowerCase()
    || !SAFE_ID_PATTERN.test(value)
    || RESERVED_IDS.has(value.toLowerCase())) {
    throw new TypeError(`${label} contains an invalid id`)
  }

  return value
}

function qualify(moduleId: string, localId: string) {
  // loader 统一生成全局 ID，运行时无需再依赖模块加载顺序解决局部名称冲突。
  return `${moduleId}/${localId}`
}

function assertAllowedKeys(value: Record<string, unknown>, keys: string[], label: string) {
  // manifest 采用严格 schema；未知字段通常意味着拼写或版本不匹配，应在加载期 fail-fast。
  const allowed = new Set(keys)
  const unsupported = Object.keys(value).find(key => !allowed.has(key))

  if (unsupported) throw new TypeError(`${label}.${unsupported} is unsupported`)
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)

  return value
}

function assertPositiveInteger(value: unknown, label: string) {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }

  return Number(value)
}

function assertBoundedInteger(value: unknown, minimum: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }

  return Number(value)
}

function assertPositiveNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`)
  }

  return value
}

function assertNonNegativeNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number`)
  }

  return value
}

function assertBoundedNumber(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`)
  }

  return value
}

function assertTimerDelay(value: unknown, allowZero: boolean, label: string) {
  const minimum = allowZero ? 0 : 1

  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > MAX_TIMER_DELAY) {
    throw new TypeError(`${label} must be between ${minimum} and ${MAX_TIMER_DELAY}`)
  }

  return value
}
