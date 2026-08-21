import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export const useModelRuntimeStore = defineStore('model-runtime', () => {
  const modelReady = ref(true)
  const supportKeys = reactive<Record<string, string>>({})
  const pressedKeys = reactive<Record<string, string>>({})
  const currentMotions = ref<Array<[string, MotionInfo[]]>>([])
  const currentExpressions = ref<ExpressionInfo[]>([])

  return {
    modelReady,
    supportKeys,
    pressedKeys,
    currentMotions,
    currentExpressions,
  }
}, {
  tauri: {
    // 运行态由主窗口写入，只同步设置页需要展示的字段，且绝不持久化到磁盘。
    filterKeys: ['modelReady', 'currentMotions', 'currentExpressions'],
    filterKeysStrategy: 'pick',
    save: false,
    saveOnChange: false,
    saveOnExit: false,
  },
})
