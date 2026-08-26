# 清宵一体化雪碧图重画记录

- 记录时间：2026-08-26 02:57:33 CST（Asia/Shanghai）
- 最近更新：2026-08-26 15:22:45 CST（Asia/Shanghai）
- 工作分支：`codex/pet-behavior-hardening`
- 大体内容：完整重画素材仅作为姿势与特效 donor；正式 27 套雪碧图改为 canonical-first 生产。人物、古琴、背后飘带、头发、服饰、位置和缩放来自同一个睁眼标准帧，只有眼睛、眉毛、嘴唇、脸颊、手/袖动作走廊和外部特效可以按白名单变化。

## 为什么重新制作

早期方案把单独生成的飘带叠加到已有雪碧图上。实际运行时会出现飘带先显示、随后消失、再播放原动画的割裂感；人物没有稳定处于飘带中心，遮挡关系、透亮材质和边缘光也与人物不一致。即使继续调整位置和透明度，人物与飘带仍然是两套不同光照和材质的图像，无法获得自然的一体感。

因此飘带仍属于角色本体，不再通过运行时图层补上。完整重画曾被尝试作为正式时间线，但实际播放证明独立生成的相邻帧仍会改变人物材质、线稿、发丝、五官、位置和尺寸。完整重画现在只提供局部姿势/表情参考，不能直接成为最终连续帧。

## 13:28 canonical-first 纠正（当前正式方案）

用户复核指出，上一版虽然稳定了人物中心和尺寸，但相邻帧差异仍然过大。根因不是播放组件，而是最终时间线仍由多张独立生成的完整人物图组成；平移和缩放只能修正包围盒，不能阻止线稿与材质逐帧重画。

当前正式方案遵守项目 `build-bongocat-sprite-model` skill：

1. `idle` 第 0 帧是唯一睁眼 canonical，拥有完整人物、古琴和常驻飘带。
2. `idle` 只允许固定眼部 ROI 变化；身体、双手、古琴、服饰、头发和飘带在眨眼时逐像素不变。
3. `pluck-01` 至 `pluck-10` 只在动作专属的左右手/袖走廊移植 donor，首尾回到 canonical，出程与回程逐像素对称。
4. 宠物动作只允许固定眼睛、嘴部、脸颊和手/袖 ROI 变化；脸型、发际线、头发、服饰、古琴、飘带、人物位置和缩放全部锁定。
5. 嘴唇与脸部允许变化，但只能使用小范围确定性表情层；微笑、惊讶、轻声说话和傲娇嘟嘴不能替换整张脸。
6. 轻奏、好奇和受惊动作曾因中间位切换整块袖型超过 3.5% 轮廓门。修复没有放宽门限，而是保留同一个中间手位，由口型和外部特效继续推进动作。
7. 所有 QA GIF 使用 `model.json` / `module.json` 的真实帧时长，不能用更快的预览速度掩盖跳帧。

候选与 QA 位于：

- `artifacts/qingxiao-model-work/canonical-first-work-v1/`
- `artifacts/qingxiao-model-work/canonical-first-pet-v1/`
- `artifacts/qingxiao-model-work/canonical-first-model-v1/`

## 已弃用的整帧位置/尺寸稳定方案（历史记录）

以下方案曾用于修正整帧重画素材的位置和尺寸。它解决包围盒抖动，但无法解决材质、线稿和局部结构逐帧变化，因此不再作为正式生产步骤，只保留给历史素材审计。

`scripts/stabilize_qingxiao_redraw.py` 是最终发布前的稳定步骤，负责：

1. 以最大 Alpha 连通体识别人、古琴与常驻飘带组成的主体，忽略独立漂浮的云珠碎片。
2. 工作态统一服从 `idle` 首帧宽度，宠物态统一服从 `pet-idle` 首帧宽度；进出场只在两个基准间平滑过渡。
3. 等比缩放的是完整 RGBA 帧，人物、琴、飘带、表情和动作特效始终一起变化，不重新引入局部合成。
4. 以人脸暖色皮肤连通区作为位置锚点，在多档平移强度中选择兼顾整帧连续性与人脸稳定性的结果。
5. 往返动作回程直接复用出程的完整帧。云珠固定为“准备手势→小云珠→聚气→大云珠→原路收回”，避免纯数值最短路径误把消散残影选成峰值。
6. 输出带帧号接触表、按应用时长播放的棋盘 GIF 和 JSON 指标。GIF 时长受格式 10ms 精度限制，应用仍按模型配置中的毫秒值播放。

稳定脚本拒绝原地覆盖，输入目录和输出目录必须不同。只有输出完成视觉复核、模型包校验与构建后，才允许把候选 WebP 提升到正式目录。不要在稳定步骤之后再次运行 finalizer，否则会重写动作端点并绕过本轮连续性报告。

## 用户确认的角色与画面规则

- 用户确认的是人物造型模板，不是模板图片的背景、构图或整套特效。源图中的临时灰底不能进入正式资源。
- 普通形态使用清透的蓝、青、白配色；白色化形使用月白和冰蓝；心魔形态使用克制的薰衣草紫和冷紫，不使用大面积发黑、过饱和的深紫。
- 背后双层长飘带必须常驻，人物位于飘带视觉中心。飘带要随身体和动作产生连续变化，并服从人物、古琴与手臂的前后遮挡关系。
- 常态和按键动作以睁眼为主。闭眼只用于眨眼、困倦、入睡、沉浸弹奏等有明确语义的帧，不能把闭眼当作默认待机姿态。
- 动作允许细微眉眼变化、嘴角变化和小幅开合口型，但不能让五官比例、服装、发型、配饰或古琴在帧间漂移。
- 云珠、琴弦、音符、梦境、惊醒和心魔气息等属于动作内容，应针对相应动作单独设计；不能复用人物模板的背景，也不能把特效误当成常驻角色部件。

## 背景与透明度处理

生成阶段使用均匀中性灰 `#808080`，目的只是给前景分割提供稳定参照。它不是产品背景，也不代表桌面宠物最终显示效果。

`scripts/process_generated_sprite_sheet.py` 会依次执行：

1. 使用 macOS Vision 的 `VNGenerateForegroundInstanceMaskRequest` 提取主体掩膜。
2. 根据图像边缘拟合实际生成底色，避免图像压缩或光照造成的微小偏色。
3. 用颜色距离约束剔除仍接近临时底色的像素；当前软阈值从距离 12 开始，到 42 完全保留。
4. 清除只从相邻网格边缘闯入的小碎片，同时保留真正靠近画布边缘的大型飘带和动作特效。
5. 把透明区 RGB 清零，输出无损、`exact` 的 RGBA WebP。
6. 同时铺到深色底和浅色底生成 QA 图，检查灰边、灰块、伪透明、断裂和跨格残片。

正式目录 `src-tauri/assets/models/qingxiao/sprites/` 中的资源均为透明背景。禁止把棋盘格画进图像来冒充透明，也禁止直接把带灰底的生成原图复制进模型目录。

## 27 套正式动画

工作态包含 `idle`、`pluck-01` 至 `pluck-10` 和 `transform`。宠物态包含 `pet-enter`、`pet-idle`、`pet-exit`、`pet-doze`、`pet-dream`、`pet-chime`、`pet-curious`、`pet-content`、`pet-startled`、`pet-summon-orb`、`pet-glissando`、`pet-remind`、`pet-wink-wave`、`pet-hmph` 与 `pet-heart-demon`。

其中 6 套模组动画不是从顶层 `sprites/` 读取：`pet-startled`、`pet-summon-orb`、`pet-glissando`、`pet-wink-wave` 位于 `modules/lively/sprites/`，`pet-remind`、`pet-hmph` 位于 `modules/tsundere/sprites/`。发布新图时必须替换这些运行时真实路径；顶层的同名副本不会被模组加载，保留副本反而会造成“源码看似已更新、应用仍播放旧图”的误判。

所有帧均为 512×512。雪碧表的列数、帧数和最终画布尺寸由 `scripts/finalize_qingxiao_redraw.py` 中的 `SHEET_SPECS` 统一约束，不能凭生成图的网格外观猜测。

动作切换复用的是同一个 canonical 人物底图，再叠加经过白名单裁剪的局部动作与外部特效：

- `pluck-*` 与 `transform` 的首尾回到正式工作态。
- `pet-enter` 从工作态进入宠物态；`pet-exit` 从宠物态回到工作态。
- `pet-idle` 的首尾完全一致，形成无缝循环。
- 其余宠物动作首尾回到同一套正式宠物态，避免切换时闪现不同画风、不同飘带或不同人物位置。

模型列表封面 `src-tauri/assets/models/qingxiao/resources/cover.png` 也由当前正式工作态生成，不能继续使用旧版无飘带封面。

## 当前运行时交付状态

- 模型包当前包含 27 套动画、39 个模组动作和 39 个模组触发器；控制器把 5 个旧式指针交互归一化后，共管理 44 个动作和 44 个触发器。
- 27 张雪碧表合计 `69,730,304` 像素（约 `66.5 MiP`）。模型不再设置累计像素硬上限，但单张雪碧表仍不得超过 `16 MiP`，且单个模型最多声明 96 套动画。
- 主动动作从设置页或右键菜单触发时直接播放目标动作，不再先完整等待 `pet-enter`；它可以接管正在进行的进入、动作或退出阶段。因此，所有可主动触发动画都必须让第 0 帧保持合法宠物基准，并尽早出现可读的动作差异。
- `src-tauri/assets/models/qingxiao/audio/` 中现有 7 个本地 WEM 文件，被 8 个动作引用。音频只是动作增强：关闭“动作音效”、音频加载失败或平台暂时无法播放时，雪碧动画和对话仍必须正常执行。
- 动作结束、用户输入、下一动作、模型切换和模型销毁都会停止旧音频，避免上一句台词覆盖到后续状态。

## 复现与维护命令

单张生成源图的处理示例：

```bash
python3 scripts/process_generated_sprite_sheet.py \
  /absolute/path/to/generated.png \
  /absolute/path/to/processed.webp \
  --frames 12 \
  --columns 4 \
  --qa-dir /absolute/path/to/qa
```

全部处理结果的端点统一与封面生成：

```bash
python3 scripts/finalize_qingxiao_redraw.py \
  /absolute/path/to/processed-sprites \
  --qa-dir /absolute/path/to/final-qa \
  --cover src-tauri/assets/models/qingxiao/resources/cover.png
```

以下整帧稳定命令仅用于审计旧完整重画素材，不再生成正式候选：

```bash
python3 scripts/stabilize_qingxiao_redraw.py \
  /absolute/path/to/processed-sprites \
  /absolute/path/to/stabilized-sprites \
  --model-dir src-tauri/assets/models/qingxiao \
  --qa-dir /absolute/path/to/stability-qa
```

模型包校验：

```bash
python3 .agents/skills/author-bongocat-action-modules/scripts/validate_model_package.py \
  src-tauri/assets/models/qingxiao
```

当前正式候选命令：

```bash
python3 scripts/stabilize_sprite_sheet.py \
  --model-dir src-tauri/assets/models/qingxiao \
  --output-dir artifacts/qingxiao-model-work/canonical-first-work-v1 \
  --two-hand \
  --only pluck-01 --only pluck-02 --only pluck-03 --only pluck-04 \
  --only pluck-05 --only pluck-06 --only pluck-07 --only pluck-08 \
  --only pluck-09 --only pluck-10 --only transform

python3 scripts/build_qingxiao_pet_sprites.py \
  --model-dir artifacts/qingxiao-model-work/canonical-first-model-v1 \
  --output-dir artifacts/qingxiao-model-work/canonical-first-pet-v1
```

`scripts/build_qingxiao_pet_sprites.py` 已恢复为正式 canonical-first 生成器。`--legacy-procedural` 仅为兼容旧命令保留，不再改变执行路径。

## 历史整帧稳定验证结果（视觉指标不再作为发布判据）

- 当前模型包校验通过：27 个 animation、39 个 module action、39 个 module trigger、7 个本地 audio，累计 `69,730,304` 个雪碧像素，零错误、零警告。
- 27 张雪碧表的尺寸、有效 alpha 和端点契约通过逐项审计。
- 位置与尺寸稳定复核覆盖 27 套、共 266 帧；非进出场动作的主体宽度相邻波动均不超过约 0.46%，进出场在工作态 441px 与宠物态 450px 之间平滑过渡。
- 问题最明显的云珠动作由 418～450px 收敛到 450～452px，人脸相邻最大位移由约 125.04px 降到约 1.82px；`pluck-06` 由 417～441px 收敛到 440～442px，滑奏由 418～450px 收敛到 449～450px。
- 稳定候选没有任何可见像素被裁切；往返动作前后半程为完整 RGBA 帧级镜像复用，首尾端点与工作态/宠物态逐像素一致。
- 每张动画均在深色、浅色两种底色上检查透明边缘；临时灰底不会随资源进入应用。
- Wwise Opus/WEM 的 4 个测试全部通过。
- Vite 生产构建通过；只保留项目既有的 Rollup 大 chunk 提示。

## 后续 AI 必须遵守

- 不得重新引入独立飘带覆盖层或“人物动画 + 飘带动画”两段式播放。
- 不得把用户确认人物模板理解成必须沿用模板背景。人物模板只约束角色造型与材质，动作构图、环境特效和透明背景要按产品场景处理。
- 不得把灰底、白底、黑底或棋盘格烧进正式雪碧图。
- 新增或重画动作后必须同时检查浅色底和深色底；只在透明查看器中观察不够，因为查看器可能把透明显示成黑色。
- 不得只替换中间帧。必须重新核对完整人物端点、飘带连续性、表情口型、人物中心、遮挡关系和模型契约。
- 如果 donor 在人物比例、服装、古琴或飘带材质上偏离 canonical，只能重做 donor 或缩小白名单；不得把 donor 的整个人物写入正式帧。
- 不得再按每帧完整可见边界分别 fit 到 512px 画布。特效范围不是人物尺寸；尺寸稳定必须使用同一形态的共享人物基准，并同时检查位置、尺寸和真实播放速度。

## canonical-first 验证结果

- 工作态 12 套动画通过：`idle` 眼部外最大通道差为 0；10 套弹奏动作走廊外最大差为 0；首尾、峰值 hold 和镜像回程契约通过。
- 宠物态 15 套动画通过：所有人物白名单外 `characterStaticMaxDelta = 0`、`characterStaticMae = 0`，首尾、对称、眼态、双手、特效遮挡、透明 RGB 和 WebP 解码回读均通过。
- 27 套接触表已逐张视觉复核；微笑与惊讶口型在第一次复核中过大，缩小并降低不透明度后重新生成并通过完整验收。
- QA GIF 已与应用实际帧时长统一，不再使用脚本内部的快速预览时间线。
