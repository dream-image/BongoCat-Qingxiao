import type { MenuItemOptions, PredefinedMenuItemOptions, SubmenuOptions } from '@tauri-apps/api/menu'

import { useI18n } from 'vue-i18n'

import modelRuntime from '@/utils/model-runtime'

type PetActionMenuItem = MenuItemOptions | PredefinedMenuItemOptions | SubmenuOptions

const PET_ACTION_SUBMENU_ID = 'bongocat.pet-actions'

function getPetActionMenuItemId(itemId: string) {
  return `bongocat.pet-action.${encodeURIComponent(itemId)}`
}

function getPetActionGroupId(kind: 'active' | 'passive', groupId: number | string) {
  return `bongocat.pet-action-group.${kind}.${encodeURIComponent(String(groupId))}`
}

export function usePetActionMenu() {
  const { locale, t } = useI18n()

  const beginPetActionMenu = async () => {
    // 先建立 runtime 会话再构建原生资源，使菜单打开期间的导航键和被动动作从第一刻就被抑制。
    const session = modelRuntime.beginPetActionMenu(locale.value)
    let ended = false

    const end = () => {
      // popup、Menu.new 或 close 任一路径都可能请求收尾，幂等门禁避免同一 revision 被重复提交。
      if (ended || !session) return

      ended = true
      modelRuntime.endPetActionMenu(session.revision)
    }

    try {
      const activeGroups = session?.activeGroups.filter(group => group.actions.length > 0) ?? []
      const passiveGroups = session?.passiveGroups.filter(group => group.actions.length > 0) ?? []
      const items: PetActionMenuItem[] = []
      const createActionItem = (
        action: typeof activeGroups[number]['actions'][number],
        groupLabel?: string,
      ) => {
        const actionLabel = action.label || action.id

        return {
          id: getPetActionMenuItemId(action.id),
          text: groupLabel ? `${groupLabel} · ${actionLabel}` : actionLabel,
          enabled: action.enabled,
          action: () => {
            if (session) modelRuntime.selectPetActionMenuAction(session.revision, action.id)
          },
        } satisfies MenuItemOptions
      }

      for (const [groupIndex, group] of activeGroups.entries()) {
        if (groupIndex > 0) {
          items.push({ item: 'Separator' })
        }

        const groupLabel = group.label || t('composables.usePetActionMenu.group')

        items.push(...group.actions.map(action => createActionItem(action, groupLabel)))
      }

      if (passiveGroups.length > 0) {
        if (items.length > 0) items.push({ item: 'Separator' })

        for (const [groupIndex, group] of passiveGroups.entries()) {
          items.push({
            id: getPetActionGroupId('passive', group.id || groupIndex),
            text: group.label || t('composables.usePetActionMenu.passive'),
            items: group.actions.map(action => createActionItem(action)),
          } satisfies SubmenuOptions)
        }
      }

      if (items.length === 0) {
        items.push({
          id: 'bongocat.pet-action.unavailable',
          text: t('composables.usePetActionMenu.unavailable'),
          enabled: false,
        })
      }

      // 使用 raw nested options，由外层 Menu 一次性创建并统一 close，避免每次右键遗留子 Resource。
      const item = {
        id: PET_ACTION_SUBMENU_ID,
        text: t('composables.usePetActionMenu.title'),
        items,
      } satisfies SubmenuOptions

      return { item, end }
    } catch (error) {
      end()

      throw error
    }
  }

  return { beginPetActionMenu }
}
