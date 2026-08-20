import type { PetInteractionEvent, PetPoint } from '@/utils/pet-behavior'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import modelRuntime from '@/utils/model-runtime'
import { PET_MAX_TAP_DISTANCE } from '@/utils/pet-behavior'

interface PetPointerModelSize {
  width: number
  height: number
}

interface PointerGesture {
  id: number
  target: HTMLElement
  startedAt: number
  previousPoint: PetPoint
  previousClientPoint: PetPoint
  tapAreas: string[]
  clientDistance: number
  strokeDistances: Map<string, number>
  tapCancelled: boolean
  strokeTriggered: boolean
  consumeUntilUp: boolean
}

interface PetPointerPosition {
  point: PetPoint
  clientPoint: PetPoint
  inside: boolean
}

const MAX_TAP_DURATION = 500
const DEFAULT_STROKE_DISTANCE = 120
const DEFAULT_STROKE_WINDOW = 900

export function usePetPointer(
  getModelSize: () => PetPointerModelSize | undefined,
  startDragging: () => void | Promise<void>,
) {
  const catStore = useCatStore()
  const modelStore = useModelStore()
  let gesture: PointerGesture | undefined
  let hoverSignature = ''
  let hoverTimer: ReturnType<typeof setTimeout> | undefined

  // 指针交互只能建立在“用户实际看得见且窗口真正接收事件”的精灵上，否则命中区会和画面错位，
  // 也可能在穿透/悬停隐藏期间截走本应交给桌面的点击。
  function canInteract() {
    return modelStore.currentModel?.renderer === 'sprite'
      && modelStore.modelReady
      && catStore.pet.enabled
      && catStore.pet.mouseInteractions
      && catStore.window.visible
      && !catStore.model.ignoreMouse
      && !catStore.window.passThrough
      && !catStore.window.hideOnHover
  }

  function getPosition(
    event: PointerEvent,
    target: EventTarget | null = event.currentTarget,
  ): PetPointerPosition | undefined {
    const size = getModelSize()
    const element = target

    if (!size || !(element instanceof HTMLElement)) return

    const bounds = element.getBoundingClientRect()

    if (bounds.width <= 0 || bounds.height <= 0) return

    // 渲染器用 contain 方式等比绘制，命中测试必须反算同一份留白和缩放；直接使用 DOM 坐标
    // 会在窗口比例变化后把透明留白误认为角色。镜像只改变模型 X，不改变屏幕端的移动距离。
    const scale = Math.min(bounds.width / size.width, bounds.height / size.height)
    const renderedWidth = size.width * scale
    const renderedHeight = size.height * scale
    const offsetX = (bounds.width - renderedWidth) / 2
    const offsetY = (bounds.height - renderedHeight) / 2
    const renderedX = event.clientX - bounds.left - offsetX
    const renderedY = event.clientY - bounds.top - offsetY

    let x = renderedX / scale
    const y = renderedY / scale

    if (catStore.model.mirror) x = size.width - x

    return {
      point: { x, y },
      clientPoint: { x: event.clientX, y: event.clientY },
      inside: renderedX >= 0
        && renderedX <= renderedWidth
        && renderedY >= 0
        && renderedY <= renderedHeight,
    }
  }

  function dispatch(
    event: PetInteractionEvent,
    point: PetPoint,
    areas: string[],
    metrics: { holdMs?: number, distance?: number, elapsedMs?: number } = {},
  ) {
    // 重叠命中区按 hitAreas 的声明顺序尝试，首个成功动作即消费事件，避免一次手势抢播多段动画。
    return areas.some((area) => {
      return modelRuntime.handlePetInteraction({ event, area, point, ...metrics })
    })
  }

  function clearHover() {
    hoverSignature = ''

    if (hoverTimer === void 0) return

    clearTimeout(hoverTimer)
    hoverTimer = void 0
  }

  function updateHover(point: PetPoint) {
    const areas = modelRuntime.hitTestPetPointer(point)
    const signature = areas.join('\0')

    // 同一组重叠命中区只启动一个 hold 计时器，避免每次 pointermove 都把悬停延后。
    if (signature === hoverSignature) return

    clearHover()
    hoverSignature = signature

    const interaction = areas
      .map(area => modelRuntime.resolvePetInteraction({ event: 'hover', area, point }))
      .find(Boolean)

    if (!interaction) return

    const trigger = () => {
      hoverTimer = void 0

      // 定时器触发时窗口/模型可能已经切换；签名用于拒绝旧命中区留下的延迟动作。
      if (!canInteract() || hoverSignature !== signature) {
        if (hoverSignature === signature) hoverSignature = ''

        return
      }

      if (!dispatch('hover', point, areas, { holdMs: interaction.holdMs ?? 0 })
        && hoverSignature === signature) {
        hoverSignature = ''
      }
    }

    if (interaction.holdMs) {
      hoverTimer = setTimeout(trigger, interaction.holdMs)
    } else {
      trigger()
    }
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0 || event.shiftKey || !canInteract()) return false

    const position = getPosition(event)

    if (!position?.inside) return false

    const { clientPoint, point } = position

    const areas = modelRuntime.hitTestPetPointer(point)
    const tapAreas = areas.filter((area) => {
      return modelRuntime.resolvePetInteraction({ event: 'tap', area, point }) !== void 0
    })
    const hasTapInteraction = tapAreas.length > 0
    const strokeAreas = areas.filter((area) => {
      return modelRuntime.resolvePetInteraction({ event: 'stroke', area, point }) !== void 0
    })
    const hasStrokeInteraction = strokeAreas.length > 0
    const pointerBlocked = modelRuntime.isPetPointerBlocked()

    // 只为模型声明过的区域接管指针。进入/退出动画期间仍要吞掉已命中区域的手势，
    // 防止一次按下先落到角色、随后又意外转成窗口拖动。
    if (!hasTapInteraction && !hasStrokeInteraction && !(pointerBlocked && areas.length > 0)) {
      return false
    }

    clearHover()
    const element = event.currentTarget

    if (!(element instanceof HTMLElement)) return false

    gesture = {
      id: event.pointerId,
      target: element,
      startedAt: performance.now(),
      previousPoint: point,
      previousClientPoint: clientPoint,
      tapAreas,
      clientDistance: 0,
      strokeDistances: new Map(pointerBlocked ? [] : strokeAreas.map(area => [area, 0])),
      tapCancelled: pointerBlocked,
      strokeTriggered: false,
      consumeUntilUp: pointerBlocked,
    }

    element.addEventListener('lostpointercapture', handleLostPointerCapture)

    try {
      // capture 保证移出角色甚至移出窗口后仍能收到 up/cancel，手势状态不会永久残留。
      element.setPointerCapture(event.pointerId)
    } catch {
      clearGesture(false)

      return false
    }

    return true
  }

  function handlePointerMove(event: PointerEvent) {
    if (!canInteract()) {
      reset()

      return
    }

    if (!gesture || gesture.id !== event.pointerId) {
      const position = getPosition(event)

      if (position?.inside) updateHover(position.point)
      else clearHover()

      return
    }

    const position = getPosition(event, gesture.target)

    if (!position) {
      clearGesture()

      return
    }

    const strokeStep = updateGesturePosition(gesture, position)

    // 手势开始后若状态机进入不可交互阶段，本次手势必须一直消费到抬起；中途重新开放
    // 会把同一次按压错误识别成新的轻点或抚摸。
    if (gesture.consumeUntilUp || modelRuntime.isPetPointerBlocked()) {
      gesture.consumeUntilUp = true
      gesture.tapCancelled = true
      gesture.strokeDistances.clear()

      return
    }

    if (gesture.strokeTriggered) return

    const elapsedMs = performance.now() - gesture.startedAt
    const { point } = position

    if (!position.inside) {
      gesture.strokeDistances.clear()
      transferToDraggingIfUnclaimed(gesture)

      return
    }

    const areas = modelRuntime.hitTestPetPointer(point)
    const activeAreas = new Set(areas)

    // 抚摸距离仅在同一命中区内累计。离开区域后继续累计会让绕过角色的窗口拖动误触动作。
    for (const area of gesture.strokeDistances.keys()) {
      if (!activeAreas.has(area)) gesture.strokeDistances.delete(area)
    }

    for (const [area, previousDistance] of gesture.strokeDistances) {
      const interaction = modelRuntime.resolvePetInteraction({ event: 'stroke', area, point })

      if (!interaction) {
        gesture.strokeDistances.delete(area)

        continue
      }

      const strokeDistance = previousDistance + strokeStep
      const distance = interaction.distance ?? DEFAULT_STROKE_DISTANCE
      const windowMs = interaction.windowMs ?? DEFAULT_STROKE_WINDOW

      if (elapsedMs > windowMs) {
        gesture.strokeDistances.delete(area)

        continue
      }

      gesture.strokeDistances.set(area, strokeDistance)

      if (strokeDistance < distance) continue

      gesture.strokeTriggered = modelRuntime.handlePetInteraction({
        event: 'stroke',
        area,
        point,
        distance: strokeDistance,
        elapsedMs,
      })

      if (gesture.strokeTriggered) break
    }

    transferToDraggingIfUnclaimed(gesture)
  }

  function handlePointerUp(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return false

    const current = gesture
    const position = getPosition(event, current.target)

    if (position) updateGesturePosition(current, position)

    const point = position?.point ?? current.previousPoint
    const elapsedMs = performance.now() - current.startedAt
    const areas = position?.inside ? new Set(modelRuntime.hitTestPetPointer(point)) : new Set<string>()
    const candidates = current.tapAreas.filter(area => areas.has(area))

    // 轻点要求按下和抬起仍在同一区域，并使用屏幕像素限制抖动；模型坐标会随窗口缩放，
    // 不适合作为不同缩放比例下稳定的点击阈值。
    if (position?.inside
      && !current.tapCancelled
      && !current.strokeTriggered
      && current.clientDistance <= PET_MAX_TAP_DISTANCE) {
      for (const area of candidates) {
        const interaction = modelRuntime.resolvePetInteraction({ event: 'tap', area, point })

        if (!interaction) continue

        const maximumDuration = interaction.windowMs
          ?? (interaction.holdMs ?? 0) + MAX_TAP_DURATION

        if (elapsedMs > maximumDuration) continue

        if (modelRuntime.handlePetInteraction({
          event: 'tap',
          area,
          point,
          holdMs: elapsedMs,
          distance: current.clientDistance,
          elapsedMs,
        })) {
          break
        }
      }
    }

    clearGesture()

    return true
  }

  function handlePointerCancel(event: PointerEvent) {
    if (gesture?.id !== event.pointerId) return

    clearGesture()
  }

  function handleLostPointerCapture(event: PointerEvent) {
    if (!gesture || gesture.id !== event.pointerId) return

    gesture.target.removeEventListener('lostpointercapture', handleLostPointerCapture)
    gesture = void 0
    clearHover()
  }

  function handlePointerLeave() {
    clearHover()
  }

  function updateGesturePosition(current: PointerGesture, position: PetPointerPosition) {
    const strokeStep = Math.hypot(
      position.point.x - current.previousPoint.x,
      position.point.y - current.previousPoint.y,
    )

    current.clientDistance += Math.hypot(
      position.clientPoint.x - current.previousClientPoint.x,
      position.clientPoint.y - current.previousClientPoint.y,
    )
    current.previousClientPoint = position.clientPoint
    current.previousPoint = position.point

    if (!position.inside) {
      current.tapCancelled = true
    }

    return strokeStep
  }

  function transferToDraggingIfUnclaimed(current: PointerGesture) {
    if (current.strokeTriggered
      || current.strokeDistances.size > 0
      || current.clientDistance <= PET_MAX_TAP_DISTANCE) {
      return false
    }

    // 一旦所有抚摸候选都失效且移动超过轻点阈值，就把控制权交回原窗口拖动逻辑，
    // 这样新增宠物命中区不会破坏用户拖拽桌宠的既有操作。
    clearGesture()
    void startDragging()

    return true
  }

  function clearGesture(releaseCapture = true) {
    const current = gesture

    gesture = void 0

    if (!current) return

    current.target.removeEventListener('lostpointercapture', handleLostPointerCapture)

    if (releaseCapture && current.target.hasPointerCapture(current.id)) {
      current.target.releasePointerCapture(current.id)
    }
  }

  function reset() {
    clearGesture()
    clearHover()
  }

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handlePointerLeave,
    isCapturing: () => gesture !== void 0,
    reset,
  }
}
