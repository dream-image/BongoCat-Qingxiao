import type { MotionInfo } from 'easy-live2d'

import { convertFileSrc } from '@tauri-apps/api/core'
import { readDir } from '@tauri-apps/plugin-fs'
import { Config, CubismSetting, Live2DSprite, Priority } from 'easy-live2d'
import { groupBy } from 'es-toolkit/compat'
import JSON5 from 'json5'
import { Application, Ticker } from 'pixi.js'

import type { ModelSize } from '@/composables/useModel'

import { i18n } from '@/locales'

import { readBoundedTextFile, resolveModelResourcePath } from './path'

Config.MouseFollow = false

const MAX_LIVE2D_MANIFEST_BYTES = 1024 * 1024
const MAX_LIVE2D_RESOURCE_REFERENCES = 1024

type UnknownRecord = Record<string, unknown>

interface ValidatedLive2DModel {
  modelSetting: CubismSetting
}

class Live2d {
  private app: Application | null = null
  private appInitPromise: Promise<void> | null = null
  private loadGeneration = 0
  private loadQueue: Promise<void> = Promise.resolve()
  public model: Live2DSprite | null = null

  constructor() { }

  private async initApp() {
    if (this.appInitPromise) {
      await this.appInitPromise

      return
    }

    if (this.app) return

    const view = document.getElementById('live2dCanvas') as HTMLCanvasElement
    const app = new Application()

    this.app = app
    this.appInitPromise = app.init({
      view,
      resizeTo: window,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: devicePixelRatio,
    })

    try {
      await this.appInitPromise
    } catch (error) {
      if (this.app === app) this.app = null

      throw error
    } finally {
      this.appInitPromise = null
    }
  }

  public async load(path: string) {
    const generation = ++this.loadGeneration
    const previousLoad = this.loadQueue
    let releaseLoad!: () => void

    this.loadQueue = new Promise((resolve) => {
      releaseLoad = resolve
    })

    try {
      await previousLoad

      this.assertGeneration(generation)
      const { modelSetting } = await this.readAndValidateModel(path, generation)

      this.assertGeneration(generation)
      this.destroyModel()

      await this.initApp()

      this.assertGeneration(generation)

      const model = new Live2DSprite({
        modelSetting,
        ticker: Ticker.shared,
      })

      this.app?.stage.addChild(model)

      try {
        await model.ready

        this.assertGeneration(generation)

        this.model = model

        const { width, height } = model
        const motions = groupBy(model.getMotions(), 'group')
        const expressions = model.getExpressions()

        return {
          width,
          height,
          motions,
          expressions,
        }
      } catch (error) {
        if (this.model === model) this.model = null

        model.destroy()

        throw error
      }
    } finally {
      releaseLoad()
    }
  }

  public async validateModel(path: string) {
    await this.readAndValidateModel(path)
  }

  public destroy() {
    ++this.loadGeneration
    this.destroyModel()
  }

  private assertGeneration(generation: number) {
    if (generation === this.loadGeneration) return

    throw new DOMException('Live2D model load was superseded', 'AbortError')
  }

  private async readAndValidateModel(
    path: string,
    generation?: number,
  ): Promise<ValidatedLive2DModel> {
    this.assertLoadGeneration(generation)

    const files = await readDir(path)
    const modelFiles = files
      .filter(file => file.isFile && file.name.endsWith('.model3.json'))
      .sort((left, right) => left.name.localeCompare(right.name))

    this.assertLoadGeneration(generation)

    if (modelFiles.length === 0) {
      throw new Error(i18n.global.t('utils.live2d.hints.notFound'))
    }
    if (modelFiles.length > 1) {
      throw new Error('Live2D model directory must contain exactly one .model3.json file')
    }

    const modelPath = await resolveModelResourcePath(path, modelFiles[0].name)

    this.assertLoadGeneration(generation)

    const modelJSON = JSON5.parse(await readBoundedTextFile(
      modelPath,
      MAX_LIVE2D_MANIFEST_BYTES,
      'Live2D model manifest',
    )) as unknown

    this.assertLoadGeneration(generation)

    const resourceFiles = this.collectResourceFiles(modelJSON)
    const resolvedResources = new Map<string, string>()

    // 逐个 canonicalize，避免恶意 manifest 一次创建上千个 invoke 和文件系统任务。
    for (const resourceFile of resourceFiles) {
      const resolvedPath = await resolveModelResourcePath(path, resourceFile)

      this.assertLoadGeneration(generation)
      resolvedResources.set(resourceFile, resolvedPath)
    }

    // 所有资源都通过根目录边界检查后才交给 Cubism，防止 SDK 在校验完成前自行请求外部路径。
    const modelSetting = new CubismSetting({ modelJSON })

    modelSetting.redirectPath(({ file }) => {
      const resolvedPath = resolvedResources.get(file)

      if (!resolvedPath) {
        throw new Error(`Live2D model contains an unvalidated resource: ${file}`)
      }

      return convertFileSrc(resolvedPath)
    })

    return { modelSetting }
  }

  private collectResourceFiles(modelJSON: unknown) {
    if (!this.isRecord(modelJSON)) {
      throw new TypeError('Live2D model manifest must be an object')
    }

    const fileReferences = modelJSON.FileReferences

    if (!this.isRecord(fileReferences)) {
      throw new TypeError('Live2D model manifest must contain FileReferences')
    }

    const resources: string[] = []
    const addResource = (value: unknown, label: string, optional = false) => {
      if (optional && (value === undefined || value === '')) return
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty resource path`)
      }
      if (resources.length >= MAX_LIVE2D_RESOURCE_REFERENCES) {
        throw new RangeError(
          `Live2D model exceeds the ${MAX_LIVE2D_RESOURCE_REFERENCES} resource limit`,
        )
      }

      resources.push(value)
    }

    addResource(fileReferences.Moc, 'FileReferences.Moc')

    if (!Array.isArray(fileReferences.Textures) || fileReferences.Textures.length === 0) {
      throw new TypeError('FileReferences.Textures must contain at least one texture')
    }

    fileReferences.Textures.forEach((texture, index) => {
      addResource(texture, `FileReferences.Textures[${index}]`)
    })

    for (const key of ['Physics', 'Pose', 'UserData', 'DisplayInfo', 'MotionSync']) {
      addResource(fileReferences[key], `FileReferences.${key}`, true)
    }

    if (fileReferences.Expressions !== undefined) {
      if (!Array.isArray(fileReferences.Expressions)) {
        throw new TypeError('FileReferences.Expressions must be an array')
      }

      fileReferences.Expressions.forEach((expression, index) => {
        if (!this.isRecord(expression)) {
          throw new TypeError(`FileReferences.Expressions[${index}] must be an object`)
        }

        addResource(
          expression.File,
          `FileReferences.Expressions[${index}].File`,
        )
      })
    }

    if (fileReferences.Motions !== undefined) {
      if (!this.isRecord(fileReferences.Motions)) {
        throw new TypeError('FileReferences.Motions must be an object')
      }

      for (const [group, motions] of Object.entries(fileReferences.Motions)) {
        if (!Array.isArray(motions)) {
          throw new TypeError(`FileReferences.Motions.${group} must be an array`)
        }

        motions.forEach((motion, index) => {
          if (!this.isRecord(motion)) {
            throw new TypeError(`FileReferences.Motions.${group}[${index}] must be an object`)
          }

          addResource(motion.File, `FileReferences.Motions.${group}[${index}].File`)
          addResource(
            motion.Sound,
            `FileReferences.Motions.${group}[${index}].Sound`,
            true,
          )
        })
      }
    }

    return [...new Set(resources)]
  }

  private isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private assertLoadGeneration(generation?: number) {
    if (generation === undefined) return

    this.assertGeneration(generation)
  }

  private destroyModel() {
    if (!this.model) return

    this.model.destroy()

    this.model = null
  }

  public resizeModel(modelSize: ModelSize) {
    if (!this.model) return

    const { width, height } = modelSize

    const scaleX = innerWidth / width
    const scaleY = innerHeight / height
    const scale = Math.min(scaleX, scaleY)

    this.model.scale.set(scale)
    this.model.x = innerWidth / 2
    this.model.y = innerHeight / 2
    this.model.anchor.set(0.5)
  }

  public startMotion(motion: MotionInfo) {
    return this.model?.startMotion({
      ...motion,
      priority: Priority.Normal,
    })
  }

  public setExpression(index: number) {
    return this.model?.setExpression({ index })
  }

  public getParameterValueRange(id: string) {
    return this.model?.getParameterValueRangeById(id)
  }

  public setParameterValue(id: string, value: number | boolean) {
    return this.model?.setParameterValueById(id, Number(value))
  }

  public setMotionSoundEnabled(enabled: boolean) {
    Config.MotionSound = enabled
  }

  public setMaxFPS(fps: number) {
    Ticker.shared.maxFPS = fps
  }
}

const live2d = new Live2d()

export default live2d
