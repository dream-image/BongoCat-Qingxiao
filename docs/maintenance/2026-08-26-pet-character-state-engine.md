# 宠物人物状态引擎施工记录

- 创建时间：2026-08-26 16:21:58 CST（Asia/Shanghai）
- 最近更新：2026-08-26 18:12:53 CST（Asia/Shanghai）
- 工作分支：`codex/pet-behavior-hardening`
- 当前状态：Wave 6 已完成；待真实应用手工验收
- 大体内容：把现有“工作/进入/待机/动作/退出”播放阶段与人物语义状态分离；让模型根据时间、空闲、输入、情绪和形态选择不同的循环常态动画；临时动作完成后按动作效果更新或保留人物状态，再回到最新状态对应的常态动画。

## 执行状态

| Wave | 内容                                              | 状态   | 验证                                                                             |
| ---- | ------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| 0    | 固化施工文档、当前约束和验证命令                  | 已完成 | 4 项 WEM 测试、类型检查、27 动画模型校验通过                                     |
| 1    | 现有宠物生命周期回归测试与可控测试夹具            | 已完成 | 5 项行为测试与 4 项 WEM 测试通过                                                 |
| 2    | 纯人物状态核心、配置类型和严格校验                | 已完成 | 5 项状态解析测试，14 项总测试及类型检查通过                                      |
| 3    | 动态常态动画、动作状态效果和播放生命周期接入      | 已完成 | 8 项行为测试，17 项总测试及类型检查通过                                          |
| 4    | 时间/空闲规则与清宵状态配置、常态资源             | 已完成 | 36 动画模型校验、8 张新 sheet 结构与视觉 QA 通过                                 |
| 5    | Skill、README、维护文档和完整构建验证             | 已完成 | 17 项测试、ESLint、类型检查、Vite 构建和模型校验通过；真实应用定时场景待手工验收 |
| 6    | 战斗/心魔形态眨眼修复、全动作变体和运行时动作选图 | 已完成 | 66 动画模型预检、18 项测试、ESLint、类型检查、Vite 构建与 diff 检查通过          |

状态只能在相应代码和验证真正完成后改为“已完成”。如果实现和本记录的接口设计发生偏差，必须先在“施工变更记录”解释原因，再更新对应设计，不能让文档继续描述已经不存在的行为。

## 当前实现与问题

当前 `PetBehaviorState` 实际表示的是播放阶段：`work-idle`、`pet-entering`、`pet-idle`、`pet-action`、`pet-interaction`、`pet-exiting`。它不能表达“困倦、午睡、深夜睡眠、傲娇、开心、战斗形态、心魔形态”等人物语义。

`behaviors.pet.idleAnimation` 只有一个；动作播放时也会把这个固定动画传为 `returnTo`。因此临时动作结束后只能回到 `pet-idle`，无法回到动作开始前或动作结束时最新的人物状态，也可能在控制器接管前短暂显示旧待机帧。

现有 trigger、优先级、冷却、输入门禁、菜单快照、被动 occurrence 队列和 playback generation 已处理了大量边界。本轮不得另建一套动作调度器；新状态核心只负责语义状态、状态有效期和常态动画解析，动作何时执行仍由 `PetBehaviorController` 仲裁。

## 目标架构

```text
时间 / 输入 / 空闲 / 指针 / 会话事实
                    │
                    ▼
             人物状态解析器
       scene + activity + mood + form
                    │
                    ▼
             Visual Profile
                    │
          ┌─────────┴─────────┐
          │                   │
     循环常态动画         临时动作请求
                              │
                              ▼
                        一次性动作播放
                              │
                 ┌────────────┴────────────┐
                 │                         │
            不影响状态                成功后影响状态
                 │                         │
                 └────────────┬────────────┘
                              ▼
                  按最新人物状态重新解析常态
```

### 播放阶段

把当前类型重命名为 `PetRuntimePhase`，只表达引擎正在做什么：

- `work`
- `entering`
- `steady`
- `action`
- `interaction`
- `transition`
- `exiting`

### 人物状态

状态维度由模型声明，运行时不硬编码清宵：

```ts
interface PetCharacterStateSnapshot {
  scene: 'work' | 'pet'
  values: Readonly<Record<string, string>>
  revision: number
  changedAt: number
}
```

清宵第一版声明：

- `activity`：`awake`、`relaxed`、`drowsy`、`napping`、`sleeping`
- `mood`：`calm`、`happy`、`shy`、`annoyed`、`concerned`
- `form`：`normal`、`attack`、`demon`

每个状态 Assignment 带来源、优先级和生命周期。第一版生命周期只支持当前会话、固定持续时间和直到下一次用户输入，不加入跨重启永久情绪。

### Visual Profile

Profile 以显式优先级匹配 `scene` 和部分状态维度，并引用一个循环动画。模型必须声明兜底 Profile；不存在精确组合时按优先级回退，不要求为每个状态笛卡尔积制作资源。

### 动作状态效果

action 增加可选 `stateEffect`：

- `when: "started"`：动作真正启动后立即提交，适用于已经发生且不能因动画被打断而回滚的语义。
- `when: "finished"`：默认值，仅播放正常完成时提交。
- 没有 `stateEffect`：临时动作，不修改人物状态。

被 `interrupted` 或 `destroyed` 的动作不得提交 `finished` 效果。动作结束时不能恢复保存的旧动画，而要使用最新 `stateRevision`、时间和输入事实重新解析 Profile。

## 文件改动计划

### Wave 1：回归测试

- 新增 `src/utils/pet-behavior.test.ts`。
- 增加可控单调时钟/墙钟、记录型播放驱动和最小模型 Fixture。
- 修改 `package.json`，让测试命令覆盖全部 `src/utils/*.test.ts`。
- 锁定首次主动点击、生命周期打断、被动门禁、输入不可用、菜单恢复、模型切换代次等既有行为。

### Wave 2：状态核心和配置契约

- 新增 `src/utils/pet-character-state.ts` 和对应测试。
- 在 `src/utils/pet-behavior.ts` 增加顶层 `stateMachine` 配置类型。
- 在 `src/utils/pet-behavior-module.ts` 增加 action `stateEffect` 类型、规范化、命名空间和严格校验。
- 给维度、值、Profile、规则和定时值设置有界总量。
- 未配置状态机的旧模型自动映射为 `scene=work → defaultAnimation`、`scene=pet → idleAnimation`。

### Wave 3：运行时接入

- 将旧 `PetBehaviorState` 内部语义改为 `PetRuntimePhase`。
- `PetBehaviorController` 持有纯状态核心，但继续独占动作仲裁和被动队列。
- `sprite.ts` 支持一次性动画完成后 `hold` 最后一帧，由控制器原子启动最新 Profile 的循环动画。
- 对话-only action 保持当前 Profile，不再重播固定 `pet-idle`。
- 模型切换、销毁、输入打断、主动重复点击继续使用现有 generation 作废旧 continuation。

### Wave 4：状态规则和清宵迁移

- 状态规则第一版只支持 `scene`、`idleForMs`、本地时间窗口、星期和日期。
- 状态规则只计算 Assignment 和下一次重新解析时间，不创建第二套动作队列。
- 清宵接入工作清醒、宠物清醒、放松、困倦、午休、深夜睡眠、开心、傲娇、担心、战斗和心魔状态。
- 新增必要的循环常态资源：放松、困倦、午休、深夜睡眠、傲娇、战斗形态、心魔形态。
- 所有新增资源继续使用 canonical-first，人物、古琴、常驻飘带、位置、尺寸、材质和透明边缘必须稳定。

### Wave 5：交付

- 更新两个项目内置 Skill 的状态机配置、资源生产和验证说明。
- 更新 README、AI Skill 指南和清宵维护记录。
- 运行 lint、typecheck、build、完整模型校验、WEM 测试和真实应用场景复验。

## 清宵首批状态规则

| 状态     | 进入条件                      | 离开条件                       |
| -------- | ----------------------------- | ------------------------------ |
| 工作清醒 | 存在键盘/手柄活动输入         | 最后输入释放并达到宠物激活延时 |
| 宠物清醒 | 普通进入宠物态或主动动作      | 输入恢复或更长空闲阈值成立     |
| 放松     | 宠物态空闲 2 分钟             | 输入、动作效果或更长空闲阈值   |
| 困倦     | 宠物态空闲 10 分钟            | 输入、午休或深夜睡眠           |
| 午休     | 12:00–13:30 且空闲至少 3 分钟 | 输入或午休窗口结束             |
| 深夜睡眠 | 23:00–06:30 且空闲至少 5 分钟 | 输入或深夜窗口结束             |
| 开心     | 抚摸、陪伴、挥手等成功动作    | 2 分钟到期或更高优先级状态     |
| 傲娇     | 轻哼、连续打扰等成功动作      | 90 秒到期或安抚动作            |
| 担心     | 连续工作提醒成功执行          | 5 分钟到期或用户休息           |
| 战斗形态 | 战斗化形成功完成              | 明确恢复普通形态或切换形态     |
| 心魔形态 | 心魔化形成功完成              | 明确恢复普通形态或切换形态     |

节日问候、剑气凝心、云珠、滑奏、挥手、久别归来等保留为临时动作，不升级为长期人物状态。

## 完成标准

- 旧 Sprite 模型不修改配置仍保持原行为。
- 动作无状态效果时回到最新状态对应的常态动画。
- 动作成功效果、启动效果、打断和销毁分别符合契约。
- 时间窗口或状态在动作播放中变化时，不会被旧完成回调回滚。
- 午休和深夜睡眠能进入不同常态，输入能够从任意状态可靠恢复工作态。
- 切换常态时不闪现旧 `pet-idle`，人物位置和尺寸不跳变。
- 战斗/心魔形态的眨眼、临时动作和形态切换都使用对应形态完整雪碧图，不闪回普通人物。
- 右键菜单和设置页仍然第一次点击生效，输入监听不可用时主动动作仍可用。
- 清宵完整模型、所有雪碧表、音频引用、TypeScript、Vite 构建和项目测试全部通过。

## 验证命令

```bash
pnpm test
pnpm exec eslint src
pnpm exec tsc --noEmit
pnpm build

BONGOCAT_PYTHON="<load_workspace_dependencies 返回的 python3>"
"$BONGOCAT_PYTHON" \
  .agents/skills/author-bongocat-action-modules/scripts/validate_model_package.py \
  src-tauri/assets/models/qingxiao
```

## 施工变更记录

### 2026-08-26 16:21:58 CST

- 创建本施工记录。
- 确认当前工作树干净，分支与 `fork/codex/pet-behavior-hardening` 同步。
- Wave 0 开始：下一步先运行当前测试、类型检查和模型校验，记录未改代码前的基线。

### 2026-08-26 16:27:04 CST

- Wave 0 完成：`pnpm test` 的 4 项 WEM 测试和 `pnpm exec tsc --noEmit` 通过。
- 清宵模型基线校验通过：27 个 animation、39 个 module action、39 个 module trigger、7 个本地 audio、`69,730,304` 个雪碧像素，零错误、零警告。
- Wave 1 开始：增加不依赖真实浏览器计时的宠物行为回归测试。

### 2026-08-26 16:36:20 CST

- Wave 1 完成：新增 `FakeClock`、`RecordingPlaybackDriver` 和 5 项行为回归测试；加上原有 WEM 测试共 9 项全部通过。
- 回归覆盖激活/退出生命周期、第一次主动点击、输入监听不可用、进入/动作/退出三阶段主动抢占和切模型后旧 completion 失效。
- `package.json` 的测试入口改为发现全部 `src/utils/*.test.ts`，为后续状态核心测试提供统一入口。
- Wave 2 开始：新增与 Canvas、Tauri 和 Pinia 解耦的人物状态解析器。

### 2026-08-26 16:37:14 CST

- Wave 2 完成：新增人物状态维度、规则、Visual Profile、动作效果和三种生命周期的配置契约及严格校验。
- 状态解析器测试覆盖规则优先级、跨午夜窗口、定时效果到期、直到输入清除和最近重新计算时间；14 项总测试与 TypeScript 类型检查通过。
- Wave 3 开始：让 Sprite 一次性动作由控制器决定完成后的常态，避免底层先回固定 `pet-idle` 再切换造成闪帧。

### 2026-08-26 16:44:12 CST

- Wave 3 完成：`PetBehaviorState` 保留为兼容别名，新增 `PetRuntimePhase` 明确它只表示播放阶段，避免无收益地迁移现有设置页调用方和事件值。
- Sprite 增加一次性播放 `hold` 语义；动作开始/完成效果、动态 Profile、状态截止时间和输入清除已接入原控制器，没有新增第二套动作队列。
- 新增 3 项集成回归，确认完成效果不闪旧 idle、无效果动作回最新状态常态、duration 到期自动恢复；17 项总测试和类型检查通过。
- Wave 4 开始：已按项目 Skill 重新读取动作模块契约、Sprite 模型契约和生产/视觉 QA 规范，下一步从清宵现有 canonical 与动作 donor 生成稳定循环常态。

### 2026-08-26 17:04:59 CST

- Wave 4 完成：清宵配置 `activity`、`mood`、`form` 三个维度，接入两分钟放松、十分钟困倦、午休和跨午夜深夜睡眠规则，并为摸头、问候、傲娇、提醒和两种化形配置完成效果。
- 新增困倦、午休、深夜睡眠、开心、傲娇、担心、战斗形态和心魔形态 8 张循环 sheet；放松复用 `pet-idle.webp` 并使用更慢的独立时间线，避免复制完全相同的像素文件。此处的战斗形态在当时配置中仍沿用了旧的颜色型命名，Wave 6 已完成语义迁移。
- `scripts/build_qingxiao_state_idles.py` 可重复从既有验收动作 donor 重建资源；8 张 sheet 均为 512px cell、边缘 alpha 0、隐藏 RGB 0，人物/古琴/飘带不做逐帧缩放或外部叠加。定量结果保存于 `2026-08-26-qingxiao-state-idles-qa.json`。
- 包校验器已扩展人物状态机和 action 状态效果校验。清宵当时包含 36 个 animation、39 个 module action、39 个 module trigger、7 个 audio、91,750,400 累计像素，零错误、零警告。
- Wave 5 开始：两个项目 Skill、契约参考、README、AI Skill 指南和清宵维护记录已同步，下一步运行全部工程检查并收口本记录。

### 2026-08-26 17:11:30 CST

- Wave 5 完成：两个项目 Skill、模型契约、README、AI Skill 指南和清宵维护记录均已同步到实际实现。
- `pnpm test` 共 17 项测试通过；`pnpm exec eslint`、`pnpm exec tsc --noEmit`、`pnpm build`、清宵完整模型校验和 `git diff --check` 全部通过。Vite 仅保留项目原有的大 chunk 提示，不影响构建产物。
- 8 张新增状态 sheet 再生成后的 SHA-256 与首次产物一致，确认生产脚本可重复；结构 QA 和人工 contact sheet 检查均未发现透明边缘、人物尺寸、位置或常驻飘带跳变。
- 代码施工至此结束。跨 12:00 午休、23:00 深夜睡眠、真实系统输入唤醒和右键动作后状态衔接尚未在打包应用中等待真实时间手工观察，因此整体状态保留为“待真实应用场景手工验收”，不把自动化时钟测试表述成实机验收。

### 2026-08-26 17:26:37 CST

- 轻量评审发现战斗、心魔均为 `session` 形态，但菜单缺少恢复 `normal` 的闭环入口。
- 新增“恢复常态”主动动作和二级菜单项，完成后显式设置 `form=normal`。该动作最初使用 800ms 短对白承载反馈；Wave 6 已补为按当前形态选取的完整恢复过渡动画。
- 当前清宵模型包含 36 个 animation、40 个 module action、40 个 module trigger、7 个 audio；模型预检零错误、零警告，17 项项目测试和 `git diff --check` 通过。

### 2026-08-26 17:40:34 CST

- Wave 6 开始：用户确认原先按素材颜色命名的形态实际语义为攻击/战斗形态，并要求化形后所有宠物动作保持当前形态，不能播放普通形态雪碧图。
- 已确认眨眼颜色错误来自 `build_qingxiao_state_idles.py`：攻击/心魔常态的闭眼帧直接移植了普通 `pet-idle` 的眼部像素。
- 本阶段把 `form=white` 迁移为 `form=attack`，文案统一改为“战斗化形/战斗形态”；运行时增加 action 的状态匹配动画变体。两种形态的动作表从各自完整 canonical 重建为独立 sheet，普通形态动作只作为姿势 donor，不在播放时叠加第二层人物或飘带。
- 计划范围扩展为 12 套普通宠物动作的攻击/心魔双形态版本，以及普通、战斗、心魔三种形态之间的专属过渡动画；先修复两种形态的闭眼 donor，再接入配置和完整校验。

### 2026-08-26 17:54:37 CST

- 已从战斗、心魔完整 canonical 分别生成闭眼 donor；正式表只消费固定眼部 ROI，图像模型对头发、身体、古琴或飘带的其他重绘不会进入成品。
- `scripts/build_qingxiao_form_action_variants.py` 已生成两张形态常态、12 套动作的战斗/心魔双版本和 8 张三形态专属过渡表；每帧从完整形态 canonical 出发烘焙成单张 RGBA，不在运行时叠加普通人物或独立飘带。
- 攻击/心魔动作总览已人工检查初版：人物位置、尺寸、古琴和常驻飘带稳定；下一步接入 action 状态动画变体并用自动化测试锁定实际选图。

### 2026-08-26 18:09:47 CST

- `PetRuntimeAction`、顶层 pointer interaction 和兼容 autonomous action 已支持 `stateAnimations`。动作启动时先读取当前状态，按 priority、匹配维度数量和配置顺序选取非循环动画；选图发生在 `stateEffect` 之前，化形动作可以按来源形态播放正确过渡。
- 清宵 `form` 已迁移为 `normal / attack / demon`；菜单和对白统一使用“战斗化形/战斗形态”。40 个模块 action 与 5 个顶层 pointer interaction 全部配置战斗/心魔变体；恢复常态也按来源形态播放独立过渡。
- 战斗和心魔专属闭眼 donor 已保存到模型 `references`，生产脚本不再依赖临时 artifacts。旧状态脚本不再写化形常态，避免普通眼部像素以后重新覆盖成品。
- 18 项项目测试、相关 ESLint、TypeScript 类型检查通过；新增集成测试锁定普通→战斗过渡、战斗常态、战斗动作、回到战斗常态和同形态强调动作。模型预检为 66 个 animation、40 个 module action、40 个 module trigger、7 个 audio、181,927,936 累计像素，零错误、零警告。

### 2026-08-26 18:12:53 CST

- Wave 6 完成：`pnpm exec eslint src`、`pnpm exec tsc --noEmit`、18 项 `pnpm test`、`pnpm build` 和 `git diff --check` 全部通过；Vite 只保留项目原有的大 chunk 提示。
- 两份形态闭眼 donor 已进入模型 `references`，重新执行普通状态与形态动作生产脚本后结构 QA 和模型预检仍为零错误、零警告，证明正式资源不依赖临时工作目录。
- 自动化与静态验收已完成。真实打包应用中的战斗/心魔眨眼、40 个动作逐项点击、5 个指针交互和三形态连续切换仍需手工观察，因此不把自动化结果表述成实机视觉验收。
