import { convertFileSrc } from '@tauri-apps/api/core'
import { readTextFile } from '@tauri-apps/plugin-fs'

import type {
  PetBehaviorConfig,
  PetPlaybackEndReason,
  PetPlaybackHandle,
  PetPlaybackResult,
  PetPlayOptions,
} from './pet-behavior'

import { join } from './path'
import { assertPetBehaviorConfig } from './pet-behavior'

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
  pet?: PetBehaviorConfig
}

export interface SpriteBubbleConfig {
  enabled: boolean
  duration: number
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
  petBehavior?: PetBehaviorConfig
}

interface LoadedAnimation {
  config: SpriteAnimationConfig
  image: HTMLImageElement
}

interface ActiveBubble {
  text: string
  createdAt: number
  sequence: number
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

const defaultBubbleConfig: SpriteBubbleConfig = {
  enabled: true,
  duration: 900,
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
  private maxFPS = 60
  private bindingIndexes = new Map<string, number>()
  private pressedKeyboard = new Map<string, string>()
  private pressedMouse = new Map<string, string>()
  // Map 的插入顺序充当跨键盘/鼠标的最近按下栈，释放当前动作后才能恢复真正最后仍按住的绑定。
  private pressedInputOrder = new Map<string, PressedInput>()
  private bubbles: ActiveBubble[] = []
  private bubbleConfig: SpriteBubbleConfig = { ...defaultBubbleConfig }
  private bubbleSequence = 0
  private lastRenderAt = Number.NEGATIVE_INFINITY
  private renderPending = false
  private mirrored = false

  public async load(path: string): Promise<SpriteModelLoadResult> {
    const generation = ++this.loadGeneration

    this.reset()

    const { animations, config } = await this.readAndValidateModel(path)

    // 图片解码是异步的；旧模型即使后完成也不能重新初始化共用 Canvas。
    if (generation !== this.loadGeneration) {
      throw new DOMException('Sprite model load was superseded', 'AbortError')
    }

    this.initCanvas()

    this.config = config
    this.animations = new Map(animations)
    this.bubbleConfig = { ...defaultBubbleConfig, ...config.bubbles }

    this.resizeModel(config.canvas)
    this.play(config.defaultAnimation)

    return {
      width: config.canvas.width,
      height: config.canvas.height,
      motions: {},
      expressions: [],
      defaultAnimation: config.defaultAnimation,
      petBehavior: config.behaviors?.pet,
    }
  }

  public async validateModel(path: string) {
    const { config } = await this.readAndValidateModel(path)

    return config
  }

  public destroy() {
    ++this.loadGeneration
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
    return this.showBubble(key, label)
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

    const animation = this.animations.get(this.activeAnimation)

    this.renderPending ||= previousBubbleCount !== this.bubbles.length

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

    if (bubbleExpired || animationFinishedNow
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
      this.context.font = `700 ${fontSize}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`

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

    this.context.font = `700 ${fontSize}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`

    const textWidth = this.context.measureText(text).width
    const maxTextWidth = this.canvas.width * 0.8 - fontSize * 1.3

    if (textWidth <= maxTextWidth) return fontSize

    return Math.max(fontSize * 0.55, fontSize * (maxTextWidth / textWidth))
  }

  private showBubble(key: string, label?: string) {
    if (!this.canvas || !this.context || !this.config || !this.bubbleConfig.enabled) return false

    const timestamp = performance.now()
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
    this.bubbleConfig = { ...defaultBubbleConfig }
    this.bubbleSequence = 0
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

  private async readAndValidateModel(path: string) {
    const configPath = join(path, 'model.json')
    const config = JSON.parse(await readTextFile(configPath)) as unknown

    this.assertConfig(config)

    const animations = await Promise.all(
      Object.entries(config.animations).map(async ([name, animation]) => {
        const image = await this.loadImage(convertFileSrc(join(path, animation.file)))

        this.assertSpritesheet(name, animation, image)

        return [name, { config: animation, image }] as const
      }),
    )

    return { animations, config }
  }

  private loadImage(source: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()

      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error(`Failed to load sprite image: ${source}`))
      image.src = source
    })
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
    image: HTMLImageElement,
  ) {
    const requiredColumns = Math.min(animation.frames, animation.columns)
    const requiredRows = Math.ceil(animation.frames / animation.columns)

    // 配置尺寸合法不代表图片装得下全部帧；提前核对实际解码尺寸可避免运行时抽到透明区。
    if (image.naturalWidth < requiredColumns * animation.frameWidth
      || image.naturalHeight < requiredRows * animation.frameHeight) {
      throw new Error(`Sprite animation "${name}" exceeds its spritesheet bounds`)
    }
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

export const sprite = new SpriteRenderer()

export default sprite
