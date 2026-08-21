# BongoCat 动作模组契约

## 权威来源

每次制作前重新读取以下实现，因为字段和限制可能继续演进：

- `src/utils/sprite.ts`：模型、动画、气泡、图片预算和完整加载流程
- `src/utils/pet-behavior.ts`：宠物生命周期、hit area、优先级与菜单 catalog
- `src/utils/pet-behavior-module.ts`：模块、action、dialogue、trigger 的严格白名单与默认值
- `src/utils/pet-behavior-scheduler.ts`：本地日期、星期、时刻和跨午夜窗口
- `src/utils/pet-behavior-passive.ts`：会话、回归、活跃度、持续工作与每日窗口状态
- `src/composables/usePetActionMenu.ts`：主动二级菜单和被动三级菜单
- `src-tauri/assets/models/qingxiao/`：当前可运行样例

## 顶层模型要求

可导入动作模型必须仍是完整 Sprite 模型：

```json
{
  "version": 1,
  "id": "character-id",
  "displayName": "角色名",
  "renderer": "sprite",
  "mode": "keyboard",
  "canvas": { "width": 512, "height": 512 },
  "defaultAnimation": "idle",
  "animations": {},
  "bindings": { "keyboard": {}, "mouse": {} },
  "bubbles": {
    "enabled": true,
    "duration": 1380,
    "repeatInterval": 320,
    "rise": 148,
    "fontSize": 29,
    "maxVisible": 4,
    "anchorX": 256,
    "anchorY": 380
  },
  "behaviors": {
    "pet": {
      "activationDelayMs": 15000,
      "enterAnimation": "pet-enter",
      "idleAnimation": "pet-idle",
      "exitAnimation": "pet-exit",
      "hitAreas": {},
      "modules": [
        { "source": "modules/routine/module.json", "enabled": true }
      ]
    }
  }
}
```

`enterAnimation` 和 `exitAnimation` 必须是非循环动画；`idleAnimation` 必须循环。它们都必须位于顶层 `animations`。模块 action 只能引用非循环动画。

Hit area 支持：

- `rect`：`x`、`y`、`width`、`height`
- `ellipse`：`centerX`、`centerY`、`radiusX`、`radiusY`
- `polygon`：至少三个 `{x, y}` 点

所有坐标都使用模型逻辑画布，必须位于画布内。气泡 `anchorX`/`anchorY` 和对白 `anchor` 同样使用逻辑画布坐标。

## 模块模板

```json
{
  "version": 1,
  "id": "routine",
  "displayName": {
    "zh-CN": "日常作息",
    "en-US": "Routine"
  },
  "order": 10,
  "animations": {
    "wave": {
      "file": "sprites/wave.webp",
      "frameWidth": 512,
      "frameHeight": 512,
      "frames": 8,
      "columns": 4,
      "fps": 12,
      "loop": false,
      "frameDurations": [90, 110, 140, 220, 220, 140, 110, 90]
    }
  },
  "actions": {
    "wave": {
      "label": {
        "zh-CN": "挥手问候",
        "en-US": "Wave hello"
      },
      "animation": "wave",
      "priority": 30,
      "cooldownMs": 10000,
      "interruptible": true,
      "dialogue": {
        "chance": 1,
        "delayMs": 100,
        "durationMs": 2200,
        "anchor": { "x": 350, "y": 166 },
        "lines": [
          {
            "text": { "zh-CN": "你回来了。", "en-US": "Welcome back." },
            "weight": 2
          }
        ]
      }
    }
  },
  "triggers": [
    {
      "id": "manual-wave",
      "type": "manual",
      "action": "wave",
      "label": { "zh-CN": "向她问候", "en-US": "Say hello" },
      "group": { "zh-CN": "日常作息", "en-US": "Routine" },
      "order": 10,
      "enterPet": true
    }
  ]
}
```

模块动画文件路径相对当前 `module.json` 所在目录。模块局部动画和 action id 会自动加上 `<module-id>/` 命名空间。

Action 的 `animation`：

- 写 `wave` 表示引用同一模块声明的局部动画。
- 写 `@model/pet-wave` 表示引用顶层模型动画。
- 不允许引用另一个模块的局部动画。
- action 至少包含 `animation` 或 `dialogue` 之一。

`priority` 范围为 0–99，只在同一来源档位内排序；来源总体优先级由运行时控制。`cooldownMs` 为非负定时器值。`interruptible` 默认 `true`。

## 对白

`dialogue.lines` 为 1–32 项。每项可以直接是字符串/本地化表，也可以是 `{ "text": ..., "weight": 1 }`。本地化表最多 16 个 locale，每段文本最长 240 字符。

- `chance`：`(0, 1]`，默认 1
- `delayMs`：非负，默认 0
- `durationMs`：正数，默认 2200
- `anchor`：可选，必须在画布内
- `weight`：正数；所有权重之和必须有限

频繁被动 action 应降低 `chance`，避免每次都说话。对白与按键气泡使用不同槽位，动作被打断、模型切换或销毁时必须由现有运行时清理。

## Trigger 类型

所有 trigger 的 `id` 在模块内唯一，`action` 只能引用同模块 action。

| 类型                | 必填字段                                         | 关键规则与用途                                                            |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `manual`            | `action`, `label`                                | 主动二级菜单；可选 `group`, `order`, `enterPet`                           |
| `pointer`           | `action`, `event`, `area`                        | `event` 为 `hover`/`tap`/`stroke`；area 必须存在于顶层 hitAreas           |
| `interval`          | `delayMs`, `choices`                             | pet-idle 中按 `[min,max]` 抽取完整间隔；choice action 不重复且 weight > 0 |
| `idle`              | `afterMs`, `action`                              | 默认 once-per-idle；循环时设置 `oncePerIdle:false` 并提供 `repeatMs`      |
| `schedule`          | `action`, `time`                                 | 本地 `HH:mm`；可选 `dates`, `weekdays`, `catchUpMs`, `enterPet`           |
| `session`           | `action`, `event:"startup"`                      | 可选启动随机 `delayMs`、`catchUpMs`, `enterPet`                           |
| `visibility-return` | `action`, `minAwayMs`                            | `maxAwayMs` 若存在必须大于 min；可选 settle/catch-up                      |
| `activity-burst`    | `action`, `windowMs`, `minimumEvents`, `quietMs` | quiet < window；sources 可选 keyboard/mouse/gamepad                       |
| `active-session`    | `action`, `afterMs`, `resetAfterMs`              | quiet < reset；可选 repeat、sources、catch-up                             |
| `daily-window`      | `action`, `startTime`, `endTime`                 | 两端不能相同，允许跨午夜；可选 dates/weekdays/catch-up                    |

`weekdays` 使用 1–7 表示周一到周日。`dates` 使用 `YYYY-MM-DD` 或 `*-MM-DD`。所有时刻是用户本地时间。`schedule` 和 `daily-window` 的 `catchUpMs` 可为 0；由 `setTimeout` 直接派发的 session/return/activity/active-session 显式 catch-up 至少为 1000ms。

Pointer 约束：

- `hover` 可使用 `holdMs`，不能使用 `distance` 或 `windowMs`
- `stroke` 可使用 `distance`/`windowMs`，不能使用 `holdMs`
- `tap` 的 `distance` 最大为 6；同时提供 `holdMs` 和 `windowMs` 时必须 `holdMs < windowMs`

## 菜单契约

菜单完全由运行时 catalog 生成：

- 主动动作是“主动动作 → action”，group 只用于分段，不再增加一级菜单。
- 被动动作是“被动动作 → trigger 类型 → action”。
- passive 菜单项用于用户预览/主动触发对应 action，不会伪造被动 occurrence。
- action 冷却或运行状态不应永久禁用菜单；菜单每次打开会根据当前状态重建。

每个希望用户主动执行的 action 都需要 `manual` trigger。每个被动 action 至少需要一个非 manual trigger，才能出现在被动目录并自动运行。

## 安全与规模边界

- `model.json` 最大 1 MiB；单个 `module.json` 最大 256 KiB。
- 最多 64 个 module；单模块最多 128 animation、128 action、256 trigger。
- 合并后模块 action 最多 512，trigger 最多 256。
- 模型合并后最多 96 个 animation。
- 单张 sheet 最大 16 MiP，全部 sheet 最大 64 MiP。
- 所有 id 最长 80，须匹配小写/数字开头的安全 id 规则；避免 `__proto__`、`prototype`、`constructor`。
- 路径最长 512，只允许模型内安全相对路径；禁止 scheme、绝对路径、空段、`.`、`..` 和符号链接越界。
- 模组只能包含数据和本地资源，不能包含可执行脚本或表达式 DSL。
