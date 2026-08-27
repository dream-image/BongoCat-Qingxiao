# 项目内置 AI Skills 使用指南

> 更新时间：2026-08-27
>
> 适用仓库：BongoCat · 清宵桌宠扩展版

本项目在 [`.agents/skills`](../.agents/skills/) 中维护了两套项目级 AI Skill，用于把角色素材和行为设计转换为 BongoCat 可以直接导入的完整 Sprite 模型。Skill 会以仓库当前的 TypeScript 类型、校验器和清宵模型为事实来源，因此比脱离项目编写的通用提示词更可靠。

## 仓库与分支约定

AI 在修改模型、动作模组、运行时或 Skill 前，应先确认当前代码来自 [`dream-image/BongoCat-Qingxiao`](https://github.com/dream-image/BongoCat-Qingxiao)，并基于最新 `main` 工作。完成的代码、资源和文档也应提交到该仓库的 `main`；`ayangweb/BongoCat` 只作为开源上游参考，旧 `dream-image/BongoCat` fork 及 `codex/*` 功能分支不再作为清宵版本的迭代或发布入口。

不同克隆可以使用不同的本地 remote 名称，因此判断目标时应核对 remote URL 和跟踪分支，不要只依赖 `origin`、`fork` 或 `qingxiao` 这类本地名称。

## 两个 Skill 的分工

### `$build-bongocat-sprite-model`

入口：[`.agents/skills/build-bongocat-sprite-model/SKILL.md`](../.agents/skills/build-bongocat-sprite-model/SKILL.md)

适合以下任务：

- 根据人物全身图、立绘或设定图制作新的桌宠模型；
- 建立统一的透明背景基准帧；
- 制作待机、键盘、鼠标、手柄或变身雪碧图；
- 修复 AI 动画常见的抖动、闪烁、轮廓漂移和残影；
- 保证飘带、尾巴、翅膀等常驻附件和人物使用同一 canonical、材质与遮挡关系；
- 在限定 ROI 内制作眉眼、脸颊和嘴唇动作，不用整张脸替换表情；
- 配置 `model.json`，并在真实应用中验证导入、切换和输入响应。

它的主要交付物是一个基础模型目录，目录根部必须包含 `model.json`，同时包含封面、雪碧图和必要的可复现参考素材。

### `$author-bongocat-action-modules`

入口：[`.agents/skills/author-bongocat-action-modules/SKILL.md`](../.agents/skills/author-bongocat-action-modules/SKILL.md)

适合以下任务：

- 为已有 Sprite 模型设计更真实、活泼、可爱或傲娇的宠物动作；
- 增加右键菜单可以主动执行的动作；
- 增加空闲、时间、日期、会话、输入活跃度和持续工作等被动触发；
- 为动作配置对白气泡、本地音频、优先级、冷却、打断规则和菜单分组；
- 用 `stateMachine` 设计清醒、放松、午休、深夜睡眠、情绪和形态常态，并用 action `stateEffect` 串联动作后的状态；
- 为会改变材质或轮廓的持久形态生成整套动作雪碧图，并用 `stateAnimations` 按当前形态选图；
- 用 `behaviors.pet.inputActions.keyboard` 把 Enter 等物理键绑定到状态感知 action，并验证长按不重播、临时形态展示后回来源形态；
- 生成完整模型目录，并检查动画、动作和触发器之间的引用关系。

它生成的是完整可导入模型，而不是孤立的 `module.json`。主动动作会进入右键菜单第二级；被动动作会按触发类型进入第三级。如果一个被动动作也需要手动执行，应为同一个 action 另外声明一个 `manual` trigger。

## 推荐使用顺序

1. 如果只有角色参考图，先调用 `$build-bongocat-sprite-model`，建立能够被应用加载的基础 Sprite 模型。
2. 在基础模型通过导入、切换和输入验证后，调用 `$author-bongocat-action-modules` 设计角色性格和动作矩阵。
3. 让 AI 输出完整模型目录，并运行 Skill 附带的结构校验器。
4. 通过“设置 → 模型管理 → 导入”走一遍真实导入链路。
5. 在宠物窗口逐项验证右键菜单、主动动作、被动触发、对白、音频、键盘打断和模型切换。

已有且可正常加载的 Sprite 模型，可以跳过第一步。Live2D 模型不能直接使用当前 Sprite 动作模组运行时，需要先制作单独的 Sprite 模型。

## 调用示例

从角色参考图创建新模型：

```text
使用 $build-bongocat-sprite-model，根据我提供的角色参考图生成一个可导入的 BongoCat Sprite 模型。常态保持睁眼，键盘输入时演奏古琴，并完成真实应用导入验证。
```

为已有模型增加行为：

```text
使用 $author-bongocat-action-modules，为这个 Sprite 模型设计一套符合角色性格的主动和被动动作。加入右键菜单、对白气泡、本地动作语音、空闲与时间触发，最后交付完整可导入模型目录和 QA 报告。
```

为已有模型增加连续人物状态：

```text
使用 $author-bongocat-action-modules，为这个 Sprite 模型加入清醒、放松、午休、深夜睡眠和情绪状态。临时动作结束后回到最新状态常态，成功动作可按 duration、until-input 或 session 生命周期更新状态。持久形态需要为全部可触发动作生成匹配形态的完整雪碧图，并验证眨眼、动作和形态切换全程不闪普通人物。
```

扩展清宵现有模组：

```text
使用 $author-bongocat-action-modules，在清宵已有模型上增加节日问候和久别归来动作。复用现有动画优先，不修改应用代码，并验证主动菜单为二级、被动菜单为三级。
```

调用时应同时提供角色参考图、性格描述、希望支持的交互方式以及目标平台。若需求没有指定细节，Skill 会根据现有模型和项目约束选择保守默认值。

## 产物和验证边界

一个可交付模型至少应包含：

```text
<model-id>/
├── model.json
├── resources/
│   └── cover.png
├── audio/                # 可选：模型共享动作音频
├── sprites/
├── modules/              # 使用动作模组时需要
└── references/           # 建议保留基准帧和不可变参考素材
```

动作模组 Skill 附带了初步包校验器：

```shell
BONGOCAT_PYTHON="/absolute/path/to/python3"
"$BONGOCAT_PYTHON" .agents/skills/author-bongocat-action-modules/scripts/validate_model_package.py \
  /absolute/path/to/model \
  --report /absolute/path/to/qa/model-package-report.json
```

AI 应先通过工作区依赖加载能力取得 Python 路径，不要把某台开发机器的路径写进脚本或模型。该校验器负责检查目录结构、安全路径、JSON 引用、动画网格、生命周期、状态感知输入绑定、人物状态机、动作状态效果、状态选图变体、触发器、对白锚点、音频引用和封面；它还会报告累计雪碧像素与去重音频数。累计像素没有全模型硬上限，但单张雪碧图仍受 16 MiP 限制；一个模型最多引用 64 个去重音频文件。该脚本不能替代应用自身校验和人工视觉验收。

最终必须在真实应用中验证：

- 模型能够导入、切换并在重启后继续加载；
- 雪碧图没有闪烁、漂移、残影或错误闭眼；
- 主动和被动动作出现在正确的菜单层级且均可执行；
- 主动动作第一次点击立即生效，并能在进入、动作和退出阶段再次点击切换；
- 自动触发频率合理，不干扰键盘、鼠标和手柄输入；
- 输入监听未授权时主动动作仍可用，而被动调度保持关闭；
- 对白、动作音频、音效开关、镜像、窗口缩放、动作中断和清理均正常。
- 状态规则在空闲和本地时间边界切换正确；被打断动作不提交 finished 效果，临时动作完成时不闪回旧常态。
- 状态感知按键在每个来源形态选择正确往返动画；按住时不重复启动，抬起后可以再次触发。

## 维护约定

仓库代码始终是最终契约。如果 `model.json`、动作模块、触发器、菜单层级或导入校验发生变化，应同步更新对应 Skill 的 `SKILL.md`、`references/` 和校验脚本，再更新本文档。不要把特定角色的 action id 硬编码到 Vue、TypeScript、Rust 或原生菜单代码中。

生产运行时必须保持模型无关：`src/` 与 `src-tauri/src/` 只能根据 renderer 类型或经过校验的通用配置字段分支，禁止与具体模型 id/显示名常量、角色目录/资源名、模型自定义 module/action/animation id，以及状态 dimension/value 编写条件判断。两个运行时动态模型 id 之间的比较可用于模型选择、请求路由和过期事件隔离，因为它不包含任何角色知识。角色专属名称只能存在于模型 JSON、本地资源、明确命名的离线生成脚本、测试夹具和维护文档；新的模型能力必须先设计为通用 schema，再由模型配置启用，不能追加“如果是清宵/某模型”的特殊代码路径。
