export const GITHUB_LINK = 'https://github.com/ayangweb/BongoCat'

export const UPGRADE_LINK_ACCESS_KEY = 'xDbrq2rOoRThDqKOHL2ZRA'

export const LISTEN_KEY = {
  SHOW_WINDOW: 'show-window',
  HIDE_WINDOW: 'hide-window',
  DEVICE_CHANGED: 'device-changed',
  // 与输入数据流分离，确保前端能在无按键事件时感知监听器失效并重启。
  DEVICE_LISTENER_STATUS: 'device-listener-status',
  UPDATE_APP: 'update-app',
  GAMEPAD_CHANGED: 'gamepad-changed',
  START_MOTION: 'start-motion',
  SET_EXPRESSION: 'set-expression',
  REQUEST_PET_ACTION_CATALOG: 'request-pet-action-catalog',
  PET_ACTION_CATALOG: 'pet-action-catalog',
  TRIGGER_PET_ACTION: 'trigger-pet-action',
  PET_ACTION_TRIGGERED: 'pet-action-triggered',
}

export const INVOKE_KEY = {
  IMPORT_MODEL_DIRECTORY: 'import_model_directory',
  // 模型资源必须由 Rust canonicalize 后再交给 WebView，避免符号链接绕过前端相对路径校验。
  RESOLVE_MODEL_RESOURCE_PATH: 'resolve_model_resource_path',
  START_DEVICE_LISTENING: 'start_device_listening',
  START_GAMEPAD_LISTING: 'start_gamepad_listing',
  STOP_GAMEPAD_LISTING: 'stop_gamepad_listing',
}

export const LANGUAGE = {
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW',
  EN_US: 'en-US',
  VI_VN: 'vi-VN',
  PT_BR: 'pt-BR',
} as const

export const WINDOW_LABEL = {
  MAIN: 'main',
  PREFERENCE: 'preference',
} as const
