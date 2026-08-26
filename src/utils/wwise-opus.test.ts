/* eslint-disable test/no-import-node-test -- 项目未引入 Vitest，复用 Node 测试运行器可避免仅为四个解析用例新增依赖。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { OpusDecoder } from 'opus-decoder'

import { parseWwiseOpusWem } from './wwise-opus'

const MAX_TEST_SAMPLES = 48_000 * 30
const AUDIO_DIRECTORY = new URL('../../src-tauri/assets/models/qingxiao/audio/', import.meta.url)
const FIXTURES = [
  ['common-voice-08-question.wem', 56, 53_272],
  ['common-voice-09-help.wem', 99, 94_368],
  ['common-voice-11-hum.wem', 81, 77_312],
  ['common-voice-12-praise.wem', 48, 44_960],
  ['common-voice-14-hm.wem', 28, 25_808],
  ['common-voice-16-arrival.wem', 40, 37_984],
  ['common-voice-17-safe-return.wem', 70, 66_240],
] as const

test('parses and decodes every bundled Qingxiao Wwise Opus file', async () => {
  for (const [name, expectedPackets, expectedSamples] of FIXTURES) {
    const stream = parseWwiseOpusWem(await fixture(name), MAX_TEST_SAMPLES)

    assert.equal(stream.channels, 1, name)
    assert.equal(stream.sampleRate, 48_000, name)
    assert.equal(stream.frames.length, expectedPackets, name)
    assert.equal(stream.sampleCount, expectedSamples, name)

    // 解析成功并不代表拆出的包能交给 libopus；实际解码一次可覆盖 seek/data 拆包契约。
    const decoder = new OpusDecoder({
      channels: stream.channels,
      sampleRate: stream.sampleRate,
      preSkip: stream.preSkip,
      streamCount: 1,
      coupledStreamCount: 0,
      channelMappingTable: [0],
    })

    try {
      await decoder.ready

      const decoded = decoder.decodeFrames(stream.frames)

      assert.deepEqual(decoded.errors, [], name)
      assert.ok(decoded.samplesDecoded >= stream.sampleCount, name)
    } finally {
      decoder.free()
    }
  }
})

test('accepts Wwise files that omit the optional final RIFF padding byte', async () => {
  const bytes = await fixture('common-voice-08-question.wem')

  // 该真实文件的 data chunk 为奇数长度且文件末尾没有 pad，是本次兼容逻辑对应的回归样本。
  assert.equal(bytes.byteLength % 2, 1)
  assert.equal(parseWwiseOpusWem(bytes, MAX_TEST_SAMPLES).frames.length, 56)
})

test('rejects malformed containers, unsupported mappings, bad packet tables, and truncation', async () => {
  assert.throws(
    () => parseWwiseOpusWem(new Uint8Array(12), MAX_TEST_SAMPLES),
    /not a little-endian Wwise RIFF\/WEM/,
  )

  const source = await fixture('common-voice-14-hm.wem')
  const format = findChunk(source, 'fmt ')
  const seek = findChunk(source, 'seek')

  const unsupportedMapping = source.slice()
  unsupportedMapping[format.offset + 0x23] = 1
  assert.throws(
    () => parseWwiseOpusWem(unsupportedMapping, MAX_TEST_SAMPLES),
    /Only mono\/stereo Wwise Opus mapping 0/,
  )

  const packetCountMismatch = source.slice()
  const packetCountView = new DataView(packetCountMismatch.buffer)
  packetCountView.setUint32(
    format.offset + 0x1C,
    packetCountView.getUint32(format.offset + 0x1C, true) + 1,
    true,
  )
  assert.throws(
    () => parseWwiseOpusWem(packetCountMismatch, MAX_TEST_SAMPLES),
    /seek table does not match/,
  )

  const emptyPacket = source.slice()
  new DataView(emptyPacket.buffer).setUint16(seek.offset, 0, true)
  assert.throws(
    () => parseWwiseOpusWem(emptyPacket, MAX_TEST_SAMPLES),
    /packet sizes exceed/,
  )

  assert.throws(
    () => parseWwiseOpusWem(source.slice(0, -1), MAX_TEST_SAMPLES),
    /chunk "data" exceeds/,
  )
})

test('enforces the caller-provided decoded duration budget', async () => {
  const source = await fixture('common-voice-14-hm.wem')
  const declaredSamples = parseWwiseOpusWem(source, MAX_TEST_SAMPLES).sampleCount

  assert.throws(
    () => parseWwiseOpusWem(source, declaredSamples - 1),
    /exceeds the .* sample limit/,
  )
})

async function fixture(name: string) {
  const bytes = await readFile(new URL(name, AUDIO_DIRECTORY))

  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function findChunk(bytes: Uint8Array, expectedId: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let headerOffset = 12

  while (headerOffset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(headerOffset, headerOffset + 4))
    const size = view.getUint32(headerOffset + 4, true)
    const offset = headerOffset + 8
    const end = offset + size

    if (id === expectedId) return { offset, size }

    headerOffset = end < bytes.byteLength ? end + (size % 2) : end
  }

  throw new Error(`Fixture does not contain RIFF chunk "${expectedId}"`)
}
