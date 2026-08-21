import type { MenuItemOptions, PredefinedMenuItemOptions, SubmenuOptions } from '@tauri-apps/api/menu'

import { useI18n } from 'vue-i18n'

import modelRuntime from '@/utils/model-runtime'

type PetActionMenuItem = MenuItemOptions | PredefinedMenuItemOptions

const PET_ACTION_SUBMENU_ID = 'bongocat.pet-actions'

function getPetActionMenuItemId(triggerId: string) {
  return `bongocat.pet-action.${encodeURIComponent(triggerId)}`
}

function getPetActionGroupId(groupIndex: number) {
  return `bongocat.pet-action-group.${groupIndex}`
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
      const groups = session?.groups.filter(group => group.actions.length > 0) ?? []
      const items: PetActionMenuItem[] = []

      for (const [groupIndex, group] of groups.entries()) {
        if (groupIndex > 0) {
          items.push({ item: 'Separator' })
        }

        items.push({
          id: getPetActionGroupId(groupIndex),
          text: group.label || t('composables.usePetActionMenu.group'),
          enabled: false,
        })

        items.push(...group.actions.map((action) => {
          return {
            // 固定 id 让原生事件身份跨多次打开保持可追踪；channel 生命周期仍由外层 root close 统一结束。
            id: getPetActionMenuItemId(action.id),
            text: action.label || action.id,
            enabled: action.enabled,
            action: () => {
              // 原生菜单回调只记录选择，等 popup 完全关闭后再由 runtime 播放，避免菜单与动画争用状态。
              if (session) modelRuntime.selectPetActionMenuAction(session.revision, action.id)
            },
          } satisfies MenuItemOptions
        }))
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
