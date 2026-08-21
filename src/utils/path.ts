import { invoke } from '@tauri-apps/api/core'
import { sep } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-fs'

import { INVOKE_KEY } from '../constants'

export function join(...paths: string[]) {
  const joinPaths = paths.map((path, index) => {
    if (index === 0) {
      return path.replace(new RegExp(`${sep()}+$`), '')
    }

    return path.replace(new RegExp(`^${sep()}+|${sep()}+$`, 'g'), '')
  })

  return joinPaths.join(sep())
}

export function resolveModelResourcePath(modelPath: string, resourcePath: string) {
  // 前端字符串检查看不到符号链接真实目标，必须让 Rust 对存在的文件做 canonical 边界判定。
  return invoke<string>(INVOKE_KEY.RESOLVE_MODEL_RESOURCE_PATH, {
    modelPath,
    resourcePath,
  })
}

export async function readFilePrefix(path: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('File read limit must be a positive safe integer')
  }

  // 使用文件句柄分段读取，才能在不加载完整压缩资源的前提下严格执行字节上限。
  const file = await open(path, { read: true })
  // 多读一个字节才能区分“文件刚好等于上限”和“更大文件被截断”；SVG 只有完整落在上限内才可解码。
  const bytes = new Uint8Array(maxBytes + 1)
  let offset = 0

  try {
    const metadata = await file.stat()

    if (!metadata.isFile) throw new TypeError('Image asset must be a file')

    while (offset < bytes.byteLength) {
      const count = await file.read(bytes.subarray(offset))

      if (count === null) break
      if (count <= 0) throw new Error('File read made no progress')

      offset += count
    }

    return {
      bytes: bytes.slice(0, Math.min(offset, maxBytes)),
      complete: offset <= maxBytes && metadata.size <= maxBytes,
    }
  } finally {
    await file.close()
  }
}

export async function readBoundedTextFile(
  path: string,
  maxBytes: number,
  label: string,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('Text file read limit must be a positive safe integer')
  }

  // 不使用 readTextFile：它会在校验前一次性把不受信任的 manifest 全部读进 WebView 内存。
  const file = await open(path, { read: true })

  try {
    const metadata = await file.stat()

    // 先看元数据、再最多读取 limit + 1 字节，兼顾正常文件的低开销和校验期间文件增长的竞态。
    if (!metadata.isFile || metadata.size > maxBytes) {
      throw new RangeError(`${label} exceeds the ${maxBytes} byte limit`)
    }

    const bytes = new Uint8Array(maxBytes + 1)
    let offset = 0

    while (offset < bytes.byteLength) {
      const count = await file.read(bytes.subarray(offset))

      if (count === null) break
      if (count <= 0) throw new Error(`${label} read made no progress`)

      offset += count
    }

    if (offset > maxBytes) {
      throw new RangeError(`${label} exceeds the ${maxBytes} byte limit`)
    }

    // fatal UTF-8 解码避免替换字符让恶意/损坏 JSON 在不同运行时产生不同解析结果。
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await file.close()
  }
}
