# 动作设计、生成与交付

## 从角色设定到动作矩阵

先从角色原型提取稳定信息：身份、性格、说话方式、核心道具、常态姿势、允许夸张的部位和不能破坏的视觉标志。把候选动作分为：

1. 生命周期：进入宠物、宠物待机、退出宠物。
2. 主动日常：问候、抚摸、展示道具、休息、表演。
3. 性格表达：高冷、傲娇、害羞、开心、困倦、被惊吓。
4. 环境回应：启动、久别归来、短时高频输入、连续工作、空闲分阶段。
5. 日历行为：晨间、午间、晚间、深夜、工作日、周末、节日。

另外区分“一次性动作”和“人物状态”。挥手、弹琴、惊讶通常播放完就返回当前常态；睡眠、情绪或形态可以通过 `stateEffect` 改变状态，再由循环 Visual Profile 持续呈现。不要为了持续状态反复调度同一个 one-shot 动作。

一个 animation 可以承载多个语义接近的 action；每个 action 再通过不同 dialogue、priority、cooldown 和 trigger 形成差异。不要为了台词不同复制雪碧图。

动作矩阵至少记录：action id、动画来源、表情/肢体、主动/被动来源、台词、可选本地音频、频率、优先级、是否可打断、菜单分组、所需 hit area。

## 动画语义

- 常态必须符合角色默认设定；清醒角色默认睁眼，闭眼只用于眨眼、睡眠、眨眼挥手等有意义阶段。
- 进入和退出连接工作 canonical 与宠物 canonical；普通宠物 action 首尾回宠物 canonical。
- 主动点击可能跳过或打断进入/退出动画，所以手动 action 自己必须从 pet canonical 起步，并在前几个短帧内出现可读变化。避免在首尾堆叠长时间相同帧，让播放状态与用户看到的动作错位。
- 待机动画使用真实 `frameDurations` 保持自然节奏，不用大量重复图片模拟停顿。
- 复杂动作使用 8–16 帧和真实 intermediate pose；小动作可以更少，但必须在正常显示尺寸下可读。
- 峰值停留期间可让法球、音符、星光、气流或挥手线继续变化，让角色保持生命感。
- 高冷/傲娇动作的可爱来自节制的停顿、目光和小幅姿态，不是长期闭眼或突兀大位移。
- 循环状态常态必须首尾无缝；可从同一条已验收动作时间线选择相邻/对称稳定帧重组，但不能把“进入状态再退出”的完整 one-shot 原样设为 loop。
- 持久化形若改变人物材质或轮廓，必须为所有可触发动作输出独立完整 sheet，并由 `stateAnimations` 选图；同形态眨眼也必须使用该形态自己的眼部材质。形态切换需按来源形态制作完整过渡，禁止播放普通动作后再叠加或跳切形态。

## Canonical-first 生产

如果已有模型，使用其 `references/canonical-base.png` 和生命周期 canonical；没有则先调用 `$build-bongocat-sprite-model`。

1. 检查所有角色参考图，确定唯一透明 RGBA canonical。
2. 用图像生成只制作关键姿势 donor，不独立制作每帧。
3. 把发型、服饰、道具、飘带等常驻附件纳入 canonical 本体；不能在运行时临时叠一张附件图，也不能让动作中途才出现或消失。
4. 为眼睛、眉毛、嘴唇、脸颊、手/袖、道具和特效建立明确 ROI/走廊。表情和口型可以变化，但不能替换整张脸或改变五官比例。
5. 用户确认人物模板时只代表角色造型获准，不自动批准模板图里的背景、构图或临时特效。正式帧必须使用真实透明背景。
6. 每帧从 immutable canonical 重组，只替换动作区域。
7. 用真实中间姿势构造进入、峰值、返回；禁止不同肢体姿势直接透明 crossfade。
8. 未使用 cell 完全透明；alpha=0 位置的 RGB 清零；最终 sheet 保存为 lossless RGBA WebP。

具体像素稳定、双手动作、变身、定量和视觉 QA 规则见相邻技能：

- `.agents/skills/build-bongocat-sprite-model/SKILL.md`
- `.agents/skills/build-bongocat-sprite-model/references/production-and-qa.md`

## 对白设计

- 先确定人物语气，再写短句；气泡不是长文本容器。
- 同一 action 准备 2–4 句有权重的变体，避免机械重复。
- 主动动作可以 `chance: 1`；高频 interval/idle/activity 建议降低 chance。
- 台词应回应真实触发上下文，不声称应用没有观察到的事情。
- 活跃度引擎只保存来源、输入标识和时间，不知道用户输入内容；不得写成“我看见你输入了某句话”。
- 中文至少提供 `zh-CN`；公开模型建议同时提供 `en-US`。
- anchor 放在头部外侧空白区，测试两行文本、镜像和窗口缩放。
- 持久形态需要不同语气时使用 `stateDialogues`，并让它与 `stateAnimations` 使用相同的 `match`；保留基础 `dialogue` 作为普通形态和未命中状态的回退。

固定录音与随机对白不能独立抽取成互相矛盾的内容。若 action 绑定一条固定语音，优先让对应气泡只有同义文本，并让 `audio.delayMs` 与 `dialogue.delayMs` 对齐。WEM 使用原文件直接播放，不要为了接入而离线转码。

## 触发器选择

- 用户明确选择：`manual`
- 直接摸、点、悬停：`pointer`
- 宠物态随机呼吸感：`interval`
- 无输入分阶段变化：`idle`
- 精确本地时刻/节日：`schedule`
- 每次应用会话一次：`session`
- 离开一段时间后回来：`visibility-return`
- 短窗口内输入明显变多：`activity-burst`
- 长时间持续工作：`active-session`
- 每天一个时间段随机一次：`daily-window`

不要用多个类型模拟同一件事。相邻 visibility 区间使用不重叠的 `[minAwayMs,maxAwayMs)`；重叠 daily window 或 schedule 必须有明确优先级与冷却。

## 加速测试但不污染交付值

被动触发器不能只靠代码阅读验收。可以在工作副本中把分钟/小时临时缩短为秒级，记录每类 trigger 的实际执行结果，然后恢复正式值并重新校验 JSON。不要把测试计时提交到最终模型。

至少观察：

- startup 只触发一次
- idle 从最后一个输入释放后开始
- keyboard auto-repeat 不被 activity-burst 重复计数
- `inputActions.keyboard` 的 one-shot 在按住按键时只启动一次，并按来源状态选中正确变体、结束后回来源形态常态
- active-session 在 quiet 后执行并按 reset 切分会话
- visibility-return 不被右键菜单、hover 隐藏或 resize 伪造
- daily-window/schedule 使用本地日期时间且同一 occurrence 不重复
- 打开菜单时被动计时冻结，关闭后按剩余时间继续
- 键盘输入打断宠物动作并可靠回工作态
- 第一次主动点击从 work-idle 立即播放目标动作；enter/action/exit 任一阶段再次点击都立即切换
- 输入监听未授权时主动动作仍可重复触发，被动触发保持关闭
- 动作音效关闭时静音；新动作、输入打断和切模型能停止旧语音

## 可导入交付检查

最终目录必须：

- 根目录直接包含 `model.json`，而不是外面再多包一层目录
- `renderer` 精确为 `sprite`
- 包含 `resources/cover.png`
- 只引用目录内部已存在的普通文件
- 不包含 symlink、socket、device 或可执行模型逻辑
- 所有模块 source 唯一且启用状态明确
- 发布资源时按 `model.json` 和每个 `module.json` 的实际 `file` 路径逐项替换与核对。模块局部动画通常位于 `modules/<id>/sprites/`；顶层同名副本不会被运行时读取。
- 模型 id 不与内置 preset 冲突
- 在设置页导入后存储的 renderer 仍为 sprite

如果交付的是内置 preset，还要重新构建包并比较源目录与应用 bundle 内 `model.json`、cover、module manifest 和每张 sheet 的 SHA-256。只有从新 bundle 启动后的可见行为才代表打包成功。
