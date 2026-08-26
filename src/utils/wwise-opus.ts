export interface WwiseOpusStream {
  channels: 1 | 2
  sampleRate: 48000
  preSkip: number
  sampleCount: number
  frames: Uint8Array[]
}

interface RiffChunk {
  offset: number
  size: number
}

const WWISE_OPUS_FORMAT = 0x3041
const WWISE_OPUS_SAMPLE_RATE = 48_000

/**
 * 解析新版 Wwise Opus WEM（format 0x3041），只提取原始 Opus 帧，不做离线转码。
 * Wwise 把每帧长度依次放在 seek chunk，data chunk 则紧密存放对应帧；拆包后可直接交给 libopus。
 */
export function parseWwiseOpusWem(bytes: Uint8Array, maxSamples: number): WwiseOpusStream {
  if (bytes.byteLength < 12 || readFourCC(bytes, 0) !== 'RIFF'
    || readFourCC(bytes, 8) !== 'WAVE') {
    throw new TypeError('Audio asset is not a little-endian Wwise RIFF/WEM file')
  }
  if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
    throw new RangeError('Wwise Opus sample limit must be a positive safe integer')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks = readRiffChunks(bytes, view)
  const format = requireChunk(chunks, 'fmt ')
  const seek = requireChunk(chunks, 'seek')
  const data = requireChunk(chunks, 'data')

  // 0x3041 的扩展 fmt 至少到 mapping 字段（相对 chunk 数据起点 0x23）。
  if (format.size < 0x24 || view.getUint16(format.offset, true) !== WWISE_OPUS_FORMAT) {
    throw new TypeError('Audio asset must use Wwise Opus format 0x3041')
  }

  const channels = view.getUint16(format.offset + 0x02, true)
  const sampleCount = view.getUint32(format.offset + 0x18, true)
  const packetCount = view.getUint32(format.offset + 0x1C, true)
  const preSkip = view.getUint16(format.offset + 0x20, true)
  const codecVersion = view.getUint8(format.offset + 0x22)
  const mapping = view.getUint8(format.offset + 0x23)

  // 清宵资源是标准 mono；先明确支持 Wwise 的 mono/stereo mapping 0，避免错误声道映射静默出错。
  if ((channels !== 1 && channels !== 2) || mapping !== 0) {
    throw new RangeError('Only mono/stereo Wwise Opus mapping 0 audio is supported')
  }
  if (codecVersion !== 1) throw new TypeError('Unsupported Wwise Opus codec version')
  if (sampleCount <= 0 || sampleCount > maxSamples) {
    throw new RangeError(`Wwise Opus audio exceeds the ${maxSamples} sample limit`)
  }
  if (packetCount <= 0 || packetCount > 65_535 || seek.size !== packetCount * 2) {
    throw new RangeError('Wwise Opus seek table does not match its packet count')
  }

  const frames: Uint8Array[] = []
  let dataCursor = data.offset

  for (let index = 0; index < packetCount; index++) {
    const frameSize = view.getUint16(seek.offset + index * 2, true)
    const frameEnd = dataCursor + frameSize

    if (frameSize <= 0 || frameEnd > data.offset + data.size) {
      throw new RangeError('Wwise Opus packet sizes exceed the data chunk')
    }

    frames.push(bytes.slice(dataCursor, frameEnd))
    dataCursor = frameEnd
  }

  if (dataCursor !== data.offset + data.size) {
    throw new RangeError('Wwise Opus packet sizes do not consume the data chunk')
  }

  return {
    channels,
    sampleRate: WWISE_OPUS_SAMPLE_RATE,
    preSkip,
    sampleCount,
    frames,
  }
}

function readRiffChunks(bytes: Uint8Array, view: DataView) {
  const chunks = new Map<string, RiffChunk>()
  let offset = 12

  while (offset + 8 <= bytes.byteLength) {
    const id = readFourCC(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const dataOffset = offset + 8
    const end = dataOffset + size

    if (end > bytes.byteLength) throw new RangeError(`RIFF chunk "${id}" exceeds the audio file`)
    if (!chunks.has(id)) chunks.set(id, { offset: dataOffset, size })

    // RIFF 的非末尾奇数字节 chunk 需要 pad；部分 Wwise WEM 会省略文件最后一个 data chunk 的 pad 字节。
    offset = end < bytes.byteLength ? end + (size % 2) : end
  }

  if (offset !== bytes.byteLength) throw new RangeError('RIFF audio has a truncated chunk header')

  return chunks
}

function requireChunk(chunks: Map<string, RiffChunk>, id: string) {
  const chunk = chunks.get(id)

  if (!chunk) throw new TypeError(`Wwise Opus audio is missing the "${id}" chunk`)

  return chunk
}

function readFourCC(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  )
}
