<p align="center">
  <strong>MusePi</strong> — 桌面优先的 AI 编程助手
</p>

<p align="center">
  <code>musepi</code> CLI · Electron 桌面 GUI · 常驻桌宠 · daemon 服务
</p>

<p align="center">
  <a href="#-特性"><strong>特性</strong></a> ·
  <a href="#-截图"><strong>截图</strong></a> ·
  <a href="#-快速开始"><strong>快速开始</strong></a> ·
  <a href="#-架构"><strong>架构</strong></a> ·
  <a href="#-开发"><strong>开发</strong></a> ·
  <a href="#-打包与发布"><strong>打包与发布</strong></a> ·
  <a href="#-文档"><strong>文档</strong></a>
</p>

<p align="center">
  <em><a href="README.md">English</a> | 中文</em>
</p>

---

MusePi 是一个**独立的编码智能体平台**：**Electron 桌面 GUI + daemon 服务 + 常驻桌宠**，保留完整 agent 引擎（40+ provider、32 内置工具、LSP/DAP、子智能体、hashline、hindsight、ACP、collab），并将 TUI 的命令面（`/` 命令、`!`/`!!` shell、`@` 文件引用、`#` 引用）逐一接进 GUI。**MusePi 是上游之一**——oh-my-pi / Pi / DSH / opencode 等按需吸收为参考源（见 [UPSTREAM.md](UPSTREAM.md)）。

应用版本 `0.4.6`（独立于上游版本号，见 [UPSTREAM.md](UPSTREAM.md) 版本说明）。

## ✨ 特性

### 桌面 GUI

- **Electron 桌面应用**（`packages/gui`）：三栏布局（会话侧栏 + 聊天流 + 上下文面板）、中文界面、深浅主题 + 强调色 + 密度三轴 token、磨砂玻璃（vibrancy）窗口。
- **常驻桌宠**（pet）：窗口角落的动画伙伴（petdex 帧动画包、拖拽定位、click-through、hover 交互、跨窗口活动桥），执行任务时有 pet 气泡反馈。
- **daemon 架构**：GUI 经 JSON-RPC 连 daemon（`musepi serve`），会话持久化（journal + materialized view）、空闲 30min 转历史快照、按需重激活；Electron 退出后 daemon 存活，GUI 重连即续。
- **受管浏览器**（`browser.gui` 工具）：Electron WebContentsView + CDP 桥——agent 可直接驱动 GUI 内嵌浏览器页（投影布局 + 像素采样验证）。
- **终端面板**：xterm + bun-pty 集成终端（tab、中键关闭、环境加固——剥离 `ELECTRON_RUN_AS_NODE` 等，注入 `APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP`）。
- **完整命令面（TUI parity）**：
  - `/` 斜杠命令：daemon 复用 ACP headless 执行器（同一 builtin registry），`//` 转义为纯文本；欢迎页创建会话后同样执行（结果走桌宠气泡 + 桌面通知）。
  - `!cmd` / `!!cmd`：shell 命令执行（结果进模型上下文；`!!` 排除上下文），转录内渲染终端风格 bash 卡片（exit 徽章、输出折叠展开）。
  - `@` 文件引用：workspace 树补全，daemon 侧 `extractFileMentions` 注入文件内容。
  - `#` 会话引用：会话列表补全，插入 `history://<id>`（read 工具可解析的 internal URL）。
- **上下文管理**：上下文圆环（`session.contextUsage` 实时使用率）、`/compact` parity 手动压缩、snapcompact 节省量估算（与 TUI `/context` 同一 planner）。
- **设置面板**：TUI 全部 336 项配置并入桌面设置（schema 驱动 `settings.schema` RPC，与 TUI 同源），10+ tab；控件复用（开关/分段/选择/凭据掩码）。
- **丰富交互**：图片附件前置缩放（`images.autoResize` 双端生效）、图片预览灯箱（多图堆叠、缩放平移）、附件键盘删除、语音输入、会话草稿持久化、空闲 recap（`recap.enabled`）、提醒面板（`session.list` working/live 实时状态）、⌘K 命令面板、Board 看板、widget 系统（自定义 HTML widget 主题热切换）。
- **右侧面板**：文件树（PDF/图片/文本预览、系统打开）、Git 变更/提交（gitmoji、身份注入、GitHub device-flow 认证）、PR 列表、内嵌浏览器（视口预设、元素选取）、项目笔记 + 待办 + 计划文件。
- **子智能体操作**（Agent Hub parity）：右栏 AgentsPanel 停止/复活/对话（`agents.kill/revive/chat` RPC）。

### 核心引擎

- **40+ LLM provider**、32 内置工具、`xd://` 设备扩展、prompt 工程持续调优。
- **LSP** 接线每个写操作（重命名/引用/代码动作）、**DAP** 调试器驱动。
- **task 子智能体**（并行扇出、IRC 协调、worktree 隔离、schema 验证输出）、**hashline** 内容哈希编辑、**hindsight** 会话记忆、**ACP** 编辑器驱动、**collab** 协作（含 musepi 定制：LAN/隧道/Tailscale serve 自持 relay、明文访客模式）。
- **snapcompact** 压缩策略（对话渲染为位图帧给视觉模型）、**magic keywords**（ultrathink/orchestrate/workflowz）、**TTSR** 流式规则注入。

## 📸 截图

| 欢迎页 | 会话（bash 卡片） | 设置 |
|---|---|---|
| <img src="docs/screenshots/gui-welcome.png" width="420" alt="欢迎页"> | <img src="docs/screenshots/gui-session.png" width="420" alt="会话与 bash 卡片"> | <img src="docs/screenshots/gui-settings.png" width="420" alt="设置面板"> |

## 🚀 快速开始

### 一键安装

```sh
curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh
```

克隆到 `~/.musepi/repo` 并运行 `bun run setup`（workspace 安装 + natives + 链接），然后：

```sh
cd ~/.musepi/repo && bun run musepi
```

macOS / Linux / WSL。Windows —— 或手动构建 —— 从源码安装：

```sh
git clone https://github.com/MuseLinn/MusePi.git && cd MusePi
bun run setup && bun run musepi
```

选项：

- `--ref <tag|commit|branch>` — 固定某个 checkout
- `--source` — 从源码安装（默认；尚无预编译二进制）

## 下载（三种形态）

| 形态 | 获取方式 |
|---|---|
| 🖥️ **桌面客户端**（Electron GUI，应用内自动更新） | [macOS arm64 `.dmg`](https://github.com/MuseLinn/MusePi/releases/latest) · [Windows `setup.exe`](https://github.com/MuseLinn/MusePi/releases/latest) · [Linux `.AppImage`/`.deb`](https://github.com/MuseLinn/MusePi/releases/latest) — 到 [Release 页](https://github.com/MuseLinn/MusePi/releases) 取对应版本资产 |
| 📱 **Android 移动伴侣**（Capacitor，局域网配对） | [Release 页](https://github.com/MuseLinn/MusePi/releases) 的 `app-debug.apk`（`adb install -r app-debug.apk`） |
| ⌨️ **终端 TUI** | 上方 curl 安装脚本（macOS/Linux/WSL）装 `musepi` —— 或 `bun run setup && bun run musepi` 从源码（Windows/全平台） |

官网：<https://muselinn.github.io/MusePi/>（双语，含三种形态的下载指引）。

### 开发模式

需要 **Bun ≥ 1.3.14**（macOS 为主要开发平台；Rust 工具链用于 natives 构建）。

```sh
# 安装依赖 + 构建 natives + 链接 CLI
bun run setup

# 终端 TUI（上游 CLI 面）
bun run musepi          # 或 bun run dev

# daemon 服务（GUI 后端；GUI 启动时也会自动拉起）
bun --cwd=packages/coding-agent src/cli.ts serve --port 8300

# 桌面 GUI（构建 + 启动 Electron）
bun run --cwd=packages/gui desktop
```

`musepi` 子命令：`launch`（默认对话）、`serve`（daemon）、`acp`、`agents`、`commit`、`config`、`join`、`models`、`plugin`、`say`、`share`、`setup`、`shell`、`stats`、`update`、`completions` 等。

配置目录为 `~/.musepi/`（品牌化差异；`PI_CONFIG_DIR` 可覆盖）。

## 🏗 架构

```
┌──────────────┐    JSON-RPC (collab-proto)    ┌──────────────────────┐
│  Electron GUI │ ◄────────────────────────────► │  musepi serve (daemon)│
│  packages/gui │   WS 事件流（journal/view）    │  packages/coding-agent│
│  + desktop-web │                               │  AgentSession 宿主    │
└──────┬───────┘                               └──────────┬───────────┘
       │                                                    │
       │  pet.html / bubble.html / pin.html                 │ agent 引擎
       │  （桌宠 / 气泡 / 置顶窗口）                          ▼
       │                                         packages/agent · ai · tui
       │                                         natives（Rust N-API）
       ▼
  desktop-web：transcript / tool-render / widget / i18n（zh-CN/en-US 域化词表）
```

| 包 | 说明 |
|---|---|
| `gui` | Electron 桌面应用（主界面 + 桌宠/气泡/置顶多窗口、xterm、pdf.js、受管浏览器桥） |
| `desktop-web` | GUI 渲染核心（transcript、工具卡、widget 系统、i18n）兼协作 Web UI |
| `coding-agent` | CLI 入口（`musepi`）、daemon 服务端、slash/bash 命令、工具实现 |
| `collab-proto` | GUI ↔ daemon 传输协议（WS 帧、加密、链接） |
| `agent` / `ai` / `tui` / `catalog` / `wire` / `utils` / `hashline` / `snapcompact` / `mnemopi` / `stats` | 上游派生的 agent 引擎 / provider 注册表 / TUI / 模型目录 / wire 类型 / 工具库 |
| `sdk` | 客户端 SDK（MaterializedView、会话流事件契约） |
| `natives` | Rust N-API 绑定（Bazel/cargo 构建，macOS LINKEDIT 对齐后处理） |
| `swarm-core` / `swarm-extension` / `tool-select` / `browser-relay` / `metaharness` | 子智能体编排 / 工具选择 / 浏览器中继 / harness 工具 |

关键契约文档：

- **GUI 设计规范**：`docs/gui-design.md`（布局/token/动效/组件模式/桌宠视觉风格）
- **GUI 实现笔记**：`docs/gui-implementation.md`（daemon RPC 形状、IPC、踩坑、验证工作流）
- **widget 设计系统**：`docs/widget-design-system.md`
- **协作**：`docs/collab.md`（含 musepi LAN/隧道定制）
- **上游同步**：`UPSTREAM.md`（同步基线 v17.2.12、PURE/THREE_WAY/NEW/MANUAL 分类、验证记录）

## 🛠 开发

```sh
bun run setup            # 安装 + natives 构建 + 链接
bun run build            # workspace 构建（含 GUI dist）
bun run check            # 并行 check:ts（tsgo）+ check:rs（cargo）
bun run test             # bun scripts/ci-test-ts.ts local
bun run lint / fmt       # biome + rustfmt
```

测试注意（记录在 UPSTREAM.md 验证节）：

- 全量测试建议 `MUSEPI_TEST_CONCURRENCY=4`（默认并发 8 在本机内存吃紧）。
- Rust bucket 需要 `cargo-nextest`，且在 `~/.cargo/bin` 前置的 PATH 下跑。
- 改 `desktop-web` 后必须重建 GUI（`bun run --cwd=packages/gui build`）再验证——浏览器会缓存旧 bundle。
- GUI/daemon E2E 隔离：`PI_CONFIG_DIR=musepi-test` 起测试 daemon（:8310）；测试 GUI 用 `--user-data-dir=/tmp/...` + `MUSEPI_MANAGED_BROWSER_PORT=9231` + `--remote-debugging-port=9223`，puppeteer 只连 **9223**（CDP 端点）。

提交习惯：`git commit --no-verify`（husky/biome 基线问题）；natives 变更后需重建（`bun run build:native`，macOS LINKEDIT 对齐自动）。

## 📱 移动端壳

- **Capacitor Android 应用**（`packages/mobile` + `desktop-web` 移动入口）：沉浸式 edge-to-edge（自定义 InsetsPlugin）、QR 扫码配对（jsQR，无 GMS 依赖）、时间感知问候 + 轮换提示、建议 chips、44px 触控目标、Android 返回键逐层展开、旋转过渡、三合一发送控件（点阵 bloom 反馈）、盲文点阵工作指示器、会话归档（localStorage 桌面 GUI parity）。
- **HarmonyOS WebView 壳**（`packages/harmony`）：ArkTS `Web` 组件加载同一 bundle（native insets、badge、`musepi://` 深链、键盘 inset）。
- **PWA**：service worker 离线连接壳。
- **远程会话管理**（dsh-mobile-remote parity）：guest 可创建/删除/重命名会话、停止远端正在运行的 turn（`session.abort`）；agent 可主动发起分享（collab tool，分级审批）。

## 📦 打包与发布

### 桌面应用（macOS）

```sh
bun run --cwd=packages/gui pack          # 构建 + electron-builder + 签名
bun run --cwd=packages/gui pack:dir      # electron-builder dir 构建 + 签名（不重新构建）
```

产物：`release/mac-arm64/MusePi.app`。`pack` 脚本做 **ad-hoc 签名**（本机可运行）。**正式分发**需要 Developer ID Application 证书 + Apple 公证——macOS 26 对未签名/未公证应用的多项能力（通知等）直接拒绝。CLI 二进制的签名/公证流程见 `docs/macos-signing-notarization.md`（hardened runtime + `notarytool`）；与裸 Mach-O 不同，`.app` bundle 还可以 **staple**（公证票据内嵌，离线也能通过 Gatekeeper 校验）。

### 桌面应用（Windows / Linux）

`gui-release.yml` 在 tag 推送时按平台构建 Electron 应用：macOS arm64（`dmg` + `zip`）、Windows x64（NSIS 安装器，逐用户免管理员默认路径）、Linux x64/arm64（`AppImage` + `deb`）。发布 `v*` tag 自动上传所有平台工件 + OTA 清单（`latest*.yml`，tag 含 `-beta` 时走 beta 通道）+ `update-manifest.json`（应用内更新检查）。

### 移动端（Android）

同一 workflow 的 `package_mobile` job 构建 Capacitor 应用：desktop-web 编译 → `cap sync` → Gradle `assembleDebug`。Debug APK 附在 Release 页；`adb install -r app-debug.apk` 安装。HarmonyOS 壳（`packages/harmony`）在 DevEco Studio 中构建。

### CLI

npm/GitHub 发布流水线继承上游（`ci:release:*` 脚本）；`musepi update` 自更新已安装的 CLI。

## 📚 文档

- `docs/`：95+ 篇（GUI、provider、工具、hook/扩展/技能、LSP/DAP、collab、compaction、ACP、设置、i18n 等）
- `docs/gui-design.md` / `docs/gui-implementation.md`：GUI 活文档（改实现时同步）
- `UPSTREAM.md`：上游同步备忘（版本涟漪、手动解决、踩坑）

## 上游同步

MusePi 跟踪 OMP 上游（当前基线 **v17.2.12**，musepi 应用版本 0.4.6）。同步按 `git diff -M` 分类为 PURE（重命名复制）/ THREE_WAY（三方合并）/ NEW / MANUAL，包名 `@musepi` → `@musepi` 重命名；musepi 定制文件（GUI、daemon、i18n、collab LAN/隧道、computer-use 事件透出、settings locale 等）按 OVERLAP 保留 ours + 并入 theirs。完整流程见 `UPSTREAM.md`。
