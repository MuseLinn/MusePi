---
name: musepi-help
description: MusePi 产品使用帮助——回答"怎么用/是什么/出问题怎么办"类问题（TUI/CLI/桌面 GUI/看板/widget/配置/扩展/许可）。触发：任何关于 MusePi 本身的使用、功能、配置、故障问题。
---

# MusePi 帮助

MusePi 是本地优先的 AI 编程助手（oh-my-pi 的定制分支）：终端 TUI/CLI + 桌面
GUI（Electron，可固定看板到桌面）+ 云端协作渲染。回答产品问题时先确定话题，
再按下面路由回答；不确定时读本地文档（仓库 `docs/`）再答，不要编造。

## 产品构成

- **TUI/CLI**：`musepi` 命令启动终端会话；斜杠命令（`/board` 看板、`/pause`
  暂停、`/steer` 转向、`/tasks` 任务、`/extensions` 扩展）。
- **桌面 GUI**：`packages/gui`（Electron）——daemon 架构：GUI 连 daemon
  （端口 8300）驱动会话；`musepi --gui` 或应用启动。
- **看板（dashboard）**：widget 卡片墙——GUI 侧栏「看板」进入（画布随窗口自适应缩放 + ChromaGrid 组光效）；`board` 工具读写（list/get/schema/save，agent 可建板/加卡）；卡片可拖拽/缩放（网格 92×44、gutter 12）；组件即卡（无外框）。
- **对话内联 widget**：`widget` 工具在对话里渲染活卡片（计算器/滑杆/行情/
  待办/番茄钟/视频等），交互结果可"发送给对话"回传给 agent。

## 配置与目录

- 配置：`~/.musepi/agent/config.yml`；设置：`~/.musepi/agent/settings.json`
- 技能：`~/.musepi/agent/skills/<name>/SKILL.md`（用户级，设置里可开关）
- 扩展：`~/.musepi/agent/extensions/<name>/index.ts`（用户级）；MCP：`.mcp.json`
- **预设（modes）**：`~/.musepi/modes/<id>.json` —— 命名预设 = 扩展工具集白名单
  + 提示词区块 + settings 覆盖（内置 standard / minimal 模板首次访问自动生成）
- 上下文：从 cwd 向上找 `AGENTS.md`（项目约定）
- 看板数据：`~/.musepi/boards/boards.json`（daemon 共享看板存储，GUI 同源）

## 常见问答要点

- **给 MusePi 加功能/工具/命令/hook/插件（开发扩展）**：读 `musepi-extension-dev`
  skill（`skill://musepi-extension-dev`）——六种扩展形态 + 快速路径 + 文档路由表。
- **预设/模式（Work/Design/Minimal）是什么**：命名预设 = 扩展白名单 + 提示词区块
  + settings 覆盖的组合（`~/.musepi/modes/<id>.json`）。GUI 欢迎页（输入框上方
  项目选择旁）chip 选择，创建会话时应用；TUI/CLI 用 `--preset <id>` 启动，
  会话内 `/preset` 查看当前预设；设置 → 智能体 → 预设 管理（卡片面板，
  校验/删除；`modes.validate` 供 agent 自检）。极简模板 = `extensions: []` +
  promptComplete（固定提示词）+ 关压缩。
- **扩展中心两个分类**：OMP Extension Packages（OMP 生态扩展包，`extensions:`
  设置/`--extension`）+ MusePi Extensions（自有扩展系统：TS 模块 + manifest，
  `~/.musepi/agent/extensions`）—— 两者独立 tab、并存。
- **怎么查用量/配额**：TUI 斜杠 `/usage`（每供应商凭证并排 + 最右合计列，供应商按
  用量最低优先）；桌面 GUI 输入 `/usage` 弹用量面板（同款并排视图）、会话输入框旁
  的上下文圆环悬浮显示供应商配额块、托盘菜单底部用量区（Token 合计 + 每供应商
  窗口条）。用量数据磁盘缓存 5 分钟，刷新失败时显示上次快照——重复查看不重复请求。
- **看板卡片出不来了/空白**：确认 daemon 在跑（GUI 会自启）；检查卡片
  `widget` 类型是否在注册表（设置→技能/看板 tab）；历史数据卡（fx/stocks/
  history）需要网络，离线时显示兜底。
- **GUI 没反应**：daemon 长驻——改 daemon 源码后必须重启 daemon 才生效
  （GUI 菜单"重启 daemon"）；`kill` 后 Electron 不会自动 respawn。
- **音效没有**：系统策略限制——CDP 合成输入不产生 user activation，音效只在
  真实点击下播放（已知限制，非故障）。
- **pin 到桌面**：看板卡片 pin 后窗口按卡比例缩放（≤560 宽），拖拽条是
  hover 悬浮的，平时透明。
- **许可/订阅**：MusePi 无内置订阅；模型密钥走 provider 配置
  （`~/.musepi/agent/config.yml`）。

## 回答纪律

- 先给结论，再给路径/命令；引用具体目录或文件。
- 产品问题不要泛化到通用 AI 教程；不知道的查文档或源码再答。
- 涉及 GUI 视觉/行为细节时，以 `docs/gui-design.md` / `docs/gui-implementation.md`
  为准（仓库内）。
