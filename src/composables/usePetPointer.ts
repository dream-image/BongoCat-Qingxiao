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

    if (signature === hoverSignature) return

    clearHover()
    hoverSignature = signature

    const interaction = areas
      .map(area => modelRuntime.resolvePetInteraction({ event: 'hover', area, point }))
      .find(Boolean)

    if (!interaction) return

    const trigger = () => {
      hoverTimer = void 0

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
