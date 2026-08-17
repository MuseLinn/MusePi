# Windows 开发环境（Windows Development Setup）

MusePi 以 macOS 为主开发平台，但 CLI、daemon 与 Electron GUI 均可在 Windows 上构建运行。
本文档覆盖：拉取最新代码、安装依赖、补齐 `harness-engineering` 文件夹下的参考 checkout。

## 1. 前置依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.3.14 | 运行时 + 包管理 + 构建 |
| [Rust](https://rustup.rs) | stable（nightly 亦可） | `packages/natives` 原生绑定（Bazel） |
| [Git](https://git-scm.com) | ≥ 2.30 | 拉取 / 参考 checkout |
| Node.js（可选） | ≥ 22 | 仅部分独立项目（pi / pi-muselinn-harness）用 npm |

## 2. 拉取 / 更新 musepi-omp

```powershell
# 首次
git clone https://github.com/MuseLinn/MusePi.git musepi-omp
cd musepi-omp
bun run setup          # bun install + natives 构建 + link CLI

# 已有 checkout：拉取更新
cd musepi-omp
git pull origin master
bun install
```

验证：`bun run musepi` 应出现 TUI；`bun --cwd=packages/coding-agent src/cli.ts serve --port 8300` 应启动 daemon。

## 3. 补齐 harness-engineering 参考 checkout

`harness-engineering/` 是本地工作文件夹（非 git 仓库），参考 repo 只读、用于 UI/设计对照。
Windows 侧缺少的参考 repo 用下面的命令补齐（与 macOS 相同的分支/tag/过滤配置）：

```powershell
# 建议放在 harness-engineering/ 下执行
$root = $PWD

# ── UI/设计对照（只读参考）──
git clone --branch dev --filter=blob:none --depth 1 https://github.com/anomalyco/opencode.git opencode
git clone --branch v1.18.1 https://github.com/btriapitsyn/openchamber.git openchamber
git clone --filter=blob:none https://github.com/GCWing/BitFun.git bitfun          # 部分克隆（blob:none）
git clone --depth 1 https://github.com/proma-ai/Proma.git proma
git clone --depth 1 --branch v0.11.3 https://github.com/craft-ai-agents/craft-agents-oss.git craft-agents
git clone --depth 1 https://github.com/DavidHDev/react-bits.git react-bits        # ~221M

# ── 独立项目区（同 macOS 布局）──
git clone https://github.com/can1357/oh-my-pi.git oh-my-pi
git clone https://github.com/earendil-works/pi.git pi
git clone https://github.com/MuseLinn/pi-muselinn-harness.git pi-muselinn-harness
git clone https://github.com/MoonshotAI/kimi-code.git kimi-code
git clone https://github.com/xai-org/grok-build.git grok-build
git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness

# ── musepi-recover：MusePi 旧布局快照（workspace 化之前的 npm 布局）──
git clone https://github.com/MuseLinn/MusePi.git musepi-recover
git -C musepi-recover checkout --detach c9e9d28c
```

> `ui-references/`（MusePi 桌面 GUI 截图 + 元素集）是本地设计资产、无远端：从 macOS 拷贝
> （如 `scp -r ui-references unive@<win-host>:"C:/Users/unive/projects/harness-engineering/"`）
> 或从已有的 Windows 机器同步。

### 参考 checkout 用途速查

| 目录 | 对照什么 |
|---|---|
| `opencode/` | 桌面侧栏/对话 UI 惯例（dev 分支） |
| `openchamber/` | 设置布局（flat 侧栏 + 内容列）、对话框/键盘优先级（tag v1.18.1） |
| `bitfun/` | 桌宠帧动画（steps() 数学）、素材优先实况拼图 |
| `proma/` | 图片附件 lightbox、Reasoning 折叠（--depth 1 浅克隆即可） |
| `craft-agents/` | 富图片预览层（lightbox 缩放/平移、composer chips、PlatformContext readFileDataUrl） |
| `react-bits/` | 动效组件源（ChromaGrid、SpotlightCard、BlurText、BorderBeam…） |

## 4. Windows 注意事项

- **natives 构建**：`bun run setup` 会走 Bazel 构建 `packages/natives`；Windows 需要 Rust 工具链与
  Bazel 所需依赖（MSVC Build Tools）。构建失败时可先用 `bun run dev`（TUI 模式）开发，GUI 依赖 natives。
- **通知**：Windows 上 Electron `Notification` 直接可用（无 macOS 的未签名限制），无需 ad-hoc 签名。
- **vibrancy 玻璃**：macOS 的 `under-window` vibrancy 在 Windows 不可用，GUI 自动回退自绘玻璃
  （`pet-window.css` 的 transparent-window 配方），无需处理。
- **测试**：`bun run check`（tsgo 类型检查 + biome）与 `bun run test` 跨平台一致。
