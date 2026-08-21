import type {
  CheckMenuItemOptions,
  MenuItemOptions,
  PredefinedMenuItemOptions,
  SubmenuOptions,
} from '@tauri-apps/api/menu'

import { exit, relaunch } from '@tauri-apps/plugin-process'
import { range } from 'es-toolkit'
import { useI18n } from 'vue-i18n'

import { WINDOW_LABEL } from '@/constants'
import { showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { isMac } from '@/utils/platform'

export type AppMenuItemOptions
  = | CheckMenuItemOptions
    | MenuItemOptions
    | PredefinedMenuItemOptions
    | SubmenuOptions

// 显式且稳定的原生菜单 ID 便于 Tauri 路由事件，也避免每次 popup 都生成无法追踪的随机身份。
const APP_MENU_ID = {
  alwaysOnTop: 'bongocat.menu.always-on-top',
  hideOrShow: 'bongocat.menu.hide-or-show',
  opacity: 'bongocat.menu.opacity',
  passThrough: 'bongocat.menu.pass-through',
  preference: 'bongocat.menu.preference',
  quit: 'bongocat.menu.quit',
  restart: 'bongocat.menu.restart',
  scale: 'bongocat.menu.scale',
} as const

function valueMenuItemId(group: 'opacity' | 'scale', value: number) {
  // 自定义值也纳入同一 ID 命名空间；编码后不会把小数或未来的特殊字符带入原生标识。
  return `bongocat.menu.${group}.${encodeURIComponent(String(value))}`
}

export function useAppMenu() {
  const catStore = useCatStore()
  const { t } = useI18n()

  const getScaleMenuItems = (): CheckMenuItemOptions[] => {
    const options = range(50, 151, 25)
    const items: CheckMenuItemOptions[] = options.map(item => ({
      id: valueMenuItemId('scale', item),
      text: `${item}%`,
      checked: catStore.window.scale === item,
      action: () => {
        catStore.window.scale = item
      },
    }))

    if (!options.includes(catStore.window.scale)) {
      items.unshift({
        id: valueMenuItemId('scale', catStore.window.scale),
        text: `${catStore.window.scale}%`,
        checked: true,
        enabled: false,
      })
    }

    return items
  }

  const getOpacityMenuItems = (): CheckMenuItemOptions[] => {
    const options = range(25, 101, 25)
    const items: CheckMenuItemOptions[] = options.map(item => ({
      id: valueMenuItemId('opacity', item),
      text: `${item}%`,
      checked: catStore.window.opacity === item,
      action: () => {
        catStore.window.opacity = item
      },
    }))

    if (!options.includes(catStore.window.opacity)) {
      items.unshift({
        id: valueMenuItemId('opacity', catStore.window.opacity),
        text: `${catStore.window.opacity}%`,
        checked: true,
        enabled: false,
      })
    }

    return items
  }

  const getBaseMenu = ({ includeAlwaysOnTop = false } = {}): AppMenuItemOptions[] => {
    // 返回 raw options，让瞬时右键菜单只创建一个根 Resource；根 close 后整棵原生菜单树一起释放。
    return [
      {
        id: APP_MENU_ID.preference,
        text: t('composables.useAppMenu.labels.preference'),
        accelerator: isMac ? 'Cmd+,' : void 0,
        action: () => showWindow(WINDOW_LABEL.PREFERENCE),
      },
      {
        id: APP_MENU_ID.hideOrShow,
        text: catStore.window.visible ? t('composables.useAppMenu.labels.hideCat') : t('composables.useAppMenu.labels.showCat'),
        action: () => {
          catStore.window.visible = !catStore.window.visible
        },
      },
      { item: 'Separator' },
      {
        id: APP_MENU_ID.passThrough,
        text: t('composables.useAppMenu.labels.passThrough'),
        checked: catStore.window.passThrough,
        action: () => {
          catStore.window.passThrough = !catStore.window.passThrough
        },
      },
      ...(includeAlwaysOnTop
        ? [{
          id: APP_MENU_ID.alwaysOnTop,
          text: t('composables.useAppMenu.labels.alwaysOnTop'),
          checked: catStore.window.alwaysOnTop,
          action: () => {
            catStore.window.alwaysOnTop = !catStore.window.alwaysOnTop
          },
        } satisfies CheckMenuItemOptions]
        : []),
      {
        id: APP_MENU_ID.scale,
        text: t('composables.useAppMenu.labels.windowSize'),
        items: getScaleMenuItems(),
      },
      {
        id: APP_MENU_ID.opacity,
        text: t('composables.useAppMenu.labels.opacity'),
        items: getOpacityMenuItems(),
      },
    ]
  }

  const getExitMenu = (): AppMenuItemOptions[] => {
    return [
      {
        id: APP_MENU_ID.restart,
        text: t('composables.useAppMenu.labels.restartApp'),
        action: relaunch,
      },
      {
        id: APP_MENU_ID.quit,
        text: t('composables.useAppMenu.labels.quitApp'),
        accelerator: isMac ? 'Cmd+Q' : void 0,
        action: () => exit(0),
      },
    ]
  }

  return {
    getBaseMenu,
    getExitMenu,
  }
}
