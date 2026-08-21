import { exists, readDir } from '@tauri-apps/plugin-fs'

import live2d from '@/utils/live2d'
import { join, readBoundedTextFile, resolveModelResourcePath } from '@/utils/path'
import sprite from '@/utils/sprite'

const MAX_MODEL_MANIFEST_BYTES = 1024 * 1024

export const MODEL_MODES = ['gamepad', 'keyboard', 'standard'] as const

export type ValidatedModelMode = typeof MODEL_MODES[number]
export type ValidatedModelRenderer = 'live2d' | 'sprite'

export interface ValidatedModelDirectory {
  mode: ValidatedModelMode
  renderer: ValidatedModelRenderer
  id?: string
  displayName?: string
}

interface ValidateModelDirectoryOptions {
  spriteDefaultMode?: ValidatedModelMode
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function detectLive2DMode(path: string): Promise<ValidatedModelMode> {
  const files = await readDir(join(path, 'resources', 'right-keys')).catch(() => [])

  if (files.length === 0) return 'standard'

  const fileNames = files.map(file => file.name.split('.')[0])

  return fileNames.includes('East') ? 'gamepad' : 'keyboard'
}

export async function validateModelDirectory(
  path: string,
  options: ValidateModelDirectoryOptions = {},
): Promise<ValidatedModelDirectory> {
  const manifestCandidate = join(path, 'model.json')

  if (await exists(manifestCandidate)) {
    const manifestPath = await resolveModelResourcePath(path, 'model.json')
    const content = await readBoundedTextFile(
      manifestPath,
      MAX_MODEL_MANIFEST_BYTES,
      'Model manifest',
    )
    const manifest = JSON.parse(content) as unknown

    if (!isRecord(manifest)) {
      throw new TypeError('Model manifest must be an object')
    }

    if (manifest.renderer === 'sprite') {
      const validatedManifest = await sprite.validateModel(path)

      await resolveModelResourcePath(path, 'resources/cover.png')

      return {
        renderer: 'sprite',
        mode: validatedManifest.mode ?? options.spriteDefaultMode ?? 'standard',
        id: validatedManifest.id,
        displayName: validatedManifest.displayName,
      }
    }

    if (manifest.renderer !== undefined && manifest.renderer !== 'live2d') {
      throw new TypeError(`Unsupported model renderer: ${String(manifest.renderer)}`)
    }
  }

  await live2d.validateModel(path)
  await resolveModelResourcePath(path, 'resources/cover.png')

  return {
    renderer: 'live2d',
    mode: await detectLive2DMode(path),
  }
}
