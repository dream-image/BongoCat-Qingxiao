import { convertFileSrc } from '@tauri-apps/api/core'
import { OpusDecoder } from 'opus-decoder'

import type { PetAudioPayload } from './pet-behavior'

import {
  readBoundedBinaryFile,
  resolveModelResourcePath,
} from './path'
import { parseWwiseOpusWem } from './wwise-opus'

const MAX_AUDIO_FILE_BYTES = 8 * 1024 * 1024
const MAX_AUDIO_DURATION_SECONDS = 30
const WWISE_OPUS_SAMPLE_RATE = 48_000
export const MAX_SPRITE_AUDIO_FILES = 64

/**
 * 模型加载期验证语音路径和 WEM 容器，确保右键动作不会等到触发时才暴露缺文件或坏包。
 * 普通音频仍由 WebView 原生解码；WEM 则限定为当前运行时明确支持的 Wwise Opus 0x3041。
 */
export async function validateSpriteAudioFiles(
  modelPath: string,
  files: Iterable<string>,
  assertActive?: () => void,
) {
  const uniqueFiles = [...new Set(files)]

  if (uniqueFiles.length > MAX_SPRITE_AUDIO_FILES) {
    throw new RangeError(`Sprite model audio files cannot exceed ${MAX_SPRITE_AUDIO_FILES}`)
  }

  for (const file of uniqueFiles) {
    assertActive?.()

    const resolvedPath = await resolveModelResourcePath(modelPath, file)
    const bytes = await readBoundedBinaryFile(
      resolvedPath,
      MAX_AUDIO_FILE_BYTES,
      `Sprite audio "${file}"`,
    )

    if (isWemFile(file)) parseWwiseOpusWem(bytes, maxWwiseSamples())
  }
}

export class SpriteAudioPlayer {
  private enabled = true
  private generation = 0
  private context: AudioContext | undefined
  private source: AudioBufferSourceNode | undefined
  private gain: GainNode | undefined
  private nativeAudio: HTMLAudioElement | undefined
  private readonly decodedWem = new Map<string, Promise<AudioBuffer>>()

  public setEnabled(enabled: boolean) {
    this.enabled = enabled

    if (!enabled) this.stop()
  }

  public play(modelPath: string, payload: PetAudioPayload) {
    const generation = this.stop()

    if (!this.enabled) return

    void this.start(modelPath, payload, generation).catch((error) => {
      if (generation !== this.generation) return

      // 单个可选语音失败不能中断人物动画或状态机；保留日志供模型作者定位坏资源。
      console.warn(`Failed to play sprite audio "${payload.file}":`, error)
    })
  }

  public stop() {
    const generation = ++this.generation

    if (this.source) {
      this.source.onended = null

      try {
        this.source.stop()
      } catch {
        // 已自然结束的 AudioBufferSourceNode 再 stop 会抛异常，收口时可安全忽略。
      }

      this.source.disconnect()
      this.source = void 0
    }
    this.gain?.disconnect()
    this.gain = void 0

    if (this.nativeAudio) {
      this.nativeAudio.pause()
      this.nativeAudio.removeAttribute('src')
      this.nativeAudio.load()
      this.nativeAudio = void 0
    }

    return generation
  }

  public reset() {
    this.stop()
    // AudioBuffer 绑定创建它的 AudioContext；切模型清缓存，避免长期持有上一模型的 PCM。
    this.decodedWem.clear()
  }

  private async start(modelPath: string, payload: PetAudioPayload, generation: number) {
    const resolvedPath = await resolveModelResourcePath(modelPath, payload.file)

    if (generation !== this.generation || !this.enabled) return

    if (!isWemFile(payload.file)) {
      const audio = new Audio(convertFileSrc(resolvedPath))

      audio.volume = payload.volume
      this.nativeAudio = audio
      await audio.play()

      return
    }

    const context = this.getAudioContext()
    const buffer = await this.getDecodedWem(resolvedPath, context)

    if (generation !== this.generation || !this.enabled) return

    if (context.state === 'suspended') await context.resume()
    if (generation !== this.generation || !this.enabled) return

    const source = context.createBufferSource()
    const gain = context.createGain()

    source.buffer = buffer
    gain.gain.value = payload.volume
    source.connect(gain)
    gain.connect(context.destination)
    source.onended = () => {
      if (this.source !== source) return

      source.disconnect()
      gain.disconnect()
      this.source = void 0
      this.gain = void 0
    }
    this.source = source
    this.gain = gain
    source.start()
  }

  private getAudioContext() {
    this.context ??= new AudioContext()

    return this.context
  }

  private getDecodedWem(path: string, context: AudioContext) {
    const cached = this.decodedWem.get(path)

    if (cached) return cached

    const pending = this.decodeWem(path, context).catch((error) => {
      this.decodedWem.delete(path)
      throw error
    })

    this.decodedWem.set(path, pending)

    return pending
  }

  private async decodeWem(path: string, context: AudioContext) {
    const bytes = await readBoundedBinaryFile(path, MAX_AUDIO_FILE_BYTES, 'Sprite WEM audio')
    const stream = parseWwiseOpusWem(bytes, maxWwiseSamples())
    const decoder = new OpusDecoder({
      channels: stream.channels,
      sampleRate: stream.sampleRate,
      preSkip: stream.preSkip,
      streamCount: 1,
      coupledStreamCount: stream.channels === 2 ? 1 : 0,
      channelMappingTable: stream.channels === 2 ? [0, 1] : [0],
    })

    try {
      await decoder.ready

      const decoded = decoder.decodeFrames(stream.frames)

      if (decoded.errors.length > 0 || decoded.samplesDecoded < stream.sampleCount) {
        throw new Error(decoded.errors[0]?.message ?? 'Wwise Opus audio ended before its sample count')
      }

      // Wwise 的 numSamples 已扣除尾部 padding；按该值裁剪，避免短台词结束时多出静音或噪点。
      const buffer = context.createBuffer(stream.channels, stream.sampleCount, decoded.sampleRate)

      for (let channel = 0; channel < stream.channels; channel++) {
        // opus-decoder 的类型允许 SharedArrayBuffer，而 Web Audio 只接受普通 ArrayBuffer；复制一份同时完成裁剪和类型收窄。
        const channelSamples = new Float32Array(stream.sampleCount)
        channelSamples.set(decoded.channelData[channel].subarray(0, stream.sampleCount))
        buffer.copyToChannel(channelSamples, channel)
      }

      return buffer
    } finally {
      decoder.free()
    }
  }
}

function isWemFile(path: string) {
  return path.toLowerCase().endsWith('.wem')
}

function maxWwiseSamples() {
  return WWISE_OPUS_SAMPLE_RATE * MAX_AUDIO_DURATION_SECONDS
}
