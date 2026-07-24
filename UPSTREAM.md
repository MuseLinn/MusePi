# UPSTREAM.md — pi 上游同步记录

## 基点（pin）

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/earendil-works/pi |
| 基点 commit | `ff992261e2ec349e4257a59d052076355ca0b18b` + 2026-07-21 cherry-pick 9 个（见下"同步日志"） |
| 基点时间 | 2026-07-20T20:00:14Z（首次 pin）；2026-07-21 同步至 v0.81.1 选定项 |
| 对应 npm 版本 | `@earendil-works/pi-coding-agent@0.80.10` + 0.81.1 选定修复（extension peer dep `>=0.80.0` 线） |
| License | MIT（fork 保留原 LICENSE） |

## 同步日志

### 2026-07-21 → v0.81.1（提前窗口：K3 修正 + compaction 重试）

核查发现 0.81 发布说明中的大部分项目（#6844/#6790/#6764/#6730/#6727/#6671/
#6793/#6854/#6812/#6865/K3 thinking levels/full provider extensions）**已包含在
基点 ff992261 中**（基点仅比 0.81.0 早一天）。实际 cherry-pick 9 个：

- `4185d398` brace-expansion 5.0.7（含 lockfile）
- `6a4b52d7` ai: 构建前校验生成的模型数据（根 package.json 冲突：build 脚本并入 musepi 路径 + 新增 build:offline）
- `9ddde88d` coding-agent: 优先使用较新的生成模型目录
- `3f29a78c`+`b1c89b5a`+`273fb67f`+`ea1cfa35` compaction/branch-summary 失败走重试策略（#6901 套件，snapcompact 的 default LLM 摘要路径受益）
- `0f6eaf44` K3 compat: thinkingFormat=openai + supportsReasoningEffort
- `42027bf6` agent: 恢复 streamFn 扩展兼容（#6915；CHANGELOG 冲突取上游版）

验证：全量 build 绿；core 185 + tui 712 + musepi 套件 64 断言绿；K3（kimi-coding/k3）
冒烟 `k3-ok`。

**明确跳过**（记录在案，后续需要再评）：`9e7582aa` SQLite 会话存储（#6594，
大特性）、`8495f9d0` orchestrator→server 改名（大 rename，会扩大冲突面）、
llama.cpp/Qwen provider/发布归档。

### 2026-07-22 → 品牌分离 + 补 pick `b1425041`

- 品牌分离：`piConfig = { name: musepi, configDir: .musepi, title: MusePi }`，
  全 workspace 版本线 0.80.10 → 0.1.0（install-lock 校验要求 lockstep）；
  首次运行从 `~/.pi/agent` 迁移 auth/settings/models/keybindings 四个文件；
  `musepi.updateCheck`（默认 false）门控 pi.dev 更新提示。
- 补 pick `b1425041`（目录刷新移出启动，此前标记跳过）：冲突仅在
  interactive-mode 的版本检查块，已与新 updateCheck 门控合并；
  CHANGELOG 条目 HEAD 侧已存在，去重。
- 验证：`npm run check` 绿（biome/pinned-deps/ts-imports/shrinkwrap/install-lock/
  tsgo/browser-smoke）；全量 build 绿；musepi core 测试绿（248）；
  coding-agent vitest 与基点持平（残余失败均为该 Windows 机器既有环境失败，
  基线对比 33↔33）；HOME 隔离冒烟：`--version` → `MusePi 0.1.0`，
  迁移四文件且排除 extensions/sessions/npm，updateCheck 默认 false。

### 2026-07-22 → 初版（0.1.0）发布准备（草稿，待 push 后确认）

- main 累积 5 个未 push 提交：`710d368c` 身份三连（MusePi 品牌/config home/
  首迁/update-check 门控）、`00017d47` 目录刷新延后、`6a1f3372` 测试对齐、
  `2b8de88f` 镜像 harness plan+goal 修复（dbc917c、95bc30c）、`7adeea8a`
  kimi-k3 原生视频理解（video_url wire + read 工具视频路径 + 能力声明）。
- 新增 `.github/workflows/ci.yml`（push/PR：npm ci --ignore-scripts →
  npm run check → build:offline → musepi 套件 + pi-ai 测试；Windows job
  continue-on-error，33 个已知环境基线失败未修）与
  `.github/workflows/release.yml`（tag v* → build-binaries.sh 六平台 bun
  交叉编译 → GitHub Release）。
- README 改写为 MusePi 品牌（定位、上游关系、构建说明、CI badge）；
  GitHub Pages 未配置，记为 TODO。
- 待办：push main、打 tag `v0.1.0` 触发首个 release、确认仓库 secrets
  无额外需求（GITHUB_TOKEN 默认权限即可）、Pages source 后续再定。

### 2026-07-22 → 品牌化最后一公里：CLI 改名 + 自有 update 通道

- 二进制/CLI 改名 `pi` → `musepi`：package.json `bin`、`scripts/build-binaries.sh`
  产物名（`musepi-<platform>.tar.gz/.zip`，内部可执行文件名同步）、
  `scripts/local-release.mjs` shim/归档名、`pi-test.*` → `musepi-test.*`、
  release workflow 冒烟路径、AGENTS.md/README 引用同步。内部包名
  `@earendil-works/*` 与 npm-shrinkwrap/install-lock 由生成器刷新，不动。
- update 通道切换到 MuseLinn/MusePi GitHub Releases
  （`api.github.com/repos/MuseLinn/MusePi/releases/latest`，tag `vX.Y.Z`
  与 VERSION 比较）；`musepi.updateCheck` 默认改为开启。TUI 提示
  `MusePi update available: x.y.z, run musepi update`，release notes 链接
  指向对应 release 页。
- `musepi update`（self）不再走上游 npm self-update（会装回原版 pi），
  改为"提示 + 打开 release 页"最小闭环；extensions/models 更新路径不变。
  `pi`/`musepi` 仍可作为 `self` 的位置参数别名。
- 删除死代码 `packages/musepi/core/src/ask/types.ts`（全仓无引用）。
- 新增 opt-in `musepi.compat.loadPiExtensions`（默认 off）：开启后额外
  自动加载 `~/.pi/agent/extensions`。默认关是因为 pi 扩展可能与 MusePi
  原生特性冲突（首迁本就有意排除 extensions）。
- 测试：version-check 改写为 GitHub API 形态（tag 解析、UA、错误/离线
  门控）；新增 `@musepi/core` settings-schema 测试（updateCheck/compat
  门控）与 coding-agent compat 扩展加载测试。

## 同步策略（pin + 月度 cherry-pick，不做持续 rebase）

1. **pin**：fork 以基点 commit 为准，渲染层改动全部落在 `packages/musepi/` 与
   `packages/coding-agent` 的 TUI 层（见下"冲突面"）。
2. **月度窗口**：每月检查一次上游 release，只 cherry-pick 两类变更——
   - agent loop / 工具执行的正确性修复
   - extension API 新增（生态兼容需要，pi-muselinn-harness 及第三方扩展依赖）
3. **按冲突面过滤**：上游 `pi-tui` 渲染层变更**不再一律忽略**——W1 起
   `packages/tui/src/components/editor.ts` 有我们的 4 钩子补丁（historyFilter/
   onRecall/onHistoryDraftSave/Restore），编辑器相关修复需手工合并。其余
   pi-tui 渲染变更仍可忽略（已被 `packages/musepi/renderer` 替换）。
   网站/文档/市场变更一律忽略（除非影响构建）。
4. **冲突面控制**：MusePi 的改动集中在 TUI 层与 `packages/musepi/` 子树，上游演进
   集中在 agent/工具层，文件交集天然小。若某月上游大改 extension API，优先保
   兼容层，必要时发 MusePi minor 公告。

## 结构约定

- `packages/coding-agent` — pi 核心（agent loop、模型路由、会话、工具执行）。
  **改动只允许在 TUI/渲染接缝处**，方便 cherry-pick。
- `packages/musepi/` — MusePi 自有代码（renderer、core 原生集成、配置系统、
  transcript 层）。上游永不相交。
- extension API 兼容层：`packages/coding-agent` 的扩展加载入口保持
  `@earendil-works` 公开 API 表面不变（termdraw、pi-muselinn-harness 等已装
  扩展可直接加载）。

## 验收线

开仓不等于宣传：0.0.x pre-alpha，直到自研渲染器跑通一轮完整会话
（输入 → 流式输出 → 工具调用 → box editor）。
