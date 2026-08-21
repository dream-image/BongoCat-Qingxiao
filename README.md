<div align="center">
  <img src="./src-tauri/assets/models/qingxiao/resources/cover.png" alt="清宵桌宠预览" width="612" />

  <h1>BongoCat · 清宵桌宠扩展版</h1>

  <p>一款支持 macOS、Windows 和 Linux（X11）的开源跨平台互动桌宠。</p>
  <p>在 BongoCat 原有键鼠、手柄响应和模型导入能力之上，增加清宵雪碧图模型、模块化宠物动作、主动/被动触发器、右键交互菜单与对白气泡。</p>

  <p>
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/dream-image/BongoCat?style=flat-square" /></a>
    <a href="https://github.com/ayangweb/BongoCat"><img alt="Upstream ayangweb/BongoCat" src="https://img.shields.io/badge/upstream-ayangweb%2FBongoCat-181717?style=flat-square&logo=github" /></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square" />
  </p>
</div>

> [!IMPORTANT]
> 本仓库是开源项目 [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) 的修改版（fork），不是原项目的官方发行版。感谢原作者及所有上游贡献者提供的跨平台基础实现。

## 清宵预览

上图是当前内置的清宵工作形态。她会根据键盘输入弹琴，也会在空闲、特定时间、久别归来或用户主动操作时进入宠物形态并播放不同动作。

清宵的常态保持睁眼；眨眼、打盹、梦境和傲娇闭眼只在对应语义动作中短暂出现。工作待机和宠物待机均采用正常节奏的多帧动画，不会快速闪烁。

## 这个修改版增加了什么

- **清宵雪碧图模型**：包含工作、进入宠物、待机、退出、弹琴、摸头、打盹、梦境、化形、问候、凝云珠、扫弦、挥手和傲娇等动画。
- **可插拔动作模组**：模型通过 `behaviors.pet.modules` 加载独立 `module.json`；后续角色可以复用同一套运行时，不需要把动作硬编码进页面或菜单。
- **主动互动**：右键菜单按“主动动作 → 动作”展示，用户可以随时选择问候、休息、弹琴、陪伴和角色性格动作。
- **被动互动**：右键菜单按“被动动作 → 触发类型 → 动作”展示；系统也会根据空闲时长、时间窗口、会话启动、久别归来、输入活跃度和持续工作时长自动触发。
- **对白气泡**：动作可以携带独立对白；中文优先使用[黄凯桦律师手写体](https://fonts.zeoseven.com/items/223/)，离线时自动回退到系统行楷或楷体，不影响应用运行。
- **键盘气泡限频**：按下立即反馈，持续按住时按照模型配置的间隔重复冒泡，松开后立即停止，避免系统自动重复导致刷屏。
- **模型管理与导入**：保留并加固 BongoCat 的模型导入、校验、切换和设置链路，失败时不会留下半导入状态。
- **输入链路加固**：处理模型切换时仍按住的键、跨设备同名输入、macOS 监听恢复和新款 Mac `Fn` 键伴生事件等边界情况。

## 动作触发方式

| 类型   | 触发方式                                 | 示例                                     |
| ------ | ---------------------------------------- | ---------------------------------------- |
| 主动   | 宠物窗口右键菜单、点击、悬停、抚摸       | 唤她一声、凝一颗云珠、陪她小憩、傲娇轻哼 |
| 空闲   | 一段时间没有被追踪的键盘、鼠标或手柄活动 | 好奇、打盹、梦境、轻声提醒               |
| 时间   | 本地日期、星期、固定时刻或每日时间窗口   | 早晨问候、午间休息、夜间琴音、节日对白   |
| 会话   | 应用启动或窗口离开后重新可见             | 启动问候、久别归来                       |
| 活跃度 | 短时输入爆发或持续工作达到阈值           | 被吓一跳、回应连击、提醒休息             |

所有动作都经过统一的优先级、冷却、打断和生命周期仲裁。键盘或手柄输入始终优先于自动宠物动作，不会因为后台触发器抢占正常使用。

## 快速开始

请先安装 [Rust](https://www.rust-lang.org/tools/install)、[Node.js](https://nodejs.org/) 和 [pnpm](https://pnpm.io/)，并完成 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)配置。

```shell
git clone https://github.com/dream-image/BongoCat.git
cd BongoCat
pnpm install
pnpm tauri dev
```

构建当前平台安装包：

```shell
pnpm tauri build
```

如果 Tauri 配置中存在 updater 公钥，正式更新包还需要提供对应的 `TAURI_SIGNING_PRIVATE_KEY`。仅构建本地未签名安装包时，应根据自己的分发方式关闭 updater artifact 签名要求；不要把私钥写进仓库或提交记录。

## 模型与动作模组

清宵模型入口位于：

```text
src-tauri/assets/models/qingxiao/
├── model.json
├── resources/cover.png
├── sprites/
└── modules/
    ├── lively/
    ├── routine/
    └── tsundere/
```

新增模组时应优先使用数据配置：在 `modules/<module-id>/module.json` 中声明动画、动作和触发器，再由模型的 `behaviors.pet.modules` 引用。不要在 Vue 页面、TypeScript 菜单或运行时控制器中硬编码某个角色的 action id。

## 项目附带的 AI Skills

仓库在 `.agents/skills/` 中附带了两套面向 Codex 等 AI 工程代理的项目级 Skill。它们会先读取当前代码中的模型契约，再生成可由“设置 → 模型管理 → 导入”加载的完整模型目录。

| Skill                                                                                         | 适用场景                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`$build-bongocat-sprite-model`](./.agents/skills/build-bongocat-sprite-model/SKILL.md)       | 根据角色参考图建立基础 Sprite 模型，制作待机、键鼠和变身动画，并完成雪碧图稳定化与视觉验收。     |
| [`$author-bongocat-action-modules`](./.agents/skills/author-bongocat-action-modules/SKILL.md) | 为已有 Sprite 模型设计主动、被动、指针、日程和对白动作模组，生成右键菜单配置与完整可导入模型包。 |

新角色应先使用 `$build-bongocat-sprite-model` 建立可正常加载的基础模型，再使用 `$author-bongocat-action-modules` 扩展宠物行为；已有 Sprite 模型可以直接从第二个 Skill 开始。详细的调用示例、产物边界和验证要求见 [项目内置 AI Skills 使用指南](./docs/AI_SKILLS.md)。

## 维护文档

- [项目内置 AI Skills 使用指南](./docs/AI_SKILLS.md)
- [清宵动作模组、触发器与资源约束](./docs/maintenance/2026-08-21-qingxiao-pet-action-modules.md)
- [宠物行为、输入链路与模型切换交接记录](./docs/maintenance/2026-08-21-pet-behavior-hardening.md)
- [上游下载指南](./.github/DOWNLOAD_GUIDE.md)
- [贡献指南](./.github/CONTRIBUTING.md)

## 下载说明

这个修改版目前以源码和功能分支为主。如果只需要上游稳定版本，请前往 [ayangweb/BongoCat Releases](https://github.com/ayangweb/BongoCat/releases)；上游安装包不包含本仓库新增的清宵动作模组。

## 开源来源与许可证

本项目基于以下开源工作继续开发：

- 上游项目：[ayangweb/BongoCat](https://github.com/ayangweb/BongoCat)
- 上游灵感来源：[MMmmmoko/Bongo-Cat-Mver](https://github.com/MMmmmoko/Bongo-Cat-Mver)
- 桌面框架：[Tauri](https://github.com/tauri-apps/tauri)

仓库代码继续遵循 [MIT License](./LICENSE)，原版权声明予以保留。清宵角色形象、远程字体及其他第三方素材可能具有各自的著作权或授权条件；MIT 软件许可证不会自动授予这些第三方素材的商标、角色形象或再分发权，请在发布和商用前分别确认。
