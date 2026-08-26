# 清宵宠物动作模组维护记录

- 记录时间：2026-08-21 06:05:12 CST（Asia/Shanghai）
- 工作分支：`codex/pet-behavior-hardening`
- 大体内容：在既有按键模型之上增加可导入的宠物动作模组、主动右键菜单、独立对白气泡，以及启动问候、久别归来、输入爆发、连续工作、每日时段等可扩展被动触发器；清宵动作资源继续使用逐帧稳定性门禁。

> 2026-08-26 更新：清宵的正式雪碧图已经改为“人物、常驻飘带、表情和口型逐帧统一重画”，不再采用本文早期记录的局部程序合成路线。当前美术生产规则和复现命令以 [2026-08-26 清宵一体化雪碧图重画记录](./2026-08-26-qingxiao-integrated-sprite-redraw.md) 为准；本文后续有关 ROI、donor 和静态区拼接的内容只保留为历史设计记录。

## 本次实现

宠物能力不再继续堆进单一 `model.json` 数组。模型通过 `behaviors.pet.modules` 引用独立 `module.json`；加载阶段把模块内动画、动作和触发器转换成带模块命名空间的运行时对象，再交给同一个行为控制器仲裁。旧模型未配置 `modules` 时仍沿用原来的 `autonomous` 和 `interactions`。

核心文件职责：

- `src/utils/pet-behavior-module.ts`：读取、验证和规范化模块；处理命名空间、本地化、动画引用及数量边界。
- `src/utils/pet-behavior-scheduler.ts`：计算本地日期、星期、时间点和补偿窗口，不持有播放器状态。
- `src/utils/pet-behavior-passive.ts`：把会话、真实可见性和输入边沿转换为带代次、截止时间和去重键的 passive occurrence。
- `src/utils/pet-behavior.ts`：统一处理进入/退出、优先级、冷却、被动调度、手势、主动请求和对白生命周期。
- `src/utils/sprite.ts`：合并模块动画、限制资源预算、播放动作，并绘制独立对白气泡。
- `src/composables/usePetActionMenu.ts`：把可用的 `manual` 触发器转换为宠物右键二级菜单。
- `src/pages/main/index.vue`：只在宠物窗口装配菜单；托盘菜单不读取宠物运行时。
- `scripts/build_qingxiao_pet_sprites.py`：旧版局部程序合成器，仅能显式传入 `--legacy-procedural` 做历史排查；不得再用于覆盖当前正式重画资源。
- `scripts/process_generated_sprite_sheet.py`：从统一重画的源图中提取真实前景、清理临时背景，并输出透明雪碧图及深浅底 QA 图。
- `scripts/finalize_qingxiao_redraw.py`：统一完整人物帧的动作端点、画布规格和模型封面，保证动作切换不闪回旧姿势。

## 模组契约

一个模块由 `version`、`id`、`displayName`、`actions` 和 `triggers` 组成；只有包含本地雪碧资源时才需要可选的 `animations`。模块内的本地标识会自动转换为 `moduleId/localId`，所以不同模块可以安全复用相同局部名称。

- 本地动画引用写局部名称；复用顶层模型动画写 `@model/<animation>`。
- action 至少包含 animation 或 dialogue 之一，可同时包含两者。
- action 的 cooldown 只在真正开始执行时写入；失效或被拒绝的请求不消耗冷却。
- dialogue 是独立单槽，不进入按键气泡队列；延迟显示受 playback generation 保护，切模型或按键打断后不会冒出旧台词。
- 模块源、动画文件和引用必须存在且位于模型 canonical 根目录内；任一模块错误会让整个模型 fail-fast，不能静默跳过半个模块。

目前支持的触发器：

- `manual`：出现在宠物右键二级菜单，可从工作形态先进入宠物形态再执行。
- `pointer`：绑定已声明 hit area 的 hover、tap 或 stroke。
- `interval`：只在 `pet-idle` 开始完整计时，动作完成后重新抽取完整间隔。
- `idle`：从本轮最后一个已追踪输入释放后累计，按 idle epoch 去重。
- `schedule`：按本地 wall clock 的日期、星期和 `HH:mm` 运行；同一分钟的多个 occurrence 会立即记录进优先队列，不会因前一个长动作越过 catch-up 窗口而丢失。
- `session`：以应用会话为基准触发一次启动问候；切模型不会伪造新会话，且每个模型 scope 独立去重。
- `visibility-return`：只使用真实 Tauri 窗口可见性与 `document.visibilityState` 的边沿计算离开时长；hover 隐藏、resize、focus 和右键菜单都不会伪造“回来”。`maxAwayMs` 为排他上界，相邻区间不会双触发。
- `activity-burst`：统计键盘首次 down、鼠标按键 down、按 400ms/24px 节流后的鼠标移动 pulse、手柄按键或摇杆 neutral→active 上升沿；自动重复和连续轴采样不计数。达到阈值后等待 quiet 且所有已追踪输入释放。
- `active-session`：用活动边沿维持连续工作 epoch；相邻事件间隔达到 `resetAfterMs` 就结束一轮，达到 `afterMs` 后在安静窗口提醒，可用 `repeatMs` 实现长时工作的后续提醒。
- `daily-window`：按本地日期与星期在一个时段内固定抽样一次到期时刻，支持跨午夜窗口；窗口末尾预留一分钟扫描容错，一分钟窗口固定从起点触发；同一运行期内的模型 scope/日期/触发器只消费一次，不承诺跨进程持久去重。

`schedule` 和 `daily-window` 都对本地时刻做年/月/日/时/分 round-trip 校验。夏令时向前跳跃造成的不存在时刻当天直接跳过，不允许 JavaScript `Date` 把它静默平移到另一个钟点；秋季重复时刻采用 JavaScript `Date` 的较早 occurrence，但去重 key 仍保证当天只消费一次。跨午夜 `daily-window` 归属于窗口开始所在的本地日期。

`session`、`visibility-return`、`activity-burst`、`active-session` 由 `setTimeout` 直接派发，显式 `catchUpMs` 最少为 1000ms，用来覆盖事件循环对理论 dueAt 的正常微小延迟；`schedule` 和 `daily-window` 的 wall-clock 扫描仍允许配置为 0。

被动引擎不记录按键内容、文本或鼠标坐标，只保留来源、物理输入标识和单调时间戳。摇杆用双阈值滞回识别 neutral/active，避免硬件回中噪声让宠物永久认为用户仍在操作。

## 仲裁与生命周期

键盘/已追踪手柄输入和系统退出永远高于宠物动作。其余来源依次为 manual、pointer、active-session、schedule、visibility-return、session、activity-burst、daily-window、idle、interval，每档间隔 100，再叠加 action 自身 0…99 的 priority，模型局部值不会反转来源优先级。

- 进入和退出动画不可被普通动作抢占。
- 工作形态最多保存一个待执行主动请求；进入完成后重新按优先级选择。
- 当前动作只有在声明为 interruptible 且新请求优先级更高时才会被抢占。
- 手动/指针即时请求使用一个 pending 槽；已发现的 schedule 和其他被动 occurrence 进入独立的 256 项有界优先队列，不会被后来的单槽请求覆盖。同一 trigger 只保留最新一次尚未执行的 occurrence。
- `catchUpMs` 只决定一个 occurrence 能否在半开区间 `[dueAt, expiresAt)` 内被及时发现；已在窗口内入队的事件可以等前一个长动作完成，不会在队列中被二次过期。
- 打开原生右键菜单会冻结 activation、interval/idle 和新被动引擎的单调计时，关闭后恢复剩余时间；wall-clock `schedule`/`daily-window` 不平移现实时间，只在关闭时仍位于 catch-up/window 内才补发现。
- 监听不可用、渲染未就绪、窗口或 WebView 实际不可见、仍有已追踪键盘/手柄输入时，控制器不会进入宠物形态。鼠标拖拽/长按不禁用主动 pointer 交互，也不暂停已经开始的动画；它只阻止新的被动动作启动，并在释放后从新的 idle/interval 周期继续。

## 右键菜单资源所有权

宠物窗口每次右键都根据当前 locale、cooldown 和运行状态重新生成菜单。整棵瞬时菜单使用带稳定 id 的 raw options，只创建一个 root `Menu` Resource；`popup()` 结束后由 `finally` 关闭 root。不要提前用 `MenuItem.new()` 构造子项，否则关闭 root 不会释放这些独立 Resource。

菜单 action 回调只记录所选 action；原生菜单关闭、session 解冻后才真正提交，避免菜单打开期间的 hover、自动动作和点击动作互相抢占。

方向键和回车通过原生菜单导航时，全局输入 hook 仍只记录物理 held 状态，不显示按键贴图/气泡、不播放工作动画、也不作废菜单 revision。若选择回调早于 keyup 且仍在工作形态，manual 请求留在单槽，最后一个导航键释放后立即进入，不重等 `activationDelayMs`；已经处于宠物态时按正常抢占/排队规则执行，最后 keyup 负责恢复被动计时。

## 清宵当前动作

顶层生命周期与基础动作：`pet-enter`、`pet-idle`、`pet-exit`、`pet-doze`、`pet-dream`、`pet-chime`、`pet-curious`、`pet-content`。

可插拔模块：

- `modules/lively`：17 个 action / 17 个 trigger；除惊醒、凝云珠、流泉扫弦、眨眼挥手和节日问候外，还包含启动问候、6小时/三日级别的久别回归、快速键盘与手柄输入回应、工作日/周末早晨窗口。
- `modules/tsundere`：9 个 action / 9 个 trigger；包含短时离开后的傲娇回应、连续点击或晃动鼠标的反应、50 分钟工作提醒、五分钟 idle，以及工作日下午和跨午夜深夜窗口。
- `modules/routine`：12 个 action / 11 个 trigger；复用基础摸头、弹琴、休息、梦境与白色化形，并按 45 秒、10 分钟、20 分钟和深度 idle 分阶段进入好奇/打盹/梦境，另有午间休息与晚间琴音窗口。

三份外部 module.json 共 38 个 action / 37 个 trigger；顶层 5 个兼容 interactions 会再规范化成一个不可由外部命名的内部模块。统一运行时 catalog 因此为 26 个 animation、4 个 module、43 个 action、42 个 trigger；其中新被动类型为 session 1、visibility-return 3、activity-burst 3、active-session 1、daily-window 7。自动对白保持较低几率或长冷却，避免和分阶段 idle/周期动作叠加成高频打扰。

动作雪碧图始终从 `sprites/idle.webp` frame 0 的 512×512 production canonical 重组。眼睛、左右手/袖和程序特效分别使用固定 ROI；动作区之外必须逐像素等于 canonical。特效按当前 pose alpha 保护，不能只保护待机轮廓。

14 个宠物动作均满足静态区 RGBA 差异为 0、特效与当前人物不重叠、透明区 hidden RGB 为 0、边缘 alpha 为 0。除生命周期三项外，普通动作首尾回宠物 canonical，并按各自动作配置验证往返对称；`pet-enter`/`pet-exit` 负责连接工作态与宠物态 canonical，`pet-idle` 按无缝循环契约验证。四张返修动作还额外验证了双手存在性、单手连通分量和逐帧真实姿势变化。

## 资源与导入边界

- 模型 manifest 最大 1 MiB；单个 module manifest 最大 256 KiB。
- 单模组最多 128 个 action / 256 个 trigger；外部模块由 loader 完整校验，和顶层兼容行为合并时只补充检查整个模型 512 个 action / 256 个 trigger 的总预算及跨模组指针冲突。
- 模型最多 96 个动画；单张雪碧图最多 16 MiP；模型累计最多 64 MiP；图片最多四路并发加载。
- 图片在创建 `HTMLImageElement` 前先有界读取文件头并占用像素预算，解码后再次核对实际尺寸。
- 模型切换通过 generation 停止旧模块读取并主动取消旧图片加载。
- 模型加载错误同时写入持久日志；窗口 resize 优先等待下一帧，但锁屏或隐藏 WebView 暂停 rAF 时使用 100ms 兜底，避免 `modelReady` 永久停在 false。
- Rust 对 model/module/animation 文件做 canonical 根目录检查；导入过程拒绝符号链接和特殊文件，失败只回滚本次原子创建的目标目录。

## 后续增加模组

1. 在模型目录新建 `modules/<module-id>/module.json` 和本地 `sprites/`。
2. 在模块中声明 animations、actions 和 triggers；优先复用 `@model` 动画，避免重复解码同一视觉资源。
3. 在顶层 `behaviors.pet.modules` 增加 source；不要在 TypeScript 或右键菜单中硬编码角色 action id。
4. 新动作必须使用不可变 canonical 逐帧重组，并执行角色静态区、动作走廊、特效遮挡、裁切、无损解码和肉眼动态检查。
5. 运行前端 ESLint/TypeScript/Vite、Rust fmt/check、模型加载校验和实际 bundle 资源哈希比对。

不要把模型自定义逻辑写成可执行脚本或表达式 DSL；模块只能提供数据，所有调度和仲裁必须经过共享控制器。

## 2026-08-21 12:08 CST：睁眼常态与动作节奏修订

工作态与宠物态的 canonical 都改为双眼睁开。工作态 `idle` 周期为 4575ms，其中闭眼只占一次 155ms 眨眼；`pet-idle` 扩为 12 帧/4260ms，其中只在第 10 帧闭眼 80ms。按键动画 `pluck-01`…`pluck-10` 本身始终睁眼，继续保留即时反馈速度；此前“按键时大部分闭眼”的观感来自工作态待机长停留在闭眼帧，以及退出宠物态时继承了闭眼 canonical，本次已从源头修正。

宠物交互统一延长到 1.2–2.52 秒，并按动作复杂度扩为 8、12 或 16 帧。常规互动全程睁眼；只有 `pet-doze`/`pet-dream` 的睡眠中段、`pet-wink-wave` 的单眼眨眼和 `pet-hmph` 的 660ms 傲娇峰值允许语义性闭眼。所有动作首尾都回到睁眼 canonical，进入和退出不会再把闭眼状态带回工作动画。

手势动作只沿同一 donor 姿势族单向进入并严格镜像返回，峰值停留期间由法球、音符、星光、气云和挥手线继续推进。构建门现在同时检查包含 canonical 端点的绝对主手组件质心，以及相邻袖臂 alpha silhouette XOR；这两项分别防止端点跳帧和“质心接近但整条袖子瞬换”。最终 14 张雪碧图均通过逐帧眼态、静态区、特效遮挡、透明区、边缘、无损解码、对称和原速视觉验收。

扩帧后的 26 个动画累计为 65,536,000 像素（62.5 MiP），低于 67,108,864 像素的模型级上限；剩余 1,572,864 像素约等于 6 个 512×512 帧。后续增加动作应优先复用现有动画或空格，不得在未重新评估预算时继续扩表。

## 2026-08-22 00:41 CST：气泡反馈、字体与公开说明

键盘气泡新增 `bubbles.repeatInterval` 配置，清宵使用 320ms。首次按下立即显示，持续按住期间由 Sprite 自己的计时器稳定重复显示，松开、切换模型或销毁模型时统一停止；系统是否持续发送自动重复 `keydown` 不再影响表现。原生重复事件仍受同一时间戳门禁约束，不会与内部计时器叠加成高频刷屏。

中文按键气泡和动作对白优先使用 ZeoSeven 223 号“黄凯桦律师手写体”。字体通过远程 CSS 加载，没有把缺少可确认再分发授权的字体二进制写入仓库；网络不可用时按顺序回退到 macOS 行楷、系统楷体和通用手写字体。非中文内容继续使用原有圆体。

macOS 新款 Fn/地球键可能同时上报 `Function` 和 `Unknown(179)`。前端输入入口只在 macOS 忽略这个明确的伴生 `Unknown(179)` 事件，保留正常 `Function` 输入，避免同一次物理按键出现 `Fn` 与 `Unknown` 两组气泡。

README 已改为本 fork 的独立项目说明，并直接复用 `resources/cover.png` 展示清宵预览。文档明确标注本仓库来自开源项目 `ayangweb/BongoCat`，不是上游官方发行版，同时区分 MIT 代码许可证与角色形象、远程字体等第三方素材的授权边界。
