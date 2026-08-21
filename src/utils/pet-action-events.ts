import type { PetActionCatalogView } from './pet-behavior'

export interface PetActionCatalogRequest {
  requestId: string
  modelId: string
  locale: string
}

export interface PetActionCatalogResponse {
  requestId: string
  modelId: string
  catalog: PetActionCatalogView | null
}

export interface PetActionTriggerRequest {
  requestId: string
  modelId: string
  itemId: string
}

export interface PetActionTriggerResponse extends PetActionTriggerRequest {
  accepted: boolean
}

export function getPetActionShortcutId(modelId: string, itemId: string) {
  return `${modelId}:pet-action:${itemId}`
}
