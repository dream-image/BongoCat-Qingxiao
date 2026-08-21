<!-- generated-by: gsd-doc-writer -->

# 宠物行为与输入链路加固交接记录

> 记录时间（北京时间）：2026-08-21 01:50:00 +08:00
> 目标分支：`codex/pet-behavior-hardening`
> 对比基线：`fork/codex/pet-interactions`（`8cda5196dd80b556d58c587bb4f771703f54c941`）
> 功能基线：`b0a47d290ac8fd2eb47d52c0d8472047376057d7`

## 大体内容

这轮改动为雪碧图模型增加了一套可选、配置驱动的宠物行为运行时，并系统加固了全局输入监听、按键状态、模型切换、手柄生命周期、实际渲染可见性、鼠标交互和 Sprite 播放调度。

核心结果如下：

- 宠物形态不再与具体模型代码耦合；模型以后可以通过 `model.json` 的 `behaviors.pet` 声明进入、待机、自主行为、退出以及鼠标交互。
- 后续提交已为内置模型 `src-tauri/assets/models/qingxiao/model.json` 配置 `behaviors.pet` 和三个外部动作模组；当前实现详见 `2026-08-21-qingxiao-pet-action-modules.md`。
- 原始物理输入身份 `inputId` 与当前模型使用的渲染键 `renderKey` 已分离。模型切换只暂停旧模型的视觉响应，不再伪造按键释放；新模型就绪后会重映射仍然按住的输入。
- 键盘和手柄共享行为门禁，但使用不同来源的物理身份。手柄使用 `Gamepad:<name>`，避免与同名键盘键碰撞。
- 宠物行为只有在输入监听可用、模型渲染完成、窗口实际可见，并且没有仍按住的键盘键或已追踪的手柄按钮/摇杆按键时才允许进入。
- macOS 的 `rdev` 已改为仓库内本地依赖，修复了 Core Graphics 回调 ABI、跨线程回调约束、event tap 失效恢复、资源清理竞态和左右修饰键状态判断。
- Sprite 播放现在提供可等待的结束结果、打断语义、返回动画、真实逐帧时长、按压态恢复以及按键气泡的统一调度。

## 详细描述

### 1. 改动边界与提交历史

本记录描述 `fork/codex/pet-interactions...codex/pet-behavior-hardening` 范围内的功能变化。功能基线包含以下提交：

| 提交      | 日期       | 内容                                                             |
| --------- | ---------- | ---------------------------------------------------------------- |
| `45ec3ca` | 2026-08-20 | 增加可扩展宠物行为运行时、指针交互、Sprite 播放契约和本地 `rdev` |
| `88e9eb6` | 2026-08-20 | F-01：修复 macOS Core Graphics 回调 ABI                          |
| `01a7244` | 2026-08-20 | F-02：收紧 macOS 回调的 `Send` 契约                              |
| `8622beb` | 2026-08-20 | F-03：监听失败检测、状态上报与有界自动恢复                       |
| `461f7c9` | 2026-08-20 | F-04：输入持续按住时禁止激活宠物形态                             |
| `961f81b` | 2026-08-20 | F-05：以渲染就绪和真实可见性作为行为门禁                         |
| `9cb3c51` | 2026-08-21 | F-06：串行化 macOS event tap 的提交与清理                        |
| `cb92b7d` | 2026-08-21 | F-08：独立判断 macOS 左右修饰键状态                              |
| `37c5aa0` | 2026-08-21 | F-07、F-09：保留物理输入会话并在模型切换后重映射                 |
| `b0a47d2` | 2026-08-21 | 组件卸载时释放手柄状态并停止监听                                 |

### 2. 总体架构与数据流

```text
键盘 / 鼠标
    ↓
vendor/rdev（操作系统全局事件）
    ↓
src-tauri/src/core/device.rs
    ├─ device-changed
    └─ device-listener-status
            ↓
src/composables/useDevice.ts
            ↓ 物理 inputId + 当前 renderKey
src/composables/useModel.ts
            ↓
src/utils/model-runtime.ts
    ├─ Live2D 适配
    ├─ src/utils/sprite.ts
    └─ src/utils/pet-behavior.ts

手柄 → Tauri gamepad-changed → useGamepad.ts ───────────┘
指针 → main/index.vue → usePetPointer.ts ───────────────┘
```

一次键盘输入的完整路径是：

1. 本地 `rdev` 把操作系统事件转换为 `Event`。
2. `src-tauri/src/core/device.rs` 把事件转换为 `DeviceEvent`，通过 `device-changed` 发给前端；监听生命周期通过 `device-listener-status` 单独上报。
3. `useDevice.ts` 以原始物理键码维护 `pressedKeyboardInputs`，只在模型就绪时计算当前 `renderKey`。
4. `useModel.ts` 更新 Live2D 的旧式覆盖图状态，并把统一输入传给 `modelRuntime`。
5. `model-runtime.ts` 负责输入身份、模型渲染映射、宠物退出和 Sprite 动画之间的顺序。
6. `sprite.ts` 播放绑定动画、维护按压态并绘制气泡；配置了宠物行为时，`PetBehaviorController` 决定何时进入或退出宠物状态。

### 3. 宠物行为框架

#### 3.1 配置入口

Sprite 模型可以在 `model.json` 中通过 `behaviors.pet` 提供 `PetBehaviorConfig`。配置由 `src/utils/sprite.ts` 读取，并由 `assertPetBehaviorConfig()` 在模型加载前验证。

主要字段：

| 字段                 | 作用                                    | 约束                                           |
| -------------------- | --------------------------------------- | ---------------------------------------------- |
| `activationDelayMs`  | 无输入后等待多久进入宠物形态            | 正数且不能超过浏览器定时器上限                 |
| `enterAnimation`     | 工作形态进入宠物形态                    | 必须存在且必须是非循环动画                     |
| `idleAnimation`      | 宠物待机                                | 必须存在且必须是循环动画                       |
| `exitAnimation`      | 宠物形态返回工作形态                    | 必须存在且必须是非循环动画                     |
| `autonomous.delayMs` | 两次自主行为之间的随机等待区间          | 必须恰好有最小值和最大值，且最小值不大于最大值 |
| `autonomous.actions` | 带权重和冷却时间的自主动作              | `id` 唯一、权重为正、引用非循环动画            |
| `hitAreas`           | `rect`、`ellipse` 或 `polygon` 命中区域 | 必须在模型画布内且几何参数有效                 |
| `interactions`       | `hover`、`tap`、`stroke` 交互绑定       | 区域和动画必须存在，同一事件与区域不能重复绑定 |

当前 `qingxiao` 已配置 `behaviors.pet`，并通过外部模块提供主动、被动和指针动作。配置引用的进入、待机、退出、交互 Sprite 仍会在模型导入和加载时统一校验。

#### 3.2 状态机

`PetBehaviorController` 的状态是：

```text
work-idle
   │ 达到空闲时间
   ▼
pet-entering
   │ 进入动画正常完成
   ▼
pet-idle ──自主计时──> pet-action ──动画完成──> pet-idle
   │                       │
   └────鼠标命中───────────┴─> pet-interaction ──> pet-idle

任意宠物状态 ──新键盘/已追踪手柄输入──> pet-exiting ──> work-idle
任意宠物状态 ──门禁失效──> 作废旧 continuation，按可见性与渲染就绪状态选择默认/退出恢复播放，并立即置为 work-idle
```

关键实现约束：

- 所有异步播放都带 `playbackGeneration`；旧动画的 Promise 即使稍后完成，也不能回写新状态。
- 所有激活和自主行为定时器都受 `lifecycleGeneration` 保护；重新配置、停止或销毁后，旧计时器回调自动失效。
- 自主动作按 `weight` 加权选择，遵守各自动作的 `cooldownMs`；有多个候选时尽量避免连续重复上一个动作。
- `exitForInput()` 复用同一个 `exitingPromise`，同一轮退出不会被多个同时输入重复启动。
- 进入或退出动画无法播放、被打断，或运行门禁失效时，控制器回到 `work-idle`；自主动作或交互动画无法启动时则回到 `pet-idle` 并重新安排自主计时。

#### 3.3 运行门禁

进入或继续宠物行为需要同时满足：

- 已配置 `behaviors.pet`；
- 控制器已 `start()`；
- `catStore.pet.enabled` 为真；
- 配置层面的窗口可见状态 `visible` 为真；
- 模型加载和尺寸调整完成，即 `rendererReady` 为真；
- 窗口实际可见且未被悬停隐藏，即 `renderedVisible` 为真；
- 原生输入监听状态为 `ready`；
- 当前没有仍按住的键盘键或已追踪的手柄按钮/`LeftThumb`/`RightThumb`。

`mouseInteractions` 只控制 `hover`、`tap`、`stroke` 是否可触发，不决定自主宠物行为本身能否运行。

### 4. 物理输入身份与渲染映射分离

这是后续修改时最重要的不变量。

#### 4.1 两种身份

- `inputId`：一次真实输入会话的稳定身份。键盘使用原始键码；手柄使用 `Gamepad:<name>`。
- `renderKey`：当前模型实际支持并用于动画或旧式覆盖图的键。例如 Live2D 模型可能把左右 Shift 统一映射为 `Shift`，Sprite 模型则可以继续使用原始键名。

`modelRuntime.activeKeyboardInputs` 使用 `Map<inputId, renderKey | undefined>`：

- `undefined` 表示物理输入仍然按住，但当前模型正在切换或还不能计算视觉映射；
- 有值表示该物理输入当前映射到某个渲染键；
- 多个 `inputId` 可以映射到同一个 `renderKey`，只有最后一个物理输入释放后才允许释放该视觉状态。

因此不能把这张表退化为 `Set<renderKey>`。那会重新引入左右修饰键、键盘与手柄同名按钮、多个物理键共享一个动画时的提前释放问题。

#### 4.2 模型切换

模型切换分为两个明确阶段：

1. `prepareModelTransition()` 调用 `suspendKeyboardInputRendering()`：清除旧模型的 Sprite/覆盖图按压态，但保留全部 `inputId`，并把其 `renderKey` 暂时设为 `undefined`。
2. 新模型、尺寸和支持键列表就绪后，`remapPressedKeyboardInputs()` 调用 `remapKeyboardInputs()`：根据新模型重新计算 `renderKey`，重建可显示的按压动画。

重映射不会重新显示按键气泡，因为用户没有再次按键；它只是恢复当前仍然成立的视觉状态。切模型也不能合成 KeyRelease，否则宠物空闲计时会在用户仍按住键时错误开始。

#### 4.3 输入监听失效

监听真正进入 `unavailable` 时与模型切换不同：此时已经无法保证后续能收到真实 KeyRelease，所以必须主动释放已知键盘和鼠标状态，清除自动释放定时器，并把宠物行为门禁设为不可用。

### 5. Gamepad 生命周期

`src/composables/useGamepad.ts` 维护按钮、摇杆按下和轴值，并遵守以下规则：

- 只有当前模型 `mode === "gamepad"` 时才处理 `gamepad-changed`；停止监听后到达的迟到事件直接忽略。
- 普通按钮使用 `Gamepad:<name>` 作为 `inputId`，按钮的显示绑定仍使用模型配置中的原始 `name`。
- 重复的同状态按钮事件不会再次触发动画或释放。
- `LeftThumb`、`RightThumb` 虽然不是普通 Sprite 按键绑定，也必须进入活动输入集合，以阻止宠物在摇杆仍按下时误激活。
- 离开 gamepad 模式时，必须释放所有按钮和 thumb 状态，并把轴值与 Live2D 参数归零。
- 从一个 gamepad 模型直接切到另一个 gamepad 模型时，物理按钮会话不应因键盘重映射而被清空；新模型就绪后统一重建可渲染状态。
- 组件卸载时执行同样的释放流程并调用 `STOP_GAMEPAD_LISTING`。这一收口由 `b0a47d2` 完成。

### 6. 渲染就绪与真实可见性

`visible`、`rendererReady` 和 `renderedVisible` 不能合并：

- `visible` 是配置想要窗口显示；
- `rendererReady` 表示当前模型已经完成异步加载、尺寸修正和可绘制准备；
- `renderedVisible` 来自实际窗口可见性、配置可见性以及 `hideOnHover` 的组合。

模型加载和 resize 各自使用 generation：

- 旧模型异步加载结束后不能把新模型标记为 ready；
- 旧 resize 的防抖回调不能把后来的加载误标为 ready；
- resize 开始时先关闭 `rendererReady`，完成并确认 generation 仍匹配后再打开。

窗口可见性通过 `appWindow.isVisible()`、窗口显示/隐藏事件和关闭事件协调。显示时最多按 `50ms × 40` 轮询实际状态，且每轮检查 `windowVisibilityGeneration`，防止旧轮询覆盖新状态。

`hideOnHover` 现在是可取消状态：关闭设置、窗口隐藏、忽略鼠标或组件卸载都会取消定时器并恢复透明度。`setIgnoreCursorEvents()` 的异步写入通过单一任务串行化，始终收敛到 `hoverHidden || passThrough` 的最新值，避免先发请求后完成导致旧值覆盖新值。

### 7. 鼠标命中与拖窗仲裁

`src/composables/usePetPointer.ts` 把鼠标交互从页面组件中分离出来：

- 把浏览器坐标换算到模型画布坐标，处理等比缩放产生的留白，并在镜像模式下反转 X 坐标。
- `hover` 在命中区域稳定停留到 `holdMs` 后触发；命中区域变化、模型切换、关闭宠物/窗口/有效鼠标交互或组件清理会取消旧计时器。
- `tap` 同时约束时间和客户端移动距离；默认最大移动距离由 `PET_MAX_TAP_DISTANCE = 6` 控制。
- `stroke` 在同一有效命中区域内累计模型坐标距离，并受 `distance` 和 `windowMs` 限制。
- 只有确实存在交互或当前宠物动画需要阻止输入时才获取 pointer capture。
- 手势超过 tap 阈值、又没有仍可成立的 stroke 时，把控制权移交给 `appWindow.startDragging()`。
- 按住 Shift 或点击未配置交互的区域时保持原有拖窗行为。
- `pet-entering`、`pet-exiting` 和正在播放交互动作时不会重复接受新的宠物交互。

页面入口 `src/pages/main/index.vue` 只负责绑定 pointer 事件和普通拖窗后备逻辑；手势判定不要重新塞回页面组件。

### 8. Sprite 播放调度

`src/utils/sprite.ts` 的播放契约由 `PetPlaybackHandle` 表达：动画名和返回动画均有效时，`play()` 返回动画名和 `finished` Promise；引用无效时返回 `null`。结束原因是 `finished`、`interrupted` 或 `destroyed`。

调度规则：

- 开始新播放前先以 `interrupted` 结算旧播放，避免等待者永远悬空。
- 非循环动作正常结束后回到 `returnTo`；未指定时回到模型 `defaultAnimation`。
- 每帧优先使用 `frameDurations[frame]`，没有时使用 `1000 / fps`。
- `requestAnimationFrame` 的 `tick` 会补偿页面卡顿造成的逾期帧，但每次最多推进 `frames × 2`，避免异常时间跨度造成无限循环。
- `maxFPS` 只限制实际重绘频率，不改变动画时间轴；气泡、待绘制状态或仍需推进/结算的活动动画存在时保持 rAF 调度，其中包括多帧循环动画和一次性动画。
- 键盘和鼠标按压态分别保存，并通过 `pressedInputOrder` 恢复最近一个仍按住且为循环动画的绑定。
- 模型切换后的 `syncPressedKeyboardBindings()` 只重建状态，不创建新的用户输入事件。
- Canvas 以 `devicePixelRatio` 设置实际像素尺寸，按模型画布和视口的最小缩放比例居中绘制，避免因窗口宽高比不同而剪切 Sprite。

按键气泡与 Sprite 共用 Canvas。气泡从配置的 `anchorX`、`anchorY` 出发，使用弹性缩放、轻微摇摆、渐变云朵、尾部和上升轨迹；实际字符不可显示时回退到格式化键名。`maxVisible` 限制同时存在的气泡数量。

### 9. 本地 rdev 的来源与本地补丁

#### 9.1 上游基线

`vendor/rdev` 基于以下上游快照：

- 仓库：`kunkunsh/rdev`
- 提交：`cb9a29e19668a52e4e67d8a0ca6739c1807f8d3f`
- 许可证：MIT，原文保留在 `vendor/rdev/LICENSE`

`src-tauri/Cargo.toml` 使用 `rdev = { path = "../vendor/rdev" }`，因此构建实际使用本地代码，不是 crates.io 或 Git 远程版本。

#### 9.2 直接搬运且相对该提交未改动的文件

下列文件与上述提交逐字节一致：

- `vendor/rdev/LICENSE`
- `vendor/rdev/src/codes_conv.rs`
- `vendor/rdev/src/keycodes/android.rs`
- `vendor/rdev/src/keycodes/chrome.rs`
- `vendor/rdev/src/keycodes/linux.rs`
- `vendor/rdev/src/keycodes/macos.rs`
- `vendor/rdev/src/keycodes/macos_virtual_keycodes.rs`
- `vendor/rdev/src/keycodes/usb_hid.rs`
- `vendor/rdev/src/keycodes/windows.rs`
- `vendor/rdev/src/linux/display.rs`
- `vendor/rdev/src/linux/grab.rs`
- `vendor/rdev/src/macos/display.rs`
- `vendor/rdev/src/macos/keyboard.rs`
- `vendor/rdev/src/macos/simulate.rs`
- `vendor/rdev/src/windows/display.rs`
- `vendor/rdev/src/windows/grab.rs`
- `vendor/rdev/src/windows/keyboard.rs`

`keycodes/mod.rs` 以及少数平台文件还存在 import/module 排序差异；这类差异不是功能补丁。

#### 9.3 本地功能补丁

本地补丁主要集中在：

- `vendor/rdev/src/lib.rs`：导出 `listen_with_ready()`；macOS 额外导出 `listen_with_ready_and_error()`，并对跨线程事件回调要求 `Send`。
- `vendor/rdev/src/rdev.rs`：增加 `CallbackPanic`、`EventTapInvalidated`、`EventTapDisabled`、`RecordRangeError` 和 `MessageLoopError` 等可恢复错误。
- `vendor/rdev/src/linux/keyboard.rs`：初始化中途失败时使用 RAII 释放 X11 输入法、上下文、窗口和 display。
- `vendor/rdev/src/linux/listen.rs`：增加 ready 回调、回调 panic 隔离、XRecord 双 display 和资源自动释放。
- `vendor/rdev/src/windows/listen.rs`：增加 ready 回调、hook RAII 清理、panic 隔离和完整消息循环错误处理。
- `vendor/rdev/src/macos/common.rs`：修正 Core Graphics FFI 类型，以借用方式包装 `CGEventRef`，并独立判断左右修饰键。
- `vendor/rdev/src/macos/grab.rs`：按修正后的原始指针 ABI 借用事件，不接管系统传入对象的所有权。
- `vendor/rdev/src/macos/listen.rs`：增加 event tap 阶段机、失效回调、disabled 重启校验、失败回调、主队列资源释放和清理互斥。
- 各平台 `mod.rs`：导出新增监听入口。
- `vendor/rdev/Cargo.toml`：为 macOS 的借用转换增加 `foreign-types`，并移除本仓库未搬运的上游 README、example 和 test 元数据。

更新上游时不能直接覆盖整个 `vendor/rdev`。应先对新旧上游做快照差异，再逐项重放本节补丁，并重新检查三个平台的监听签名和资源生命周期。

### 10. F-01 到 F-09 的问题背景与不变量

#### F-01：macOS event callback ABI

问题背景：Core Graphics C 回调传入的是原始 `CGEventRef` 指针。把它声明成 Rust `CGEvent` 包装对象会导致 FFI ABI 不匹配，也会混淆系统对象的所有权。

修复：FFI 签名改为 `core_graphics::sys::CGEventRef`；`borrow_cg_event()` 使用 `CGEvent::from_ptr()` 和 `ManuallyDrop<CGEvent>` 创建临时借用视图。

不变量：跨 FFI 边界只传原始指针；回调不得释放或长期持有系统传入的 event；返回原始 `cg_event`。

#### F-02：macOS 回调的线程安全契约

问题背景：回调闭包从 `device-listener` 线程转交并保存在全局状态，随后由主 RunLoop 上的 Event Tap 回调执行，但公开 API 曾允许非 `Send` 闭包，类型契约弱于真实执行模型。

修复：macOS 的 `listen`、`listen_with_ready`、`listen_with_ready_and_error` 事件回调统一要求 `FnMut(Event) + Send + 'static`；失败回调同样要求 `Send`。

不变量：凡是可能跨线程保存或执行的闭包必须在公开 API 边界声明 `Send`，不能只靠调用方“保证不会出事”。

#### F-03：监听失效后的恢复

问题背景：event tap 被系统禁用、失效、回调 panic 或监听线程退出时，应用可能仍以为监听正常，输入状态也可能永久卡住；前端只启动一次监听，无法恢复。

修复：

- macOS 增加 invalidation callback，并在 tap disabled 时先重新启用现有 tap，再验证 `CGEventTapIsEnabled()`；
- 原生层通过 `Starting`、`Ready`、`Unavailable` 上报真实生命周期；
- 失败时先释放已知输入状态，再按 `500ms` 起步、最大 `8000ms`、最多 6 次的指数退避重启；
- 连续 ready 10 秒后才重置重试次数；
- 权限请求和 listener start 都做单飞，组件卸载会取消轮询与重试。

不变量：只有 hook/tap 安装并验证后才能上报 `Ready`；macOS 必须等 ready 回调返回并提交 `COMMITTED` 后才接受事件。任何 `Unavailable` 都必须先消除卡键；同时只能有一个启动、权限或重试流程。

#### F-04：长按期间误进入宠物形态

问题背景：仅在 KeyPress 瞬间重置激活计时器不够。用户持续按住一个或多个键时，计时器仍可能重新开始；切模型还可能丢失“仍按住”的事实。

修复：活动物理输入由 `modelRuntime` 长期持有并同步到 `PetBehaviorController`；第一个输入按下时取消激活，最后一个输入释放且其他门禁仍满足时才重新计时。

不变量：只要活动输入集合非空，宠物形态就不能激活；释放其中一个键不能代表全部输入结束；模型生命周期不能清除物理输入事实。

#### F-05：不可见或未就绪时消耗宠物动画

问题背景：模型切换遮罩、resize、窗口隐藏和 `hideOnHover` 期间，行为状态机仍可能进入并播放，导致用户重新看到窗口时已经错过动画；旧异步任务还可能把新模型误标为 ready。

修复：增加 `rendererReady`、`renderedVisible`，并给加载、resize、窗口可见性轮询增加 generation；隐藏时直接恢复默认动画，不在不可见处播放退出过程。

不变量：配置想显示不等于实际已显示；模型加载完成不等于 resize 和首帧布局完成；旧异步结果不得修改新生命周期状态。

#### F-06：event tap 提交与清理竞态

问题背景：setup 失败的 Drop 清理与原生 callback 可能同时访问全局指针；成功路径又在离开互斥区后才 `disarm()`，资源所有权转移存在窗口。

修复：setup 清理闭包也获取 `CALLBACK_GATE`；确认 phase、执行 ready、提交 phase 和 `resources.disarm()` 全部在同一个临界区完成。

不变量：callback 与 setup cleanup 互斥；在解除 invalidation callback、清空全局指针、从 run loop 移除 source 之前不能 `CFRelease`；资源所有权的提交必须与 phase 提交原子化。

#### F-07：物理输入与视觉键混用

问题背景：模型支持键归一化会让多个物理输入共享同一个视觉键。若只保存视觉键，释放其中一个输入会提前结束动画；模型切换时合成释放又会丢失真实长按会话。CapsLock 的平台事件形态也不能按普通成对按键假设处理。

修复：`PressedKeyboardInput` 保存原始 `code` 和可选 `renderKey`；所有释放以 `inputId` 查找原映射；只有不再有其他输入映射到同一 `renderKey` 时才释放视觉状态；CapsLock 的 Press/Release 都通过短时 auto-release 归一化。

不变量：输入集合以物理身份为真源；视觉键只是可重建的派生状态；模型切换不能伪造物理释放。

#### F-08：左右修饰键互相干扰

问题背景：原实现通过比较整个 `CGEventFlags` 与静态 `LAST_FLAGS` 的大小判断 Press/Release。多个修饰键组合时，整体数值变化不能说明当前那一侧键的状态，左右 Shift、Control、Option、Command 会互相误判。

修复：根据本次 `FlagsChanged` 的 keycode 选择对应 device-specific flag，直接检查该位；CapsLock 和 Fn 保持各自标志语义，未知键才回退到 `CGEventSourceKeyState(CombinedSessionState, code)`。

不变量：每个修饰键独立判断自己的位；不能恢复全局 `LAST_FLAGS` 比较，也不能用通用 Shift/Control 聚合位替代左右设备位。

#### F-09：模型切换重映射与手柄状态丢失

问题背景：新模型的支持键只有加载后才知道。如果切换时清空共享输入表，仍按住的键无法在新模型恢复；如果键盘重映射清空整个表，还会误删仍按住的手柄按钮，使宠物误判为空闲。

修复：切换前只暂停键盘视觉映射；新模型就绪后对键盘输入重新计算 `renderKey`，同时保留其他输入来源；手柄使用来源前缀、去重、迟到事件门禁和明确释放生命周期。

不变量：重映射只改派生映射，不制造新气泡、不制造物理 Press/Release、不清除其他输入来源；离开输入来源的有效生命周期时才真正释放该来源状态。

### 11. 文件职责

| 路径                                 | 职责                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `src/utils/pet-behavior.ts`          | 宠物配置类型、严格校验、状态机、计时器、冷却、命中测试和播放生命周期                       |
| `src/utils/model-runtime.ts`         | Live2D/Sprite 统一入口；保存物理输入身份；协调宠物退出、模型切换重映射和 Sprite 按压态     |
| `src/utils/sprite.ts`                | Sprite 模型加载校验、逐帧播放、播放 Promise、键鼠绑定、按压恢复、Canvas 缩放和气泡绘制     |
| `src/composables/useDevice.ts`       | 键鼠事件接入、输入权限、监听恢复、物理键表、窗口真实可见性、hide-on-hover 和鼠标穿透串行化 |
| `src/composables/useGamepad.ts`      | 手柄模式监听、来源身份、按钮/thumb 去重、轴值恢复以及退出/卸载清理                         |
| `src/composables/useModel.ts`        | 模型加载代次、可判旧的 resize、支持键映射、旧式 Live2D 覆盖图状态和统一输入适配            |
| `src/composables/usePetPointer.ts`   | 模型坐标换算、命中区域、hover/tap/stroke 识别和拖窗仲裁                                    |
| `src/composables/useTauriListen.ts`  | 返回可等待的 Tauri listener 安装 Promise，并在卸载竞态中及时 unlisten                      |
| `src/pages/main/index.vue`           | 页面生命周期、独立模型/resize 代次、模型切换两阶段调用、渲染门禁更新以及 pointer 事件接线  |
| `src/stores/cat.ts`                  | 持久化 `pet.enabled`、`pet.activationDelayMs`、`pet.mouseInteractions`                     |
| `src/constants/index.ts`             | `device-listener-status` 等前后端事件名                                                    |
| `src-tauri/src/core/device.rs`       | 原生 listener 单实例状态、事件序列化、ready/failure 状态上报和线程 panic 边界              |
| `src-tauri/Cargo.toml`、`Cargo.lock` | 把 `rdev` 固定为仓库内路径依赖并锁定新增依赖                                               |
| `vendor/rdev/**`                     | 上游 rdev 快照及本项目为监听可靠性加入的跨平台、本地功能补丁                               |

### 12. 验证结果

在本交接提交前的当前工作树上已执行并通过：

```bash
git diff --check fork/codex/pet-interactions...HEAD
./node_modules/.bin/eslint src
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vite build
cargo fmt --all --check
CARGO_TARGET_DIR=/tmp/bongocat-comment-doc-check cargo check --workspace
```

Vite 仅报告既有的 chunk 大小提示。Rust 检查仅保留 vendored `rdev` 中既有的 unreachable pattern、`static_mut_refs` 和 `block v0.1.6` future-incompatibility 警告，没有构建错误。

当前内置模型未配置 `behaviors.pet`，所以这轮验证覆盖的是框架、类型、构建和输入状态链路，不代表已经验收某一套实际宠物行为 Sprite。以后加入模型行为时，仍需对真实 enter/idle/action/interaction/exit 动画做应用内验收。

### 13. 后续修改禁区

后续 AI 或维护者修改这些模块时，不要破坏以下边界：

1. 不要用 `renderKey` 替代 `inputId` 作为输入真源，也不要把 `Map<inputId, renderKey | undefined>` 简化为视觉键集合。
2. 不要在模型切换时清空或合成释放仍按住的键盘/手柄活动输入；只暂停旧视觉，新模型就绪后重映射。鼠标按钮按现有过渡逻辑单独释放。
3. 不要让重映射调用普通 Press 路径，否则会重复气泡、重复动作并重置输入顺序。
4. 不要在键盘重映射时清空手柄输入；输入来源必须隔离，手柄身份必须保留 `Gamepad:` 前缀。
5. 不要只清按钮不清 thumb、轴值或组件卸载状态；离开 gamepad 生命周期必须完整归零。
6. 不要把 `visible`、`rendererReady`、`renderedVisible` 合并；它们分别表达意图、渲染准备和真实可见性。
7. 不要让旧 load、resize、visibility Promise 在没有 generation 校验的情况下回写当前状态。
8. 不要并发裸调用 `setIgnoreCursorEvents()`；必须保持最新值收敛的串行写入。
9. 不要用整个 `CGEventFlags` 的大小变化判断修饰键，也不要恢复 `LAST_FLAGS`。
10. 不要把 macOS 回调 ABI 改回 Rust 包装对象；`CGEventRef` 只能临时借用，不能在回调中接管所有权。
11. 不要移除 macOS 回调的 `Send` 约束，也不要让 panic 穿过 C ABI 边界。
12. 不要绕过 `CALLBACK_GATE` 或把 `resources.disarm()` 移出 listener commit 临界区。
13. 不要在 run loop source 仍注册、invalidation callback 仍有效或全局指针仍指向资源时执行 `CFRelease`。
14. 不要把 `vendor/rdev` 当作无修改上游整体覆盖；更新前必须以 `cb9a29e19668a52e4e67d8a0ca6739c1807f8d3f` 为已知基线审计本地补丁。
15. 不要放宽 `assertPetBehaviorConfig()` 对动画循环属性、命中区域、唯一 ID、时间和引用完整性的校验。
16. 不要把 pointer 手势与普通拖窗做成两个互不知情的监听器；pointer capture、tap/stroke 归属和拖窗移交必须继续由 `usePetPointer.ts` 仲裁。
17. 不要以“编译通过”代替实际模型验收；新增 `behaviors.pet` 后必须确认窗口显示、切模型、持续按键、手柄、隐藏/恢复、鼠标交互和退出动画的真实表现。
