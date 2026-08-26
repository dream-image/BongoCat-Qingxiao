import { convertFileSrc } from '@tauri-apps/api/core'

import type {
  PetAudioPayload,
  PetBehaviorConfig,
  PetPlaybackEndReason,
  PetPlaybackHandle,
  PetPlaybackResult,
  PetPlayOptions,
  PetSpeechPayload,
} from './pet-behavior'
import type { PetBehaviorRuntimeModule } from './pet-behavior-module'

import {
  readBoundedTextFile,
  readFilePrefix,
  resolveModelResourcePath,
} from './path'
import { assertPetBehaviorConfig } from './pet-behavior'
import { loadPetBehaviorModules } from './pet-behavior-module'
import { SpriteAudioPlayer, validateSpriteAudioFiles } from './sprite-audio'

export interface SpriteAnimationConfig {
  file: string
  frameWidth: number
  frameHeight: number
  frames: number
  columns: number
  fps: number
  loop: boolean
  frameDurations?: number[]
}

export type SpriteKeyboardBinding = string | string[]

export interface SpriteBindingsConfig {
  keyboard?: Record<string, SpriteKeyboardBinding>
  mouse?: Record<string, string>
}

export interface SpriteBehaviorsConfig {
  pet?: PetBehaviorConfig & {
    modules?: PetBehaviorRuntimeModule[]
  }
}

export interface SpriteBubbleConfig {
  enabled: boolean
  duration: number
  repeatInterval: number
  rise: number
  fontSize: number
  maxVisible: number
  anchorX?: number
  anchorY?: number
  fillTop: string
  fill: string
  fillBottom: string
  highlightColor: string
  stroke: string
  strokeWidth: number
  textColor: string
  shadowColor: string
  shadowBlur: number
  shadowOffsetY: number
}

export interface SpriteModelConfig {
  renderer: 'sprite'
  id?: string
  displayName?: string
  mode?: 'standard' | 'keyboard' | 'gamepad'
  canvas: {
    width: number
    height: number
  }
  defaultAnimation: string
  animations: Record<string, SpriteAnimationConfig>
  bindings?: SpriteBindingsConfig
  keyboard?: Record<string, SpriteKeyboardBinding>
  mouse?: Record<string, string>
  bubbles?: Partial<SpriteBubbleConfig>
  behaviors?: SpriteBehaviorsConfig
}

export interface SpriteModelSize {
  width: number
  height: number
}

export type SpritePlaybackEndReason = PetPlaybackEndReason
export type SpritePlaybackResult = PetPlaybackResult
export type SpritePlaybackHandle = PetPlaybackHandle
export type SpritePlayOptions = PetPlayOptions

export interface SpriteModelLoadResult {
  width: number
  height: number
  motions: Record<string, never[]>
  expressions: never[]
  defaultAnimation: string
  petBehavior?: SpriteBehaviorsConfig['pet']
}

interface LoadedAnimation {
  config: SpriteAnimationConfig
  image: HTMLImageElement
}

// 解码前的文件头尺寸与解码后的 DOM 尺寸使用同一结构，便于做两阶段一致性校验。
interface SpriteImageDimensions {
  width: number
  height: number
}

interface ActiveBubble {
  text: string
  createdAt: number
  sequence: number
}

// 对白独立保存生命周期和模型坐标锚点，避免复用按键气泡队列后互相驱逐。
interface ActiveSpeechBubble {
  text: string
  createdAt: number
  durationMs: number
  generation: number
  anchor?: {
    x: number
    y: number
  }
}

// 先产出稳定布局再绘制云朵，保证字体缩放、换行和外框预算使用同一组测量结果。
interface SpeechTextLayout {
  lines: string[]
  fontSize: number
  lineHeight: number
  width: number
}

interface ActivePlayback {
  handle: SpritePlaybackHandle
  loop: boolean
  returnTo: string
  resolve: (result: SpritePlaybackResult) => void
}

interface PressedInput {
  kind: 'keyboard' | 'mouse'
  key: string
}

// 保留动画数量和单张雪碧图上限以拦截 fan-out/单图解码炸弹；全模型累计像素不设硬阈值，允许动作模组继续扩展。
const MAX_ANIMATION_COUNT = 96
const MAX_SPRITESHEET_PIXELS = 16 * 1024 * 1024
// 并发数限制解码瞬时峰值；manifest 上限则在 JSON.parse 前约束不受信任文本的驻留量。
const MAX_CONCURRENT_IMAGE_LOADS = 4
const MAX_MODEL_MANIFEST_BYTES = 1024 * 1024
// JPEG 的尺寸标记可能位于 EXIF/ICC 段之后；512 KiB 足够兼容正常图片，同时仍让探测内存有硬上限。
const MAX_IMAGE_HEADER_BYTES = 512 * 1024

const defaultBubbleConfig: SpriteBubbleConfig = {
  enabled: true,
  duration: 900,
  repeatInterval: 300,
  rise: 48,
  fontSize: 22,
  maxVisible: 5,
  fillTop: 'rgba(255, 255, 255, 0.99)',
  fill: 'rgba(230, 250, 255, 0.98)',
  fillBottom: 'rgba(192, 235, 248, 0.97)',
  highlightColor: 'rgba(255, 255, 255, 0.92)',
  stroke: 'rgba(65, 174, 211, 0.9)',
  strokeWidth: 1.75,
  textColor: '#1f2f46',
  shadowColor: 'rgba(12, 30, 54, 0.42)',
  shadowBlur: 8,
  shadowOffsetY: 3,
}

class SpriteRenderer {
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private config: SpriteModelConfig | null = null
  private modelPath: string | null = null
  private readonly audioPlayer = new SpriteAudioPlayer()
  private animations = new Map<string, LoadedAnimation>()
  private activeAnimation = ''
  private activeFrame = 0
  private animationFinished = false
  // 每次播放都有唯一的完成句柄；新播放会以 interrupted 结算旧句柄，让上层状态机
  // 区分“自然结束”和“被输入/切模型打断”，而不是依赖脆弱的固定时长计时。
  private activePlayback: ActivePlayback | null = null
  private frameStartedAt = 0
  private animationFrameId: number | null = null
  private loadGeneration = 0
  // 只登记运行时模型加载；validateModel 必须独立遍历完整资产，不能被模型切换提前取消。
  private pendingImageLoads = new Map<number, Set<() => void>>()
  private maxFPS = 60
  private bindingIndexes = new Map<string, number>()
  private pressedKeyboard = new Map<string, string>()
  private pressedMouse = new Map<string, string>()
  // Map 的插入顺序充当跨键盘/鼠标的最近按下栈，释放当前动作后才能恢复真正最后仍按住的绑定。
  private pressedInputOrder = new Map<string, PressedInput>()
  private bubbles: ActiveBubble[] = []
  private keyboardBubbleTimestamps = new Map<string, number>()
  // 系统全局监听在不同平台对按键自动重复的上报并不一致；自行维护计时器，才能保证
  // 长按时持续冒泡且频率稳定，释放按键后再由统一出口立即停止。
  private keyboardBubbleRepeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  private bubbleConfig: SpriteBubbleConfig = { ...defaultBubbleConfig }
  private bubbleSequence = 0
  // 对白使用独立单槽，避免主动/被动动作说话时挤占连续按键的冒泡队列。
  private speechBubble: ActiveSpeechBubble | null = null
  private speechGeneration = 0
  private lastRenderAt = Number.NEGATIVE_INFINITY
  private renderPending = false
  private mirrored = false

  public async load(path: string): Promise<SpriteModelLoadResult> {
    const generation = ++this.loadGeneration

    // 新模型开始时立即中止旧代次仍在解码的图片，避免只能等浏览器网络层自然失败。
    this.abortPendingImageLoads(generation)
    this.reset()

    const { animations, config } = await this.readAndValidateModel(path, generation)

    // 图片解码是异步的；旧模型即使后完成也不能重新初始化共用 Canvas。
    if (generation !== this.loadGeneration) {
      this.releaseLoadedAnimations(animations)
      throw new DOMException('Sprite model load was superseded', 'AbortError')
    }

    try {
      this.initCanvas()

      this.config = config
      this.modelPath = path
      this.animations = new Map(animations)
      this.bubbleConfig = { ...defaultBubbleConfig, ...config.bubbles }

      this.resizeModel(config.canvas)
      this.play(config.defaultAnimation)
    } catch (error) {
      // 初始化任何一步失败都释放已解码图片并回到空状态，不能留下半套模型供 play 读取。
      this.releaseLoadedAnimations(animations)
      this.reset()

      throw error
    }

    return {
      width: config.canvas.width,
      height: config.canvas.height,
      motions: {},
      expressions: [],
      defaultAnimation: config.defaultAnimation,
      petBehavior: config.behaviors?.pet,
    }
  }

  public async validateModel(path: string, options: { decodeAssets?: boolean } = {}) {
    if (options.decodeAssets) {
      const { animations, config } = await this.readAndValidateModel(path)

      this.releaseLoadedAnimations(animations)

      return config
    }

    const config = await this.readAndValidateConfig(path)

    await this.validateAnimationResources(path, Object.entries(config.animations))

    return config
  }

  public destroy() {
    ++this.loadGeneration
    this.abortPendingImageLoads()
    this.reset()
  }

  public resizeModel(modelSize: SpriteModelSize) {
    if (!this.canvas || !this.context) return

    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth || modelSize.width)
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight || modelSize.height)
    const density = Math.max(1, window.devicePixelRatio || 1)
    const pixelWidth = Math.round(width * density)
    const pixelHeight = Math.round(height * density)

    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'

    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }

    this.context.imageSmoothingEnabled = true
    this.context.imageSmoothingQuality = 'high'

    if (this.activeAnimation) {
      this.renderFrame()
    } else {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  public play(name: string, options: SpritePlayOptions = {}): SpritePlaybackHandle | null {
    const animation = this.animations.get(name)

    if (!animation) return null

    return this.startPlayback(name, animation.config.loop, options)
  }

  public triggerKeyboardBinding(key: string): SpritePlaybackHandle | null {
    const keyboard = this.config?.bindings?.keyboard ?? this.config?.keyboard

    if (!keyboard) return null

    const bindingKey = this.resolveKeyboardBindingKey(keyboard, key)
    const binding = keyboard[bindingKey]

    if (!binding) return null

    const animationName = this.resolveKeyboardBinding(bindingKey, binding)

    // 宠物退出后按键可能已经松开，此入口只补播一次触发动作；即使资源配置为 loop，
    // 也不能无限占住画面，结束后应回到仍按住的绑定或默认动画。
    return this.startPlayback(animationName, false)
  }

  private startPlayback(
    name: string,
    loop: boolean,
    options: SpritePlayOptions = {},
  ): SpritePlaybackHandle | null {
    const animation = this.animations.get(name)
    const returnTo = options.returnTo ?? this.config?.defaultAnimation

    if (!animation || !returnTo || !this.animations.has(returnTo)) return null

    // 先结算旧句柄再替换 activePlayback，保证等待者一定收到一次且只收到一次终止原因。
    this.settleActivePlayback('interrupted')

    this.stopAnimationFrame()

    let resolveFinished!: (result: SpritePlaybackResult) => void
    const handle: SpritePlaybackHandle = {
      animation: name,
      finished: new Promise((resolve) => {
        resolveFinished = resolve
      }),
    }

    this.activeAnimation = name
    this.activeFrame = 0
    this.animationFinished = false
    this.activePlayback = {
      handle,
      loop,
      returnTo,
      resolve: resolveFinished,
    }
    const timestamp = performance.now()

    this.frameStartedAt = timestamp

    this.renderIfDue(timestamp)

    this.ensureAnimationFrame()

    return handle
  }

  public showKeyboardBubble(key: string, label?: string) {
    const timestamp = performance.now()
    const previousTimestamp = this.keyboardBubbleTimestamps.get(key)

    if (previousTimestamp !== undefined
      && timestamp - previousTimestamp < this.bubbleConfig.repeatInterval) {
      return false
    }

    const shown = this.showBubble(key, label, timestamp)

    if (shown) {
      this.keyboardBubbleTimestamps.set(key, timestamp)

      if (!this.keyboardBubbleRepeatTimers.has(key)) {
        const timer = setInterval(() => {
          this.showKeyboardBubble(key, label)
        }, this.bubbleConfig.repeatInterval)

        this.keyboardBubbleRepeatTimers.set(key, timer)
      }
    }

    return shown
  }

  private stopKeyboardBubbleRepeat(key: string) {
    const timer = this.keyboardBubbleRepeatTimers.get(key)

    if (timer !== undefined) clearInterval(timer)

    this.keyboardBubbleRepeatTimers.delete(key)
    this.keyboardBubbleTimestamps.delete(key)
  }

  public showSpeechBubble(payload: PetSpeechPayload) {
    if (!this.canvas || !this.context || !this.config) return false

    const text = payload.text.trim()

    if (!text || !Number.isFinite(payload.durationMs) || payload.durationMs <= 0) return false

    // 非有限锚点退回角色默认头部位置，不能让 NaN 扩散到 Canvas 变换并污染整帧。
    const anchor = payload.anchor
      && Number.isFinite(payload.anchor.x)
      && Number.isFinite(payload.anchor.y)
      ? { ...payload.anchor }
      : undefined
    const timestamp = performance.now()

    // generation 让替换、清除和模型销毁后的旧对白立即失效，不会在下一帧重新出现。
    this.speechBubble = {
      text,
      createdAt: timestamp,
      durationMs: payload.durationMs,
      generation: ++this.speechGeneration,
      anchor,
    }
    this.renderPending = true
    this.renderFrame(timestamp)
    this.ensureAnimationFrame()

    return true
  }

  public clearSpeechBubble() {
    const hadSpeech = this.speechBubble !== null

    ++this.speechGeneration
    this.speechBubble = null

    if (!hadSpeech) return false

    // 不等下一次角色动画帧，动作被打断时要立即擦除已经显示的对白。
    this.renderPending = true
    this.renderFrame()
    this.ensureAnimationFrame()

    return true
  }

  public playAudio(payload: PetAudioPayload) {
    if (!this.modelPath) return

    this.audioPlayer.play(this.modelPath, payload)
  }

  public stopAudio() {
    this.audioPlayer.stop()
  }

  public hasKeyboardBinding(key: string) {
    const keyboard = this.config?.bindings?.keyboard ?? this.config?.keyboard

    if (!keyboard) return false

    const bindingKey = this.resolveKeyboardBindingKey(keyboard, key)

    return Boolean(keyboard[bindingKey])
  }

  public handleKeyboardBinding(key: string, pressed: boolean, restore = true) {
    const keyboard = this.config?.bindings?.keyboard ?? this.config?.keyboard

    if (!pressed) {
      const animationName = this.pressedKeyboard.get(key)

      this.pressedKeyboard.delete(key)
      this.stopKeyboardBubbleRepeat(key)
      this.removePressedInput('keyboard', key)

      if (!keyboard) return false

      // 宠物退出等过渡期会传 restore=false：只清理物理状态，不允许 release 抢播工作动画。
      if (!restore) return animationName !== void 0

      return this.releaseBinding(animationName, () => {
        return this.resumePressedInputBinding()
      })
    }

    if (!keyboard) return false

    const bindingKey = this.resolveKeyboardBindingKey(keyboard, key)
    const binding = keyboard[bindingKey]

    if (!binding) return false

    this.pressedKeyboard.delete(key)

    const animationName = this.resolveKeyboardBinding(bindingKey, binding)

    this.pressedKeyboard.set(key, animationName)
    // 先删除再插入以更新最近按下顺序；Map.set 已存在键不会改变迭代位置。
    this.touchPressedInput('keyboard', key)

    return this.startPressedInputBinding(animationName)
  }

  public markKeyboardBindingPressed(key: string) {
    if (!this.hasKeyboardBinding(key)) return false

    this.touchPressedInput('keyboard', key)

    return true
  }

  public syncPressedKeyboardBindings(keys: readonly string[]) {
    // 模型切换时由运行时传入仍按住的重映射结果。这里仅同步状态，不展示气泡或伪造 down。
    const keyboard = this.config?.bindings?.keyboard ?? this.config?.keyboard
    const nextKeys = new Set(keys)

    for (const key of this.pressedKeyboard.keys()) {
      if (nextKeys.has(key)) continue

      this.pressedKeyboard.delete(key)
      this.removePressedInput('keyboard', key)
    }

    for (const input of Array.from(this.pressedInputOrder.values())) {
      if (input.kind === 'keyboard' && !nextKeys.has(input.key)) {
        this.removePressedInput('keyboard', input.key)
      }
    }

    if (!keyboard) {
      this.pressedKeyboard.clear()

      for (const input of Array.from(this.pressedInputOrder.values())) {
        if (input.kind === 'keyboard') this.removePressedInput('keyboard', input.key)
      }

      return false
    }

    for (const key of keys) {
      if (this.pressedKeyboard.has(key)) {
        if (!this.hasPressedInput('keyboard', key)) {
          this.touchPressedInput('keyboard', key)
        }

        continue
      }

      const bindingKey = this.resolveKeyboardBindingKey(keyboard, key)
      const binding = keyboard[bindingKey]

      if (!binding) continue

      this.pressedKeyboard.set(
        key,
        this.resolveKeyboardBinding(bindingKey, binding),
      )

      if (!this.hasPressedInput('keyboard', key)) {
        this.touchPressedInput('keyboard', key)
      }
    }

    return this.pressedKeyboard.size > 0
  }

  public playPressedKeyboardBinding(key: string) {
    const animationName = this.pressedKeyboard.get(key)

    return animationName
      ? this.startPressedInputBinding(animationName)
      : false
  }

  public resumePressedInputBinding() {
    // 当前动作结束/释放后优先恢复最近仍按住的循环动作，无可恢复项才回默认动画。
    const animationName = this.lastPressedLoopingAnimation()

    if (!animationName) return this.playDefault()
    if (animationName === this.activeAnimation && !this.animationFinished) return true

    return this.startPressedInputBinding(animationName)
  }

  public handleKeyboard(key: string, pressed: boolean, label?: string) {
    const animationPlayed = this.handleKeyboardBinding(key, pressed)

    if (!pressed) return animationPlayed

    const bubbleShown = this.showKeyboardBubble(key, label)

    return animationPlayed || bubbleShown
  }

  public handleMouse(button: string, pressed: boolean, restore = true) {
    const mouse = this.config?.bindings?.mouse ?? this.config?.mouse

    if (!pressed) {
      const animationName = this.pressedMouse.get(button)

      this.pressedMouse.delete(button)
      this.removePressedInput('mouse', button)

      if (!mouse) return false

      // 与键盘使用同一恢复规则，防止跨设备同时按住时释放一个输入错误回到默认动画。
      if (!restore) return animationName !== void 0

      return this.releaseBinding(animationName, () => {
        return this.resumePressedInputBinding()
      })
    }

    if (!mouse) return false

    const animationName = mouse[button] ?? mouse['*']

    if (!animationName) return false

    this.pressedMouse.delete(button)
    this.pressedMouse.set(button, animationName)
    this.touchPressedInput('mouse', button)

    return this.startPressedInputBinding(animationName)
  }

  public setMaxFPS(fps: number) {
    if (!Number.isFinite(fps)) return

    this.maxFPS = fps > 0 ? Math.max(1, fps) : Number.POSITIVE_INFINITY
  }

  public setMotionSoundEnabled(enabled: boolean) {
    this.audioPlayer.setEnabled(enabled)
  }

  public setMirrored(mirrored: boolean) {
    this.mirrored = mirrored

    this.renderFrame()
  }

  private readonly tick = (timestamp: number) => {
    this.animationFrameId = null

    const previousBubbleCount = this.bubbles.length

    this.bubbles = this.bubbles.filter((bubble) => {
      return timestamp - bubble.createdAt < this.bubbleConfig.duration
    })

    const currentSpeech = this.speechBubble
    const speechExpired = Boolean(currentSpeech
      && (currentSpeech.generation !== this.speechGeneration
        || timestamp - currentSpeech.createdAt >= currentSpeech.durationMs))

    if (speechExpired) {
      this.speechBubble = null
    }

    const animation = this.animations.get(this.activeAnimation)

    this.renderPending ||= previousBubbleCount !== this.bubbles.length || speechExpired

    let animationFinishedNow = false

    if (animation && !this.animationFinished) {
      let elapsed = timestamp - this.frameStartedAt
      let remainingAdvances = animation.config.frames * 2

      while (remainingAdvances > 0) {
        const frameDuration = this.getFrameDuration(animation.config, this.activeFrame)

        if (elapsed < frameDuration) break

        this.frameStartedAt += frameDuration
        elapsed -= frameDuration
        remainingAdvances--

        if (this.activeFrame + 1 < animation.config.frames) {
          this.activeFrame++
          this.renderPending = true

          continue
        }

        // loop 属于本次播放语义而不只属于资源配置，按键可把同一资源作为一次性动作触发。
        if (this.activePlayback?.loop) {
          this.activeFrame = 0
          this.renderPending = true

          continue
        }

        this.animationFinished = true
        animationFinishedNow = true

        const completedAnimation = this.activeAnimation
        const completedPlaybackLoop = this.activePlayback?.loop
        const returnTo = this.activePlayback?.returnTo
        // 循环资源被强制按 one-shot 播放时，即使 returnTo 同名也要重启其循环语义；
        // 普通同名返回则保持当前末帧，避免无意义地重新创建播放句柄。
        const shouldReturn = Boolean(returnTo
          && (returnTo !== completedAnimation
            || (completedPlaybackLoop === false
              && this.animations.get(returnTo)?.config.loop)))

        this.settleActivePlayback('finished')

        // 先结算完成句柄，再启动 returnTo；否则启动新播放会把刚完成的句柄标成 interrupted。
        if (returnTo && shouldReturn) {
          this.play(returnTo)

          return
        }

        this.renderPending = true

        break
      }

      if (remainingAdvances === 0) {
        // 长时间挂起后限制单帧追赶次数，避免恢复窗口时在主线程无限补帧。
        this.frameStartedAt = timestamp
      }
    }

    const renderInterval = 1000 / this.maxFPS
    const bubbleExpired = previousBubbleCount > 0 && this.bubbles.length === 0

    if (this.bubbles.length > 0) {
      this.renderPending = true
    }

    if (this.speechBubble) {
      // 对白自身有浮动、回弹和淡出，即使人物停在单帧也要持续请求绘制。
      this.renderPending = true
    }

    if (bubbleExpired || speechExpired || animationFinishedNow
      || (this.renderPending && timestamp - this.lastRenderAt >= renderInterval)) {
      this.renderFrame(timestamp)
    }

    this.ensureAnimationFrame()
  }

  private initCanvas() {
    const canvas = document.getElementById('spriteCanvas')

    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new TypeError('Canvas #spriteCanvas was not found')
    }

    const context = canvas.getContext('2d', { alpha: true })

    if (!context) {
      throw new Error('Canvas 2D is unavailable')
    }

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'

    this.canvas = canvas
    this.context = context
  }

  private renderFrame(timestamp = performance.now()) {
    if (!this.canvas || !this.context || !this.config) return

    const animation = this.animations.get(this.activeAnimation)

    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)

    if (animation) {
      const { frameWidth, frameHeight, columns } = animation.config
      const column = this.activeFrame % columns
      const row = Math.floor(this.activeFrame / columns)
      const canvasWidth = this.config.canvas.width
      const canvasHeight = this.config.canvas.height
      const frameScale = Math.min(canvasWidth / frameWidth, canvasHeight / frameHeight)
      // 模型画布和实际窗口都采用 contain 居中，必须与指针命中坐标的逆变换保持一致。
      const viewportScale = Math.min(
        this.canvas.width / canvasWidth,
        this.canvas.height / canvasHeight,
      )
      const targetWidth = frameWidth * frameScale * viewportScale
      const targetHeight = frameHeight * frameScale * viewportScale
      const targetX = (this.canvas.width - targetWidth) / 2
      const targetY = (this.canvas.height - targetHeight) / 2

      this.context.save()

      if (this.mirrored) {
        this.context.translate(this.canvas.width, 0)
        this.context.scale(-1, 1)
      }

      this.context.drawImage(
        animation.image,
        column * frameWidth,
        row * frameHeight,
        frameWidth,
        frameHeight,
        targetX,
        targetY,
        targetWidth,
        targetHeight,
      )

      this.context.restore()
    }

    this.renderBubbles(timestamp)
    // 对白绘制在按键气泡之上，但状态完全分离，彼此的过期和替换不会互相清理。
    this.renderSpeechBubble(timestamp)

    this.lastRenderAt = timestamp
    this.renderPending = false
  }

  private renderBubbles(timestamp: number) {
    if (!this.canvas || !this.context || !this.config || !this.bubbleConfig.enabled) return

    const viewportScale = Math.min(
      this.canvas.width / this.config.canvas.width,
      this.canvas.height / this.config.canvas.height,
    )
    const rise = this.bubbleConfig.rise * viewportScale
    const modelOffsetX = (this.canvas.width - this.config.canvas.width * viewportScale) / 2
    const modelOffsetY = (this.canvas.height - this.config.canvas.height * viewportScale) / 2
    const anchorX = modelOffsetX
      + (this.bubbleConfig.anchorX ?? this.config.canvas.width / 2) * viewportScale
    const anchorY = modelOffsetY
      + (this.bubbleConfig.anchorY ?? this.config.canvas.height * 0.2) * viewportScale
    const slotSpan = Math.min(
      this.bubbleConfig.fontSize * viewportScale * 3.6,
      this.canvas.width / (this.bubbleConfig.maxVisible + 1),
    )

    for (const bubble of this.bubbles) {
      const progress = (timestamp - bubble.createdAt) / this.bubbleConfig.duration

      if (progress < 0 || progress >= 1) continue

      const slot = bubble.sequence % this.bubbleConfig.maxVisible
      // 气泡从模型坐标锚点交替向两侧分槽，既从琴中央上浮，也避免连续按键完全重叠。
      const slotDirection = slot % 2 === 0 ? 1 : -1
      const slotDistance = Math.floor(slot / 2) + 0.62
      const slotOffset = slotDistance * slotDirection
      const fontSize = this.fitBubbleFontSize(bubble.text, viewportScale)
      const paddingX = fontSize * 0.78
      const cloudHeight = fontSize * 1.82
      const tailHeight = fontSize * 0.34

      this.context.save()
      this.context.font = this.getBubbleFont(bubble.text, fontSize)

      const textWidth = this.context.measureText(bubble.text).width
      const cloudWidth = Math.max(cloudHeight * 1.08, textWidth + paddingX * 2)
      const halfWidth = cloudWidth / 2
      const margin = Math.max(
        3,
        (this.bubbleConfig.shadowBlur + Math.abs(this.bubbleConfig.shadowOffsetY)
          + this.bubbleConfig.strokeWidth + 2) * viewportScale,
      )
      const enterProgress = Math.min(1, progress / 0.18)
      const exitProgress = Math.max(0, Math.min(1, (progress - 0.72) / 0.28))
      const separationProgress = this.smoothstep(Math.min(1, progress / 0.14))
      const motionProgress = this.smoothstep(Math.min(1, progress / 0.12))
      const riseProgress = 1 - (1 - progress) ** 1.22
      const phase = progress * Math.PI * 3.2 + bubble.sequence * 1.31
      const softSway = Math.sin(phase) * fontSize * 0.1 * motionProgress
      const unclampedTipX = anchorX
        + slotOffset * slotSpan * separationProgress
        + softSway
      const tailTipX = Math.max(
        halfWidth + margin,
        Math.min(this.canvas.width - halfWidth - margin, unclampedTipX),
      )
      const tailTipY = anchorY
        + Math.abs(slotOffset) * fontSize * 0.18 * separationProgress
        - riseProgress * rise
        + Math.sin(phase * 0.72) * fontSize * 0.035 * motionProgress
      const enterScale = 0.62 + 0.38 * this.easeOutBack(enterProgress)
      // 回弹叠加轻微 squash/stretch 和呼吸摆动，形成柔软感；退出阶段只轻收缩并淡出。
      const squashStretch = Math.sin(enterProgress * Math.PI) * (1 - enterProgress * 0.35)
      const breathing = Math.sin(phase * 0.82)
      const exitScale = 1 - this.smoothstep(exitProgress) * 0.09
      const scaleX = enterScale * (1 - squashStretch * 0.11 + breathing * 0.018) * exitScale
      const scaleY = enterScale * (1 + squashStretch * 0.14 - breathing * 0.022) * exitScale
      const rotation = Math.sin(phase * 0.6) * 0.018 * motionProgress
      const opacity = (0.86 + this.smoothstep(enterProgress) * 0.14)
        * (1 - this.smoothstep(exitProgress))
      const asymmetry = ((bubble.sequence * 37) % 7 - 3) / 3

      this.context.translate(tailTipX, tailTipY)
      this.context.rotate(rotation)
      this.context.scale(scaleX, scaleY)
      this.traceCloudBubblePath(cloudWidth, cloudHeight, tailHeight, asymmetry)

      const fill = this.context.createLinearGradient(
        0,
        -tailHeight - cloudHeight,
        0,
        -tailHeight,
      )

      fill.addColorStop(0, this.bubbleConfig.fillTop)
      fill.addColorStop(0.52, this.bubbleConfig.fill)
      fill.addColorStop(1, this.bubbleConfig.fillBottom)

      this.context.globalAlpha = opacity
      this.context.fillStyle = fill
      this.context.strokeStyle = this.bubbleConfig.stroke
      this.context.lineWidth = Math.max(1, viewportScale * this.bubbleConfig.strokeWidth)
      this.context.lineJoin = 'round'
      this.context.shadowColor = this.bubbleConfig.shadowColor
      this.context.shadowBlur = this.bubbleConfig.shadowBlur * viewportScale
      this.context.shadowOffsetY = this.bubbleConfig.shadowOffsetY * viewportScale
      this.context.fill()
      this.context.stroke()

      this.context.shadowColor = 'transparent'
      this.context.shadowBlur = 0
      this.context.shadowOffsetY = 0

      this.context.save()
      this.context.clip()
      this.traceCloudHighlight(cloudWidth, cloudHeight, tailHeight, asymmetry)
      this.context.strokeStyle = this.bubbleConfig.highlightColor
      this.context.lineWidth = Math.max(1.2, fontSize * 0.065)
      this.context.lineCap = 'round'
      this.context.globalAlpha = opacity * 0.86
      this.context.stroke()

      const glint = this.context.createRadialGradient(
        -cloudWidth * 0.23,
        -tailHeight - cloudHeight * 0.7,
        0,
        -cloudWidth * 0.23,
        -tailHeight - cloudHeight * 0.7,
        fontSize * 0.16,
      )

      glint.addColorStop(0, this.bubbleConfig.highlightColor)
      glint.addColorStop(1, 'rgba(255, 255, 255, 0)')
      this.context.fillStyle = glint
      this.context.beginPath()
      this.context.arc(
        -cloudWidth * 0.23,
        -tailHeight - cloudHeight * 0.7,
        fontSize * 0.16,
        0,
        Math.PI * 2,
      )
      this.context.fill()
      this.context.restore()

      this.context.fillStyle = this.bubbleConfig.textColor
      this.context.textAlign = 'center'
      this.context.textBaseline = 'middle'
      this.context.lineWidth = Math.max(1.5, fontSize * 0.09)
      this.context.strokeStyle = 'rgba(255, 255, 255, 0.74)'
      this.context.strokeText(bubble.text, 0, -tailHeight - cloudHeight * 0.47)
      this.context.fillText(bubble.text, 0, -tailHeight - cloudHeight * 0.47)
      this.context.restore()
    }
  }

  private renderSpeechBubble(timestamp: number) {
    const bubble = this.speechBubble

    if (!this.canvas || !this.context || !this.config || !bubble) return
    if (bubble.generation !== this.speechGeneration) return

    const progress = (timestamp - bubble.createdAt) / bubble.durationMs

    if (progress < 0 || progress >= 1) return

    // 对白与人物共用 contain 变换，窗口缩放后尾巴仍指向模型内的同一语义位置。
    const viewportScale = Math.min(
      this.canvas.width / this.config.canvas.width,
      this.canvas.height / this.config.canvas.height,
    )
    const modelOffsetX = (this.canvas.width - this.config.canvas.width * viewportScale) / 2
    const modelOffsetY = (this.canvas.height - this.config.canvas.height * viewportScale) / 2
    const configuredAnchorX = bubble.anchor?.x ?? this.config.canvas.width * 0.68
    const configuredAnchorY = bubble.anchor?.y ?? this.config.canvas.height * 0.3
    // 人物镜像时，对白的模型坐标也要镜像；否则尾巴会指向原位置而不是当前头部。
    const logicalAnchorX = this.mirrored
      ? this.config.canvas.width - configuredAnchorX
      : configuredAnchorX
    const anchorX = modelOffsetX
      + Math.max(0, Math.min(this.config.canvas.width, logicalAnchorX)) * viewportScale
    const anchorY = modelOffsetY
      + Math.max(0, Math.min(this.config.canvas.height, configuredAnchorY)) * viewportScale
    const margin = Math.max(
      4,
      (this.bubbleConfig.shadowBlur + Math.abs(this.bubbleConfig.shadowOffsetY)
        + this.bubbleConfig.strokeWidth + 3) * viewportScale,
    )
    const maximumScale = 1.16
    const maximumCloudWidth = Math.max(
      1,
      (this.canvas.width - margin * 2) / maximumScale,
    )
    const layout = this.fitSpeechText(bubble.text, viewportScale, maximumCloudWidth)
    const paddingX = layout.fontSize * 0.86
    const paddingY = layout.fontSize * 0.5
    const cloudHeight = layout.lineHeight * layout.lines.length + paddingY * 2
    const tailHeight = layout.fontSize * 0.38
    const cloudWidth = Math.min(
      maximumCloudWidth,
      Math.max(cloudHeight * 1.05, layout.width + paddingX * 2),
    )
    const enterProgress = Math.min(1, progress / 0.2)
    const exitProgress = Math.max(0, Math.min(1, (progress - 0.76) / 0.24))
    const floatProgress = this.smoothstep(Math.min(1, progress / 0.18))
    const phase = progress * Math.PI * 2.6 + bubble.generation * 0.47
    const enterScale = 0.66 + 0.34 * this.easeOutBack(enterProgress)
    const squashStretch = Math.sin(enterProgress * Math.PI) * (1 - enterProgress * 0.42)
    const exitScale = 1 - this.smoothstep(exitProgress) * 0.08
    const scaleX = enterScale * (1 - squashStretch * 0.08) * exitScale
    const scaleY = enterScale * (1 + squashStretch * 0.12) * exitScale
    const opacity = (0.84 + this.smoothstep(enterProgress) * 0.16)
      * (1 - this.smoothstep(exitProgress))
    const rotation = Math.sin(phase * 0.72) * 0.012 * floatProgress
    const halfWidthBound = cloudWidth * maximumScale / 2 + margin
    const topBound = (cloudHeight + tailHeight) * maximumScale + margin
    const floatingX = Math.sin(phase * 0.61) * layout.fontSize * 0.045 * floatProgress
    const floatingY = Math.sin(phase) * layout.fontSize * 0.075 * floatProgress
      - this.smoothstep(progress) * layout.fontSize * 0.18
    // 气泡整体（含回弹、阴影）按画布夹紧，窗口极窄或人物靠边时也不会被裁切。
    const tailTipX = Math.max(
      halfWidthBound,
      Math.min(this.canvas.width - halfWidthBound, anchorX + floatingX),
    )
    const tailTipY = Math.max(
      topBound,
      Math.min(this.canvas.height - margin, anchorY + floatingY),
    )
    const asymmetry = ((bubble.generation * 31) % 7 - 3) / 3

    this.context.save()
    this.context.translate(tailTipX, tailTipY)
    this.context.rotate(rotation)
    this.context.scale(scaleX, scaleY)
    this.traceCloudBubblePath(cloudWidth, cloudHeight, tailHeight, asymmetry)

    const fill = this.context.createLinearGradient(
      0,
      -tailHeight - cloudHeight,
      0,
      -tailHeight,
    )

    fill.addColorStop(0, this.bubbleConfig.fillTop)
    fill.addColorStop(0.5, this.bubbleConfig.fill)
    fill.addColorStop(1, this.bubbleConfig.fillBottom)

    this.context.globalAlpha = opacity
    this.context.fillStyle = fill
    this.context.strokeStyle = this.bubbleConfig.stroke
    this.context.lineWidth = Math.max(1, viewportScale * this.bubbleConfig.strokeWidth)
    this.context.lineJoin = 'round'
    this.context.shadowColor = this.bubbleConfig.shadowColor
    this.context.shadowBlur = this.bubbleConfig.shadowBlur * viewportScale
    this.context.shadowOffsetY = this.bubbleConfig.shadowOffsetY * viewportScale
    this.context.fill()
    this.context.stroke()

    this.context.shadowColor = 'transparent'
    this.context.shadowBlur = 0
    this.context.shadowOffsetY = 0
    this.context.save()
    this.context.clip()
    this.traceCloudHighlight(cloudWidth, cloudHeight, tailHeight, asymmetry)
    this.context.strokeStyle = this.bubbleConfig.highlightColor
    this.context.lineWidth = Math.max(1.2, layout.fontSize * 0.06)
    this.context.lineCap = 'round'
    this.context.globalAlpha = opacity * 0.88
    this.context.stroke()
    this.context.restore()

    this.context.font = this.getBubbleFont(bubble.text, layout.fontSize)
    this.context.fillStyle = this.bubbleConfig.textColor
    this.context.strokeStyle = 'rgba(255, 255, 255, 0.76)'
    this.context.lineWidth = Math.max(1.5, layout.fontSize * 0.085)
    this.context.textAlign = 'center'
    this.context.textBaseline = 'middle'

    const textCenterY = -tailHeight - cloudHeight / 2
    const firstLineY = textCenterY - (layout.lines.length - 1) * layout.lineHeight / 2

    layout.lines.forEach((line, index) => {
      const lineY = firstLineY + index * layout.lineHeight

      this.context?.strokeText(line, 0, lineY)
      this.context?.fillText(line, 0, lineY)
    })
    this.context.restore()
  }

  private traceCloudBubblePath(
    width: number,
    height: number,
    tailHeight: number,
    asymmetry: number,
  ) {
    if (!this.context) return

    const left = -width / 2
    const right = width / 2
    const top = -tailHeight - height
    const bottom = -tailHeight
    const tailWidth = tailHeight * 1.18
    const crestShift = asymmetry * width * 0.035

    this.context.beginPath()
    this.context.moveTo(-tailWidth, bottom)
    this.context.bezierCurveTo(
      -width * 0.2,
      bottom + height * 0.035,
      left + width * 0.18,
      bottom + height * 0.02,
      left + width * 0.1,
      bottom - height * 0.17,
    )
    this.context.bezierCurveTo(
      left - width * 0.018,
      bottom - height * 0.24,
      left - width * 0.018,
      bottom - height * 0.42,
      left + width * 0.09,
      bottom - height * 0.5,
    )
    this.context.bezierCurveTo(
      left + width * 0.02,
      top + height * 0.27,
      left + width * 0.12,
      top + height * 0.13,
      left + width * 0.27,
      top + height * 0.2,
    )
    this.context.bezierCurveTo(
      left + width * 0.29,
      top + height * 0.045,
      left + width * 0.43,
      top - height * 0.035,
      left + width * 0.55 + crestShift,
      top + height * 0.07,
    )
    this.context.bezierCurveTo(
      left + width * 0.67,
      top - height * 0.005,
      left + width * 0.77,
      top + height * 0.055,
      right - width * 0.18,
      top + height * 0.19,
    )
    this.context.bezierCurveTo(
      right - width * 0.035,
      top + height * 0.16,
      right + width * 0.016,
      top + height * 0.35,
      right - width * 0.03,
      bottom - height * 0.49,
    )
    this.context.bezierCurveTo(
      right + width * 0.015,
      bottom - height * 0.3,
      right - width * 0.07,
      bottom - height * 0.11,
      right - width * 0.2,
      bottom - height * 0.13,
    )
    this.context.bezierCurveTo(
      right - width * 0.27,
      bottom + height * 0.025,
      width * 0.2,
      bottom + height * 0.035,
      tailWidth,
      bottom,
    )
    this.context.bezierCurveTo(
      tailWidth * 0.8,
      bottom + tailHeight * 0.48,
      tailWidth * 0.38,
      -tailHeight * 0.06,
      0,
      0,
    )
    this.context.bezierCurveTo(
      -tailWidth * 0.38,
      -tailHeight * 0.06,
      -tailWidth * 0.8,
      bottom + tailHeight * 0.48,
      -tailWidth,
      bottom,
    )
    this.context.closePath()
  }

  private traceCloudHighlight(
    width: number,
    height: number,
    tailHeight: number,
    asymmetry: number,
  ) {
    if (!this.context) return

    const top = -tailHeight - height

    this.context.beginPath()
    this.context.moveTo(-width * 0.32, top + height * 0.34)
    this.context.bezierCurveTo(
      -width * 0.23,
      top + height * 0.11,
      -width * 0.09 + asymmetry * width * 0.015,
      top + height * 0.08,
      width * 0.03,
      top + height * 0.16,
    )
    this.context.bezierCurveTo(
      width * 0.14,
      top + height * 0.08,
      width * 0.25,
      top + height * 0.16,
      width * 0.31,
      top + height * 0.28,
    )
  }

  private smoothstep(value: number) {
    return value * value * (3 - 2 * value)
  }

  private easeOutBack(value: number) {
    const overshoot = 1.70158
    const shifted = value - 1

    return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2
  }

  private fitBubbleFontSize(text: string, viewportScale: number) {
    if (!this.context || !this.canvas) return this.bubbleConfig.fontSize * viewportScale

    const fontSize = this.bubbleConfig.fontSize * viewportScale

    this.context.font = this.getBubbleFont(text, fontSize)

    const textWidth = this.context.measureText(text).width
    const maxTextWidth = this.canvas.width * 0.8 - fontSize * 1.3

    if (textWidth <= maxTextWidth) return fontSize

    return Math.max(fontSize * 0.55, fontSize * (maxTextWidth / textWidth))
  }

  private fitSpeechText(
    text: string,
    viewportScale: number,
    maximumCloudWidth: number,
  ): SpeechTextLayout {
    if (!this.context || !this.canvas) {
      return { lines: [text], fontSize: 1, lineHeight: 1.2, width: 1 }
    }

    // 云朵最多承载两行；先逐级缩小字号，达到可读下限后才截断，避免短句也被过早省略。
    const maximumFontSize = Math.max(
      1,
      Math.min(25 * viewportScale, this.canvas.height * 0.09),
    )
    const minimumFontSize = Math.max(1, maximumFontSize * 0.56)
    const maximumTextWidth = Math.max(
      1,
      maximumCloudWidth - maximumFontSize * 1.72,
    )
    let fontSize = maximumFontSize
    let lines = [text]
    let width = Number.POSITIVE_INFINITY

    while (fontSize >= minimumFontSize) {
      this.context.font = this.getBubbleFont(text, fontSize)

      const candidate = this.splitSpeechText(text, maximumTextWidth)

      lines = candidate.lines
      width = candidate.width

      if (candidate.fits) break

      fontSize -= Math.max(0.5, viewportScale)
    }

    fontSize = Math.max(minimumFontSize, fontSize)
    this.context.font = this.getBubbleFont(text, fontSize)

    // 两行仍放不下时只在末尾省略，保持云朵尺寸稳定而不是让长文冲出画布。
    if (width > maximumTextWidth) {
      lines = lines.map(line => this.ellipsizeSpeechLine(line, maximumTextWidth))
      width = Math.max(...lines.map(line => this.context?.measureText(line).width ?? 0))
    }

    return {
      lines: lines.slice(0, 2),
      fontSize,
      lineHeight: fontSize * 1.2,
      width,
    }
  }

  private getBubbleFont(text: string, fontSize: number) {
    if (/\p{Script=Han}/u.test(text)) {
      return `400 ${fontSize}px "huangkaihuaLawyerfont", "Xingkai SC", STXingkai, KaiTi, "Kaiti SC", cursive`
    }

    return `700 ${fontSize}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`
  }

  private splitSpeechText(text: string, maximumWidth: number) {
    if (!this.context) return { lines: [text], width: maximumWidth, fits: false }

    const normalized = text.replace(/\s*\n\s*/g, '\n').trim()
    const explicitLines = normalized.split('\n')

    if (explicitLines.length > 1) {
      const lines = [explicitLines[0], explicitLines.slice(1).join(' ')].map(line => line.trim())
      const width = Math.max(...lines.map(line => this.context?.measureText(line).width ?? 0))

      return { lines, width, fits: width <= maximumWidth }
    }

    const fullWidth = this.context.measureText(normalized).width

    if (fullWidth <= maximumWidth) {
      return { lines: [normalized], width: fullWidth, fits: true }
    }

    const characters = Array.from(normalized)
    let bestLines = [normalized]
    let bestWidth = fullWidth
    let bestScore = Number.POSITIVE_INFINITY

    for (let index = 1; index < characters.length; index++) {
      const left = characters.slice(0, index).join('').trimEnd()
      const right = characters.slice(index).join('').trimStart()

      if (!left || !right) continue

      const leftWidth = this.context.measureText(left).width
      const rightWidth = this.context.measureText(right).width
      const candidateWidth = Math.max(leftWidth, rightWidth)
      // 英文单词内部断行的代价更高；中文仍按字宽寻找最均衡的两行切点。
      const breaksAsciiWord = /[a-z0-9]$/i.test(left) && /^[a-z0-9]/i.test(right)
      const score = candidateWidth
        + Math.abs(leftWidth - rightWidth) * 0.08
        + (breaksAsciiWord ? maximumWidth * 0.28 : 0)

      if (score >= bestScore) continue

      bestScore = score
      bestWidth = candidateWidth
      bestLines = [left, right]
    }

    return {
      lines: bestLines,
      width: bestWidth,
      fits: bestLines.length <= 2 && bestWidth <= maximumWidth,
    }
  }

  private ellipsizeSpeechLine(line: string, maximumWidth: number) {
    if (!this.context || this.context.measureText(line).width <= maximumWidth) return line

    const characters = Array.from(line)
    const ellipsis = '…'

    while (characters.length > 0) {
      characters.pop()

      const candidate = `${characters.join('').trimEnd()}${ellipsis}`

      if (this.context.measureText(candidate).width <= maximumWidth) return candidate
    }

    return ellipsis
  }

  private showBubble(key: string, label: string | undefined, timestamp: number) {
    if (!this.canvas || !this.context || !this.config || !this.bubbleConfig.enabled) return false

    const actualLabel = label?.trim()
    const bubbleLabel = actualLabel
      && this.isDisplayableLabel(actualLabel)
      ? actualLabel
      : this.formatKeyLabel(key)

    this.bubbles.push({
      text: bubbleLabel,
      createdAt: timestamp,
      sequence: this.bubbleSequence++,
    })

    if (this.bubbles.length > this.bubbleConfig.maxVisible) {
      this.bubbles.splice(0, this.bubbles.length - this.bubbleConfig.maxVisible)
    }

    this.renderPending = true
    this.renderFrame(timestamp)
    this.ensureAnimationFrame()

    return true
  }

  private formatKeyLabel(key: string) {
    const letter = /^Key([A-Z])$/.exec(key)

    if (letter) return letter[1]

    const number = /^(?:Num|Digit)(\d)$/.exec(key)

    if (number) return number[1]

    const numpadNumber = /^Kp(\d)$/.exec(key)

    if (numpadNumber) return `Num ${numpadNumber[1]}`

    if (key === 'Return' || key === 'Enter') return 'Enter'
    if (key === 'KpReturn') return 'Num Enter'
    if (key === 'Space') return 'Space'
    if (key === 'BackQuote' || key === 'Backquote') return '`'

    const symbols: Record<string, string> = {
      Alt: 'Alt',
      AltGr: 'AltGr',
      Backspace: 'Backspace',
      CapsLock: 'Caps Lock',
      ControlLeft: 'Left Ctrl',
      ControlRight: 'Right Ctrl',
      Delete: 'Delete',
      End: 'End',
      Escape: 'Esc',
      Home: 'Home',
      ShiftLeft: 'Left Shift',
      ShiftRight: 'Right Shift',
      MetaLeft: 'Left Meta',
      MetaRight: 'Right Meta',
      PageDown: 'Page Down',
      PageUp: 'Page Up',
      Tab: 'Tab',
      LeftArrow: '←',
      RightArrow: '→',
      UpArrow: '↑',
      DownArrow: '↓',
      Function: 'Fn',
      KpMinus: 'Num -',
      KpPlus: 'Num +',
      KpMultiply: 'Num ×',
      KpDivide: 'Num ÷',
      KpDecimal: 'Num .',
      KpEqual: 'Num =',
      KpComma: 'Num ,',
      Minus: '-',
      Equal: '=',
      Comma: ',',
      Dot: '.',
      Slash: '/',
      SemiColon: ';',
      Quote: '\'',
      LeftBracket: '[',
      RightBracket: ']',
      BackSlash: '\\',
    }

    return symbols[key] ?? key
  }

  private resolveKeyboardBindingKey(
    keyboard: Record<string, SpriteKeyboardBinding>,
    key: string,
  ) {
    const candidates = key === 'Return'
      ? [key, 'Enter']
      : key === 'Enter'
        ? [key, 'Return']
        : [key]

    return candidates.find((candidate) => {
      return Object.prototype.hasOwnProperty.call(keyboard, candidate)
    }) ?? '*'
  }

  private resolveKeyboardBinding(bindingKey: string, binding: SpriteKeyboardBinding) {
    if (typeof binding === 'string') return binding

    const index = this.bindingIndexes.get(bindingKey) ?? 0

    this.bindingIndexes.set(bindingKey, index + 1)

    return binding[index % binding.length]
  }

  private releaseBinding(animationName: string | undefined, resume: () => boolean) {
    // 只有释放的键正在驱动循环动画时才恢复；一次性动作应自然播完，其他键也不能被误打断。
    if (!animationName || animationName !== this.activeAnimation) return false

    const animation = this.animations.get(animationName)

    if (!animation?.config.loop) return false

    return resume()
  }

  private lastPressedLoopingAnimation() {
    const inputs = Array.from(this.pressedInputOrder.values())

    for (let index = inputs.length - 1; index >= 0; index--) {
      const input = inputs[index]
      const animationName = input.kind === 'keyboard'
        ? this.pressedKeyboard.get(input.key)
        : this.pressedMouse.get(input.key)

      if (animationName && this.animations.get(animationName)?.config.loop) {
        return animationName
      }
    }
  }

  private startPressedInputBinding(animationName: string) {
    const playback = this.play(animationName)
    const animation = this.animations.get(animationName)

    if (!playback) return false
    if (animation?.config.loop) return true

    // 一次性按键动画自然结束后再恢复仍按住的循环项；被新播放打断时由新播放接管。
    void playback.finished.then((result) => {
      if (result.reason === 'finished') this.resumePressedInputBinding()
    })

    return true
  }

  private touchPressedInput(kind: PressedInput['kind'], key: string) {
    const id = `${kind}:${key}`

    this.pressedInputOrder.delete(id)
    this.pressedInputOrder.set(id, { kind, key })
  }

  private removePressedInput(kind: PressedInput['kind'], key: string) {
    this.pressedInputOrder.delete(`${kind}:${key}`)
  }

  private hasPressedInput(kind: PressedInput['kind'], key: string) {
    return this.pressedInputOrder.has(`${kind}:${key}`)
  }

  private playDefault() {
    const defaultAnimation = this.config?.defaultAnimation

    if (!defaultAnimation) return false
    if (defaultAnimation === this.activeAnimation && !this.animationFinished) return true

    return Boolean(this.play(defaultAnimation))
  }

  private ensureAnimationFrame() {
    if (this.animationFrameId !== null || !this.needsAnimationFrame()) return

    this.animationFrameId = requestAnimationFrame(this.tick)
  }

  private needsAnimationFrame() {
    if (this.renderPending) return true
    if (this.bubbles.length > 0) return true
    if (this.speechBubble) return true

    const animation = this.animations.get(this.activeAnimation)

    if (!animation || this.animationFinished) return false

    // 单帧非循环播放也要走一次 tick 来结算 finished，否则状态机会永久等待。
    return animation.config.frames > 1 || this.activePlayback?.loop === false
  }

  private stopAnimationFrame() {
    if (this.animationFrameId === null) return

    cancelAnimationFrame(this.animationFrameId)

    this.animationFrameId = null
  }

  private reset() {
    this.stopAnimationFrame()

    // 销毁时主动结算等待者，避免模型切换后遗留永不完成的 Promise。
    this.settleActivePlayback('destroyed')

    this.context?.clearRect(0, 0, this.canvas?.width ?? 0, this.canvas?.height ?? 0)

    this.canvas = null
    this.context = null
    this.config = null
    this.modelPath = null
    this.audioPlayer.reset()
    // 清空 Map 本身不保证浏览器立刻释放解码缓存，先断开 src 可缩短大模型切换的峰值驻留。
    this.releaseLoadedAnimations([...this.animations.entries()])
    this.animations.clear()
    this.activeAnimation = ''
    this.activeFrame = 0
    this.animationFinished = false
    this.activePlayback = null
    this.frameStartedAt = 0
    this.bindingIndexes.clear()
    this.pressedKeyboard.clear()
    this.pressedMouse.clear()
    this.pressedInputOrder.clear()
    this.bubbles = []
    // reset 同时覆盖切换模型和销毁；必须先停掉旧模型的长按计时器，避免其继续向新模型冒泡。
    for (const timer of this.keyboardBubbleRepeatTimers.values()) clearInterval(timer)
    this.keyboardBubbleRepeatTimers.clear()
    this.keyboardBubbleTimestamps.clear()
    this.bubbleConfig = { ...defaultBubbleConfig }
    this.bubbleSequence = 0
    // reset 同时服务模型切换与 destroy，递增代次可统一作废旧对白生命周期。
    this.speechBubble = null
    this.speechGeneration++
    this.lastRenderAt = Number.NEGATIVE_INFINITY
    this.renderPending = false
  }

  private settleActivePlayback(reason: SpritePlaybackEndReason) {
    const playback = this.activePlayback

    if (!playback) return

    // 先清空再 resolve，Promise continuation 若立即发起新播放也不会重复结算旧句柄。
    this.activePlayback = null
    playback.resolve({ reason })
  }

  private async readAndValidateModel(path: string, generation?: number) {
    const config = await this.readAndValidateConfig(path, generation)

    const animations = await this.loadAndValidateAnimations(
      path,
      Object.entries(config.animations),
      generation,
    )

    try {
      this.assertLoadGeneration(generation)
    } catch (error) {
      // worker 全部成功后仍可能在 Promise 续体排队期间被新模型取代，旧图片也必须释放。
      this.releaseLoadedAnimations(animations)

      throw error
    }

    return { animations, config }
  }

  private async readAndValidateConfig(path: string, generation?: number) {
    this.assertLoadGeneration(generation)

    const configPath = await resolveModelResourcePath(path, 'model.json')

    this.assertLoadGeneration(generation)

    // manifest 在 JSON.parse 前限制原始字节，避免小动画数量配置用超大 JSON 先耗尽 WebView 内存。
    const rawConfig = JSON.parse(await readBoundedTextFile(
      configPath,
      MAX_MODEL_MANIFEST_BYTES,
      'Sprite model manifest',
    )) as unknown

    this.assertLoadGeneration(generation)

    // module.json 必须在普通模型校验和图片解码前合并；这样模块动画与顶层动画走完全
    // 相同的引用、循环属性和雪碧图边界检查，也不会把外部模块格式泄漏到运行时状态机。
    const config = await this.expandPetBehaviorModules(path, rawConfig, generation)

    this.assertLoadGeneration(generation)
    this.assertConfig(config)
    this.assertLoadGeneration(generation)

    const audioFiles = config.behaviors?.pet?.modules
      ?.flatMap(module => module.actions.flatMap(action => action.audio?.file ?? []))
      ?? []

    await validateSpriteAudioFiles(path, audioFiles, () => this.assertLoadGeneration(generation))
    this.assertLoadGeneration(generation)

    return config
  }

  private async validateAnimationResources(
    modelPath: string,
    entries: Array<[string, SpriteAnimationConfig]>,
    generation?: number,
  ) {
    for (const [name, animation] of entries) {
      this.assertLoadGeneration(generation)

      const resolvedPath = await resolveModelResourcePath(modelPath, animation.file)
      const dimensions = await this.readImageDimensions(resolvedPath)

      this.assertSpritesheetBudget(name, dimensions)

      this.assertSpritesheet(name, animation, dimensions)
    }
  }

  private async loadAndValidateAnimations(
    modelPath: string,
    entries: Array<[string, SpriteAnimationConfig]>,
    generation?: number,
  ) {
    const loaded: Array<readonly [string, LoadedAnimation] | undefined>
      = Array.from({ length: entries.length })
    let nextIndex = 0
    let failed = false
    let firstFailure: unknown

    const worker = async () => {
      while (!failed) {
        const index = nextIndex++

        if (index >= entries.length) return

        const [name, animation] = entries[index]
        let image: HTMLImageElement | null = null

        try {
          this.assertLoadGeneration(generation)

          const resolvedPath = await resolveModelResourcePath(modelPath, animation.file)

          this.assertLoadGeneration(generation)
          if (failed) throw firstFailure

          // 先读取文件头并校验单张像素预算，绝不能等 HTMLImageElement 已把压缩炸弹展开后再判断尺寸。
          const dimensions = await this.readImageDimensions(resolvedPath)
          this.assertSpritesheetBudget(name, dimensions)

          this.assertLoadGeneration(generation)
          if (failed) throw firstFailure

          image = await this.loadImage(convertFileSrc(resolvedPath), generation)

          this.assertLoadGeneration(generation)
          if (failed) throw firstFailure

          // 解码尺寸必须与已经校验的文件头一致，避免格式解析分歧绕过单图像素上限。
          if (image.naturalWidth !== dimensions.width
            || image.naturalHeight !== dimensions.height) {
            throw new Error(`Sprite animation "${name}" decoded dimensions differ from its header`)
          }

          this.assertSpritesheet(name, animation, dimensions)
          this.assertLoadGeneration(generation)

          loaded[index] = [name, { config: animation, image }]
          image = null
        } catch (error) {
          if (image) this.releaseImage(image)

          // 首个错误关闭取号；已经在途的至多四个任务仍会收口并释放各自局部图片。
          if (!failed) {
            failed = true
            firstFailure = error
          }

          return
        }
      }
    }
    // 限制并行解码数，避免大量高分辨率雪碧图同时展开造成瞬时内存尖峰。
    const workerCount = Math.min(MAX_CONCURRENT_IMAGE_LOADS, entries.length)

    await Promise.all(Array.from({ length: workerCount }, worker))

    if (failed) {
      this.releaseLoadedAnimations(loaded.filter(entry => entry !== undefined))

      throw firstFailure
    }

    if (loaded.includes(undefined)) {
      this.releaseLoadedAnimations(loaded.filter(entry => entry !== undefined))
      throw new Error('Sprite model loading ended before every animation was validated')
    }

    return loaded as Array<readonly [string, LoadedAnimation]>
  }

  private async expandPetBehaviorModules(
    path: string,
    config: unknown,
    generation?: number,
  ): Promise<unknown> {
    if (!this.isRecord(config)
      || config.renderer !== 'sprite'
      || !this.isRecord(config.behaviors)
      || !this.isRecord(config.behaviors.pet)
      || !Object.prototype.hasOwnProperty.call(config.behaviors.pet, 'modules')) {
      return config
    }

    // 根配置本身不完整时继续交给 assertConfig 产生既有错误；只有具备模块解析所需的
    // 动画表和画布后才读取外部文件，避免次要模块错误掩盖主 manifest 的结构错误。
    if (!this.isRecord(config.animations)
      || !this.isRecord(config.canvas)
      || !this.isPositiveNumber(config.canvas.width)
      || !this.isPositiveNumber(config.canvas.height)) {
      return config
    }

    const pet = config.behaviors.pet
    const result = await loadPetBehaviorModules(path, pet.modules, {
      animations: config.animations as Record<string, SpriteAnimationConfig>,
      canvas: {
        width: config.canvas.width,
        height: config.canvas.height,
      },
      hitAreas: this.isRecord(pet.hitAreas) ? pet.hitAreas : undefined,
      // 模块按顺序读取；每次文件 I/O 前后检查代次，让切模后不再继续遍历剩余模块。
      assertActive: () => this.assertLoadGeneration(generation),
    })

    return {
      ...config,
      animations: result.animations,
      behaviors: {
        ...config.behaviors,
        pet: {
          ...pet,
          modules: result.modules,
        },
      },
    }
  }

  private loadImage(source: string, generation?: number) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      let settled = false
      let unregister: () => void = () => void 0

      // load/error/abort 共用一次性出口，保证代次登记和 DOM 回调在任何竞态顺序下都被清理。
      const finish = (callback: () => void) => {
        if (settled) return

        settled = true
        image.onload = null
        image.onerror = null
        unregister()
        callback()
      }

      const abort = () => {
        finish(() => {
          this.releaseImage(image)
          reject(new DOMException('Sprite model load was superseded', 'AbortError'))
        })
      }

      if (generation !== undefined) {
        unregister = this.registerPendingImageLoad(generation, abort)
      }

      image.onload = () => finish(() => resolve(image))
      image.onerror = () => finish(() => {
        this.releaseImage(image)
        reject(new Error(`Failed to load sprite image: ${source}`))
      })

      try {
        this.assertLoadGeneration(generation)
        image.src = source
      } catch {
        abort()
      }
    })
  }

  private async readImageDimensions(path: string): Promise<SpriteImageDimensions> {
    // 这里只取有上限的文件头，不把整张压缩图片搬进 JS；WebKit 解码要等尺寸预算通过后才开始。
    const header = await readFilePrefix(path, MAX_IMAGE_HEADER_BYTES)
    const dimensions = parseImageDimensions(header.bytes, header.complete)

    if (!dimensions
      || !Number.isSafeInteger(dimensions.width)
      || !Number.isSafeInteger(dimensions.height)
      || dimensions.width <= 0
      || dimensions.height <= 0) {
      throw new Error(`Unsupported or invalid sprite image header: ${path}`)
    }

    return dimensions
  }

  private registerPendingImageLoad(generation: number, abort: () => void) {
    // 以代次分桶保存 abort，切模时只取消旧模型，不会误杀刚启动的新模型解码。
    let pending = this.pendingImageLoads.get(generation)

    if (!pending) {
      pending = new Set()
      this.pendingImageLoads.set(generation, pending)
    }

    pending.add(abort)

    return () => {
      pending?.delete(abort)

      if (pending?.size === 0) this.pendingImageLoads.delete(generation)
    }
  }

  private abortPendingImageLoads(exceptGeneration?: number) {
    // abort 会同步修改 Map，因此复制集合后遍历，避免跳过同代次的其他请求。
    for (const [generation, aborts] of [...this.pendingImageLoads.entries()]) {
      if (generation === exceptGeneration) continue

      for (const abort of [...aborts]) abort()
    }
  }

  private assertLoadGeneration(generation?: number) {
    if (generation !== undefined && generation !== this.loadGeneration) {
      throw new DOMException('Sprite model load was superseded', 'AbortError')
    }
  }

  private releaseLoadedAnimations(
    animations: Array<readonly [string, LoadedAnimation]>,
  ) {
    for (const [, animation] of animations) this.releaseImage(animation.image)
  }

  private releaseImage(image: HTMLImageElement) {
    image.onload = null
    image.onerror = null
    // removeAttribute 不会把空字符串解析成当前页面 URL，适合中止并释放本地 asset 图片。
    image.removeAttribute('src')
  }

  private assertConfig(config: unknown): asserts config is SpriteModelConfig {
    // model.json 是可替换的外部模型输入。这里严格校验全部跨字段约束，避免错误配置进入
    // 播放循环后才表现为裁切、Promise 不结束或按键无响应。
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid sprite model config')
    }

    const candidate = config as Partial<SpriteModelConfig>

    if (candidate.renderer !== 'sprite') {
      throw new Error('Sprite model renderer must be "sprite"')
    }

    for (const [name, value] of Object.entries({
      id: candidate.id,
      displayName: candidate.displayName,
    })) {
      if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
        throw new TypeError(`Sprite model ${name} is invalid`)
      }
    }

    if (candidate.mode !== undefined
      && !['standard', 'keyboard', 'gamepad'].includes(candidate.mode)) {
      throw new TypeError('Sprite model mode is invalid')
    }

    if (!candidate.canvas || !this.isPositiveNumber(candidate.canvas.width)
      || !this.isPositiveNumber(candidate.canvas.height)) {
      throw new Error('Sprite model canvas dimensions are invalid')
    }

    if (!candidate.animations || typeof candidate.animations !== 'object'
      || Array.isArray(candidate.animations)
      || Object.keys(candidate.animations).length === 0) {
      throw new Error('Sprite model animations are missing')
    }

    // 动画数量先于图片解码限制，阻止小文件海量 fan-out 绕过像素预算拖垮加载器。
    if (Object.keys(candidate.animations).length > MAX_ANIMATION_COUNT) {
      throw new RangeError(
        `Sprite model animations cannot exceed ${MAX_ANIMATION_COUNT}`,
      )
    }

    if (typeof candidate.defaultAnimation !== 'string'
      || candidate.defaultAnimation.trim().length === 0
      || !Object.prototype.hasOwnProperty.call(
        candidate.animations,
        candidate.defaultAnimation,
      )) {
      throw new Error('Sprite model default animation is invalid')
    }

    for (const [name, animation] of Object.entries(candidate.animations)) {
      if (name.trim().length === 0
        || !animation || !this.isRelativeAssetPath(animation.file)
        || !this.isPositiveInteger(animation.frameWidth)
        || !this.isPositiveInteger(animation.frameHeight)
        || !this.isPositiveInteger(animation.frames)
        || !this.isPositiveInteger(animation.columns)
        || !this.isPositiveNumber(animation.fps)
        || typeof animation.loop !== 'boolean') {
        throw new Error(`Sprite animation "${name}" is invalid`)
      }

      if (animation.frameDurations !== undefined
        && (!Array.isArray(animation.frameDurations)
          || animation.frameDurations.length !== animation.frames
          || animation.frameDurations.some(duration => !this.isPositiveNumber(duration)))) {
        throw new Error(`Sprite animation "${name}" frame durations are invalid`)
      }
    }

    if (candidate.behaviors !== undefined
      && (!candidate.behaviors || typeof candidate.behaviors !== 'object'
        || Array.isArray(candidate.behaviors))) {
      throw new TypeError('Sprite model behaviors are invalid')
    }

    // 行为动画引用和循环属性依赖完整动画表，必须在加载图片和启动控制器之前联合校验。
    assertPetBehaviorConfig(candidate.behaviors?.pet, {
      animations: candidate.animations,
      canvas: candidate.canvas,
    })

    if (candidate.bindings !== undefined
      && (!candidate.bindings || typeof candidate.bindings !== 'object'
        || Array.isArray(candidate.bindings))) {
      throw new TypeError('Sprite model bindings are invalid')
    }

    // 优先使用分组后的 bindings，同时保留顶层 keyboard/mouse 作为旧模型兼容入口。
    const keyboard = candidate.bindings?.keyboard ?? candidate.keyboard

    if (keyboard !== undefined
      && (!keyboard || typeof keyboard !== 'object' || Array.isArray(keyboard))) {
      throw new TypeError('Sprite keyboard bindings are invalid')
    }

    for (const [key, binding] of Object.entries(keyboard ?? {})) {
      const animationNames = typeof binding === 'string' ? [binding] : binding

      if (key.trim().length === 0
        || !Array.isArray(animationNames) || animationNames.length === 0
        || animationNames.some((item) => {
          return typeof item !== 'string' || item.trim().length === 0
        })) {
        throw new Error(`Sprite keyboard binding "${key}" is invalid`)
      }

      if (animationNames.some((name) => {
        // 使用 own-property，避免 __proto__/toString 一类名称被原型链误认为有效动画。
        return !Object.prototype.hasOwnProperty.call(candidate.animations, name)
      })) {
        throw new Error(`Sprite keyboard binding "${key}" references a missing animation`)
      }
    }

    const mouse = candidate.bindings?.mouse ?? candidate.mouse

    if (mouse !== undefined
      && (!mouse || typeof mouse !== 'object' || Array.isArray(mouse))) {
      throw new TypeError('Sprite mouse bindings are invalid')
    }

    for (const [button, binding] of Object.entries(mouse ?? {})) {
      if (button.trim().length === 0
        || typeof binding !== 'string'
        || binding.trim().length === 0) {
        throw new TypeError(`Sprite mouse binding "${button}" is invalid`)
      }

      if (!Object.prototype.hasOwnProperty.call(candidate.animations, binding)) {
        throw new Error(`Sprite mouse binding "${button}" references a missing animation`)
      }
    }

    if (candidate.bubbles !== undefined) {
      if (!candidate.bubbles || typeof candidate.bubbles !== 'object'
        || Array.isArray(candidate.bubbles)) {
        throw new TypeError('Sprite bubble config is invalid')
      }

      const bubbles = candidate.bubbles

      if (bubbles.enabled !== undefined && typeof bubbles.enabled !== 'boolean') {
        throw new TypeError('Sprite bubble enabled value is invalid')
      }

      for (const [name, value] of Object.entries({
        duration: bubbles.duration,
        repeatInterval: bubbles.repeatInterval,
        rise: bubbles.rise,
        fontSize: bubbles.fontSize,
        strokeWidth: bubbles.strokeWidth,
      })) {
        if (value !== undefined && !this.isPositiveNumber(value)) {
          throw new TypeError(`Sprite bubble ${name} is invalid`)
        }
      }

      for (const [name, value] of Object.entries({
        anchorX: bubbles.anchorX,
        anchorY: bubbles.anchorY,
        shadowBlur: bubbles.shadowBlur,
        shadowOffsetY: bubbles.shadowOffsetY,
      })) {
        if (value !== undefined && !this.isNonNegativeNumber(value)) {
          throw new TypeError(`Sprite bubble ${name} is invalid`)
        }
      }

      if (bubbles.anchorX !== undefined && bubbles.anchorX > candidate.canvas.width) {
        throw new TypeError('Sprite bubble anchorX exceeds the model canvas')
      }

      if (bubbles.anchorY !== undefined && bubbles.anchorY > candidate.canvas.height) {
        throw new TypeError('Sprite bubble anchorY exceeds the model canvas')
      }

      if (bubbles.maxVisible !== undefined && !this.isPositiveInteger(bubbles.maxVisible)) {
        throw new TypeError('Sprite bubble maxVisible is invalid')
      }

      for (const [name, value] of Object.entries({
        fill: bubbles.fill,
        fillTop: bubbles.fillTop,
        fillBottom: bubbles.fillBottom,
        highlightColor: bubbles.highlightColor,
        stroke: bubbles.stroke,
        textColor: bubbles.textColor,
        shadowColor: bubbles.shadowColor,
      })) {
        if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
          throw new TypeError(`Sprite bubble ${name} is invalid`)
        }
      }
    }
  }

  private assertSpritesheet(
    name: string,
    animation: SpriteAnimationConfig,
    dimensions: SpriteImageDimensions,
  ) {
    const requiredColumns = Math.min(animation.frames, animation.columns)
    const requiredRows = Math.ceil(animation.frames / animation.columns)

    // 文件头尺寸已在解码前取得；用同一份数据核对帧边界，避免预算检查和布局检查口径分裂。
    if (dimensions.width < requiredColumns * animation.frameWidth
      || dimensions.height < requiredRows * animation.frameHeight) {
      throw new Error(`Sprite animation "${name}" exceeds its spritesheet bounds`)
    }
  }

  private assertSpritesheetBudget(name: string, dimensions: SpriteImageDimensions) {
    // 先比较单边可避免恶意 uint32 尺寸相乘越过 JS safe-integer 后再参与预算判断。
    if (dimensions.width > MAX_SPRITESHEET_PIXELS
      || dimensions.height > MAX_SPRITESHEET_PIXELS
      || dimensions.width * dimensions.height > MAX_SPRITESHEET_PIXELS) {
      throw new RangeError(
        `Sprite animation "${name}" exceeds the ${MAX_SPRITESHEET_PIXELS} pixel sheet budget`,
      )
    }

    return dimensions.width * dimensions.height
  }

  private isPositiveInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) > 0
  }

  private isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
  }

  private isNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  }

  private isDisplayableLabel(value: string) {
    // macOS 事件可能把功能键编码成私用区字符，气泡应回退到规范键名而不是显示方框乱码。
    return Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0

      return codePoint >= 0x20
        && !(codePoint >= 0x7F && codePoint <= 0x9F)
        && !(codePoint >= 0xE000 && codePoint <= 0xF8FF)
        && !(codePoint >= 0xF0000 && codePoint <= 0xFFFFD)
        && !(codePoint >= 0x100000 && codePoint <= 0x10FFFD)
    })
  }

  private isRelativeAssetPath(value: unknown): value is string {
    // 模型资源只能位于自身目录，拒绝绝对路径、协议和 ..，避免可分发模型越界读取本机文件。
    if (typeof value !== 'string' || value.trim().length === 0) return false
    if (/^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(value)) return false

    return !value.split(/[\\/]/).includes('..')
  }

  private getFrameDuration(animation: SpriteAnimationConfig, frame: number) {
    return animation.frameDurations?.[frame] ?? 1000 / animation.fps
  }

  private renderIfDue(timestamp = performance.now()) {
    if (timestamp - this.lastRenderAt < 1000 / this.maxFPS) {
      this.renderPending = true

      return false
    }

    this.renderFrame(timestamp)

    return true
  }
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xC0,
  0xC1,
  0xC2,
  0xC3,
  0xC5,
  0xC6,
  0xC7,
  0xC9,
  0xCA,
  0xCB,
  0xCD,
  0xCE,
  0xCF,
])

function parseImageDimensions(
  bytes: Uint8Array,
  completeFile: boolean,
): SpriteImageDimensions | null {
  // 仅解析各格式声明尺寸所需的最小头结构；这里不创建 DOM，也不触碰压缩像素主体。
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (hasBytes(bytes, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    && hasAscii(bytes, 12, 'IHDR') && bytes.byteLength >= 24) {
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
    }
  }

  if (hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP')) {
    return parseWebpDimensions(bytes, view)
  }

  if ((hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a'))
    && bytes.byteLength >= 10) {
    return {
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    }
  }

  if (hasBytes(bytes, 0, [0xFF, 0xD8])) {
    return parseJpegDimensions(bytes, view)
  }

  const avifDimensions = parseAvifDimensions(bytes, view)

  if (avifDimensions) return avifDimensions

  if (hasBytes(bytes, 0, [0x00, 0x00, 0x01, 0x00])) {
    return parseIcoDimensions(bytes, view)
  }

  if (hasAscii(bytes, 0, 'BM') && bytes.byteLength >= 26) {
    const width = view.getInt32(18, true)
    const height = view.getInt32(22, true)

    return {
      width: Math.abs(width),
      height: Math.abs(height),
    }
  }

  // SVG 没有压缩像素头；必须确认整个文件都在固定字节预算内，才允许 WebView 继续解码。
  const svgDimensions = completeFile ? parseSvgDimensions(bytes) : null

  if (svgDimensions) return svgDimensions

  return null
}

interface IsoBox {
  type: string
  dataStart: number
  end: number
}

interface IsoBoxReadResult {
  boxes: IsoBox[]
  complete: boolean
}

function parseAvifDimensions(
  bytes: Uint8Array,
  view: DataView,
): SpriteImageDimensions | null {
  const topLevelBoxes = readIsoBoxes(bytes, view, 0, bytes.byteLength).boxes
  const fileType = topLevelBoxes.find(box => box.type === 'ftyp')

  if (!fileType || fileType.dataStart + 8 > fileType.end) return null

  const brands = [readAscii(bytes, fileType.dataStart, 4)]

  for (let offset = fileType.dataStart + 8; offset + 4 <= fileType.end; offset += 4) {
    brands.push(readAscii(bytes, offset, 4))
  }

  if (!brands.some(brand => brand === 'avif' || brand === 'avis')) return null

  const dimensions: SpriteImageDimensions[] = []

  // 只接受完整落在头部窗口内的 meta，并收集其中全部 ispe；取最大值可阻止前置伪小属性绕预算。
  for (const box of topLevelBoxes.filter(box => box.type === 'meta')) {
    const collected = collectIsoImageSpatialExtents(bytes, view, box, 0)

    if (collected === null) return null

    dimensions.push(...collected)
  }

  return dimensions.reduce<SpriteImageDimensions | null>((largest, candidate) => {
    if (!largest || candidate.width * candidate.height > largest.width * largest.height) {
      return candidate
    }

    return largest
  }, null)
}

function collectIsoImageSpatialExtents(
  bytes: Uint8Array,
  view: DataView,
  box: IsoBox,
  depth: number,
): SpriteImageDimensions[] | null {
  if (box.type === 'ispe') {
    if (box.dataStart + 12 > box.end) return null

    return [{
      width: view.getUint32(box.dataStart + 4),
      height: view.getUint32(box.dataStart + 8),
    }]
  }

  if (depth >= 6 || !['meta', 'iprp', 'ipco'].includes(box.type)) return []

  // meta 是 FullBox，version/flags 占四字节；iprp/ipco 的 payload 直接由子 box 组成。
  const childStart = box.dataStart + (box.type === 'meta' ? 4 : 0)

  if (childStart > box.end) return null

  const children = readIsoBoxes(bytes, view, childStart, box.end)

  if (!children.complete) return null

  const dimensions: SpriteImageDimensions[] = []

  for (const child of children.boxes) {
    const collected = collectIsoImageSpatialExtents(bytes, view, child, depth + 1)

    if (collected === null) return null

    dimensions.push(...collected)
  }

  return dimensions
}

function readIsoBoxes(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number,
): IsoBoxReadResult {
  const boxes: IsoBox[] = []
  let offset = start

  while (offset + 8 <= end) {
    const size32 = view.getUint32(offset)
    const type = readAscii(bytes, offset + 4, 4)
    let headerSize = 8
    let size = size32

    if (size32 === 1) {
      if (offset + 16 > end) break

      const high = view.getUint32(offset + 8)
      const low = view.getUint32(offset + 12)

      size = high * 0x1_0000_0000 + low
      headerSize = 16
    } else if (size32 === 0) {
      break
    }

    // 只接受完整落在 512 KiB 头部窗口内的安全整数 box；超界后停止而非触碰压缩主体。
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) break

    const boxEnd = offset + size

    boxes.push({ type, dataStart: offset + headerSize, end: boxEnd })
    offset = boxEnd
  }

  return { boxes, complete: offset === end }
}

function parseIcoDimensions(
  bytes: Uint8Array,
  view: DataView,
): SpriteImageDimensions | null {
  if (bytes.byteLength < 6) return null

  const count = view.getUint16(4, true)
  const directoryEnd = 6 + count * 16

  if (count === 0 || directoryEnd > bytes.byteLength) return null

  let largest: SpriteImageDimensions | null = null

  for (let offset = 6; offset < directoryEnd; offset += 16) {
    const dataSize = view.getUint32(offset + 8, true)
    const dataOffset = view.getUint32(offset + 12, true)
    const dataEnd = dataOffset + dataSize

    // 目录宽高可伪造；每个 payload 必须完整落在探测窗口内，并从嵌入 PNG/DIB 自身读取尺寸。
    if (!Number.isSafeInteger(dataEnd)
      || dataSize === 0
      || dataOffset < directoryEnd
      || dataEnd > bytes.byteLength) {
      return null
    }

    const dimensions = parseIcoPayloadDimensions(bytes, view, dataOffset, dataEnd)

    if (!dimensions) return null
    if (!largest || dimensions.width * dimensions.height > largest.width * largest.height) {
      largest = dimensions
    }
  }

  return largest
}

function parseIcoPayloadDimensions(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number,
): SpriteImageDimensions | null {
  if (start + 24 <= end
    && hasBytes(bytes, start, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    && hasAscii(bytes, start + 12, 'IHDR')) {
    return {
      width: view.getUint32(start + 16),
      height: view.getUint32(start + 20),
    }
  }

  if (start + 4 > end) return null

  const dibSize = view.getUint32(start, true)

  if (dibSize === 12 && start + 12 <= end) {
    return {
      width: view.getUint16(start + 4, true),
      height: view.getUint16(start + 6, true) / 2,
    }
  }

  if (dibSize >= 40 && start + 12 <= end && start + dibSize <= end) {
    return {
      width: Math.abs(view.getInt32(start + 4, true)),
      // ICO 的 DIB 高度同时包含 XOR 位图和 AND mask，所以实际图像高度为一半。
      height: Math.abs(view.getInt32(start + 8, true)) / 2,
    }
  }

  return null
}

function parseSvgDimensions(bytes: Uint8Array): SpriteImageDimensions | null {
  let text: string

  try {
    // TextDecoder 只把有界头部当纯文本读取，不构造 DOM、解析实体或执行 SVG 中的任何内容。
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }

  const rootStart = findSvgRootStart(text)

  if (rootStart < 0) return null

  const rootEnd = findXmlTagEnd(text, rootStart + 4)

  if (rootEnd < 0) return null

  const rootTag = text.slice(rootStart + 4, rootEnd)
  const attributes = readSvgDimensionAttributes(rootTag)
  const viewBox = parseSvgViewBox(attributes.viewBox)
  let width = parseSvgLength(attributes.width)
  let height = parseSvgLength(attributes.height)

  if (width === null && height === null && viewBox) {
    width = viewBox.width
    height = viewBox.height
  } else if (width !== null && height === null && viewBox) {
    height = width * viewBox.height / viewBox.width
  } else if (height !== null && width === null && viewBox) {
    width = height * viewBox.width / viewBox.height
  }

  if (width === null || height === null) return null

  return { width, height }
}

function findSvgRootStart(text: string) {
  let offset = text.charCodeAt(0) === 0xFEFF ? 1 : 0
  let sawXmlDeclaration = false

  while (offset < text.length) {
    while (offset < text.length && /[\t\n\r ]/.test(text[offset])) offset++

    if (text.startsWith('<!--', offset)) {
      const commentEnd = text.indexOf('-->', offset + 4)

      if (commentEnd < 0) return -1

      offset = commentEnd + 3
      continue
    }

    if (!sawXmlDeclaration
      && text.startsWith('<?xml', offset)
      && /[\s?]/.test(text[offset + 5] ?? '')) {
      const declarationEnd = text.indexOf('?>', offset + 5)

      if (declarationEnd < 0) return -1

      sawXmlDeclaration = true
      offset = declarationEnd + 2
      continue
    }

    break
  }

  // DOCTYPE/实体和任意其他根前内容全部拒绝；预算探头只读取真实的首个 svg 根标签。
  if (!text.startsWith('<svg', offset) || !/[\s>]/.test(text[offset + 4] ?? '')) return -1

  return offset
}

function findXmlTagEnd(text: string, start: number) {
  let quote = ''

  for (let index = start; index < text.length; index++) {
    const character = text[index]

    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === '\'') {
      quote = character
    } else if (character === '>') {
      return index
    }
  }

  return -1
}

function readSvgDimensionAttributes(rootTag: string) {
  const attributes: { width?: string, height?: string, viewBox?: string } = {}
  const pattern = /(?:^|\s)(width|height|viewBox)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

  for (const match of rootTag.matchAll(pattern)) {
    const name = match[1] as 'width' | 'height' | 'viewBox'

    attributes[name] = match[2] ?? match[3] ?? match[4]
  }

  return attributes
}

function parseSvgLength(value?: string) {
  if (value === undefined) return null

  const match = value.trim().match(/^(\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|in|cm|mm|pt|pc)?$/i)

  if (!match) return null

  const numeric = Number(match[1])
  const scales: Record<string, number> = {
    px: 1,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    pt: 96 / 72,
    pc: 16,
  }
  const scale = scales[match[2]?.toLowerCase() ?? 'px']

  if (scale === undefined) return null

  const pixels = numeric * scale

  return Number.isFinite(pixels) && pixels > 0 ? pixels : null
}

function parseSvgViewBox(value?: string) {
  if (value === undefined) return null

  const numbers = value.trim().split(/[\s,]+/).map(Number)

  if (numbers.length !== 4 || numbers.some(number => !Number.isFinite(number))) return null

  const [, , width, height] = numbers

  return width > 0 && height > 0 ? { width, height } : null
}

function parseWebpDimensions(
  bytes: Uint8Array,
  view: DataView,
): SpriteImageDimensions | null {
  if (hasAscii(bytes, 12, 'VP8X') && bytes.byteLength >= 30) {
    return {
      width: 1 + readUint24LittleEndian(bytes, 24),
      height: 1 + readUint24LittleEndian(bytes, 27),
    }
  }

  if (hasAscii(bytes, 12, 'VP8 ')
    && hasBytes(bytes, 23, [0x9D, 0x01, 0x2A])
    && bytes.byteLength >= 30) {
    return {
      width: view.getUint16(26, true) & 0x3FFF,
      height: view.getUint16(28, true) & 0x3FFF,
    }
  }

  if (hasAscii(bytes, 12, 'VP8L') && bytes[20] === 0x2F && bytes.byteLength >= 25) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3F) << 8),
      height: 1
        + ((bytes[22] & 0xC0) >> 6)
        + (bytes[23] << 2)
        + ((bytes[24] & 0x0F) << 10),
    }
  }

  return null
}

function parseJpegDimensions(
  bytes: Uint8Array,
  view: DataView,
): SpriteImageDimensions | null {
  let offset = 2

  // JPEG 尺寸位于首个 SOF 段；只扫描有界头部，不越过 SOS 去解析压缩像素数据。
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xFF) offset++
    while (offset < bytes.byteLength && bytes[offset] === 0xFF) offset++

    if (offset >= bytes.byteLength) return null

    const marker = bytes[offset++]

    if (marker === 0xD9 || marker === 0xDA) return null
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) continue
    if (offset + 2 > bytes.byteLength) return null

    const segmentLength = view.getUint16(offset)

    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) return null

      return {
        width: view.getUint16(offset + 5),
        height: view.getUint16(offset + 3),
      }
    }

    offset += segmentLength
  }

  return null
}

function hasAscii(bytes: Uint8Array, offset: number, expected: string) {
  if (offset + expected.length > bytes.byteLength) return false

  return Array.from(expected).every((character, index) => {
    return bytes[offset + index] === character.charCodeAt(0)
  })
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  if (offset < 0 || offset + length > bytes.byteLength) return ''

  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]) {
  if (offset + expected.length > bytes.byteLength) return false

  return expected.every((value, index) => bytes[offset + index] === value)
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

export const sprite = new SpriteRenderer()

export default sprite
