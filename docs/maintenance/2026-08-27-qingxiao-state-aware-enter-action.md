# 清宵状态感知 Enter 动作施工记录

- 创建时间：2026-08-27 12:10:37 CST（Asia/Shanghai）
- 最近更新：2026-08-27 12:23:00 CST（Asia/Shanghai）
- 工作分支：`main`
- 基线提交：`abc0474`
- 目标远端：`qingxiao`（`dream-image/BongoCat-Qingxiao`）
- 当前状态：代码、资源、Skill、文档和工程验证已完成；待真实 macOS 键盘手工验收
- 大体内容：把清宵的 Enter 从“直接播放固定雪碧图”改为模型配置驱动的状态感知模块动作。普通形态临时展示战斗形态后恢复普通，战斗形态临时展示心魔后恢复战斗，心魔形态临时展示普通后恢复心魔；三次展示都不改变长期 `form` 状态。

## 需求语义

| 当前 `form` | Enter 临时展示 | 动作结束后 |
| ----------- | -------------- | ---------- |
| `normal`    | `attack`       | `normal`   |
| `attack`    | `demon`        | `attack`   |
| `demon`     | `normal`       | `demon`    |

这不是全局输入规则，而是清宵模型的特殊能力。运行时不能出现 `normal`、`attack`、`demon` 等角色专属判断；其他模型只有显式声明配置才会启用相同行为。

## 架构决定

### 1. 区分直接动画按键与状态感知按键

- `bindings.keyboard` 继续直接引用顶层 animation，兼容旧模型和普通琴键动作。
- 新增 `behaviors.pet.inputActions.keyboard`，值为规范化后的 `<module-id>/<action-id>`。
- 同一个键不能同时走两条路径。清宵已从 `bindings.keyboard` 删除 `Return`、`Enter`、`KpReturn`，并改为指向 `routine/form-pulse`。

```json
{
  "inputActions": {
    "keyboard": {
      "Return": "routine/form-pulse",
      "Enter": "routine/form-pulse",
      "KpReturn": "routine/form-pulse"
    }
  }
}
```

### 2. 复用现有 action 状态选图，不新增第二套状态机

`routine/form-pulse` 的基础 `animation` 对应普通形态；`stateAnimations` 根据动作启动时的 `form` 快照选择战斗或心魔版本。该 action 刻意不声明 `stateEffect`，因此只改变当前播放画面，不修改人物长期状态。

### 3. 一个动作完成一次完整往返

三张 16 帧无损 RGBA WebP 都在单张 sheet 内完成“来源 → 目标 → 来源”，避免先播放半段、停顿后再播放另一段的不连贯感：

- `pet-normal-attack-return.webp`
- `pet-attack-demon-return.webp`
- `pet-demon-normal-return.webp`

生成脚本使用一条连续对称进度曲线；首帧和末帧严格等于来源 canonical。动作结束时由行为控制器恢复当前人物状态对应的循环常态，不能落入 `defaultAnimation`。

### 4. 长按与菜单边界

- 同一次物理按下只启动一次 action；OS key auto-repeat 仍可产生经过气泡层节流的按键反馈，但不重启 one-shot。
- 抬键后下一次按下可以立即再次触发，不受 action cooldown 限制。
- 原生右键菜单打开时，Enter 仍只确认菜单项，不触发模型按键 action。
- `Return` 与 `Enter` 可以互作回退；`KpReturn` 必须显式配置。

## 配置化边界与全代码审计

### 生产运行时禁止模型特判

- `src/` 与 `src-tauri/src/` 不得与具体模型 id/`displayName` 常量、角色目录/资源名、模型自定义 module/action/animation id 或 state dimension/value 编写条件分支。
- 禁止通过动画名或资源路径前缀推断模型能力；运行时只能读取经过校验的通用 schema 字段。
- renderer 类型、输入来源、播放阶段等引擎通用能力可以分支，但分支不能知道 `qingxiao`、`normal`、`attack`、`demon` 或 `routine/form-pulse` 的含义。
- 两个运行时动态模型 id 之间的比较可以用于选择当前模型、请求路由和过期事件隔离；这类比较不包含具体角色常量，不属于模型特判。
- 新能力必须先成为通用 schema、通用校验和通用运行时能力，再由各模型清单选择启用，不能新增“如果是清宵/某模型”的例外。

### 允许角色专属内容存在的位置

- 模型包及本地资源，例如 `src-tauri/assets/models/qingxiao/**`；
- 明确命名且不被应用运行时导入的离线制作脚本，例如 `scripts/build_qingxiao_*.py`；
- 验证任意配置值的测试夹具；
- Skill、模型制作说明和维护记录。

### 2026-08-27 审计结果

本次检查覆盖了前端生产代码 `src/`、Rust 生产代码 `src-tauri/src/`、模型配置、离线制作脚本及测试：

- 生产运行时没有清宵模型 id、三种形态值、`routine/form-pulse` 或三张新雪碧图资源名的逻辑判断；
- 状态感知 Enter 链路为“模型配置 → 规范化 action id → 来源状态快照 → `stateAnimations` 选图 → 播放结束恢复当前常态”，每一步都只依赖通用字段；
- 通用代码中残留的角色名称只有 WEM mono 解析注释和雪碧图处理器的临时目录前缀，现已分别改成通用声道映射说明与 `sprite-mask-`；两处都不改变逻辑；
- 测试中的 `normal`、`attack`、`demon` 和 action id 是配置数据夹具，用于证明运行时能够处理模型自定义值，不属于生产特判；
- `scripts/build_qingxiao_form_action_variants.py` 是清宵专用离线资源制作工具，不参与应用运行时。

## 代码与资源位置

- `src/utils/pet-behavior.ts`：配置类型、引用校验、键盘 action 来源和动作完成后的当前形态恢复。
- `src/utils/model-runtime.ts`：状态感知按键与旧 Sprite 绑定分流、物理 down/up 记账和 auto-repeat 去重。
- `src/utils/pet-behavior.test.ts`：三种来源形态、长按去重和来源形态恢复回归。
- `scripts/build_qingxiao_form_action_variants.py`：三张往返 sheet 的可复现生成与 contact sheet。
- `src-tauri/assets/models/qingxiao/model.json`：动画声明与 Enter 配置。
- `src-tauri/assets/models/qingxiao/modules/routine/module.json`：`form-pulse` action、状态选图和形态化对白。
- `.agents/skills/author-bongocat-action-modules/`、`.agents/skills/build-bongocat-sprite-model/`：更新后的模型制作契约和包校验器。

## 执行状态

| 项目                     | 状态   | 当前结果                                                   |
| ------------------------ | ------ | ---------------------------------------------------------- |
| 通用运行时配置与分流     | 已完成 | 无清宵形态硬编码，旧 `bindings.keyboard` 保持兼容          |
| 清宵三形态 action 配置   | 已完成 | `routine/form-pulse` 无 `stateEffect`，三套状态选图        |
| 三张往返雪碧图           | 已完成 | 16 帧、2048×2048、首尾回来源、边缘 alpha 0、隐藏 RGB 0     |
| 生产运行时模型硬编码审计 | 已完成 | 0 个模型专属逻辑分支；2 处非逻辑角色名称残留已泛化         |
| 模型包预检               | 已完成 | 72 animations、41 actions、41 triggers、0 error、0 warning |
| 行为单元回归             | 已完成 | 三形态、长按去重、悬空引用拒绝均通过                       |
| 全量测试、类型检查、构建 | 已完成 | 20/20 tests、ESLint、`tsc --noEmit`、Vite/图标构建通过     |
| 真实 macOS 键盘手工验收  | 待验收 | 需在新构建应用中逐一切换三种形态并按 Enter                 |

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

## 后续扩展约束

其他模型可以把任意物理键映射到任意模块 action，但必须继续满足以下条件：

- 配置只引用已加载的规范化 action id，悬空引用在模型加载前拒绝；
- 角色专属模型名、资源名、动作名、动画名、状态维度和值只进入模型包与离线制作资料，不进入 TypeScript、Rust 或 UI 的生产逻辑；
- 临时动作不带 `stateEffect`，持久状态切换才带 `stateEffect`；
- 每个可能的来源形态都有从自身 canonical 开始并回到自身 canonical 的完整动作 sheet；
- 新字段变化必须同步更新两套项目 Skill、契约参考和包校验器；新增能力始终由通用 schema 承载，不能靠模型特判补齐。
