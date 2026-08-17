# 上游同步备忘（UPSTREAM）— 已归档

> **归档声明（2026-08-17）**：MusePi 自此为**独立上游**，oh-my-pi 不再作为同步上游。
> 本文件保留为历史同步记录（2026-08-13 v17.3.0 起至 2026-08-15 选择性移植为止）。
> 此后 oh-my-pi / Pi / DSH / opencode 等一律视为**参考吸收来源**（按需吸收 bugfix
> 与 feature，无版本对齐义务）；MusePi 自己的版本、行为与文档即权威。

## 同步状态（历史记录，截至归档）

- 数据源：本地 oh-my-pi 仓库（`/Users/muselinn/harness-engineering/oh-my-pi`），已 fetch 全部 tags
- 当前同步基线：**v17.3.0**（2026-08-13 完成，502 commits / 828 files / +46,389 / −10,977 原始 diff；**/agents 全屏 hub 重设计**（agents-hub.ts 1453 行替换 agent-dashboard.ts 1254 行）、**per-agent advisor**（移除全局 advisor.subagents → frontmatter `advisor` / `task.agentAdvisor`）、**/usage 官方配额**（OpenCode Go 真实用量替代估算）、**/compress 语义压缩命令**、**omp.rename 指针**（npm 包改名准备）、**session-title 生成回归修复**、**LSP 多项修复**（overlay 隔离/rename 回滚/diagnostics 语义）、**/shake 保留工具结果尾巴**、Grok 4.6 thinking-loop guard、Nix 构建支持（musepi 不采用）；见下方「验证记录（v17.3.0 移植）」
- 上次基线：v17.2.12（2026-08-09 完成，60 commits / 641 files / +88,543 / −87,950 原始 diff；**shell builtins 大重构**——`crates/vendor/brush-builtins` + `crates/pi-shell` 的 coreutils/moreutils 等 50+ 模块合并为第一方 `crates/pi-builtins`，vendor/uu-* 全部移除，crates 净 −96k 行；slash-command 注册表拆分为 builtin-{modes,session,control,lifecycle,marketplace,collaboration,completions}.ts 7 模块 + 统一 registry；新增 /cleanup 命令（scripts/cleanup-scan.ts）；若干修复）
- musepi 应用版本：**0.4.0**（独立于上游版本号，见「版本说明」）
- ⚠️ **musepi 定制（2026-08-10，基线 v17.2.12 之后）**：`packages/coding-agent/src/tools/computer.ts` + `computer/{protocol,supervisor,worker}.ts` 含 ours 定制——**ComputerInputEvent 输入事件透出**（worker 的 Win/El 输入方法经 supervisor `run(…, onInput)` → computer.ts `_onUpdate` 推 `details.inputEvents`，驱动 GUI computer-use 光晕覆盖层的目标高亮）。上游同步时这 4 个文件按 OVERLAP 处理：保留 ours 事件透出 + 并入 theirs 变更；`test/computer-input-events.test.ts` 为 musepi 新增（NEW，无冲突）。参考：docs 的 computer-use.md/computer.md 同属 ours 深度定制

## 选择性核对（v17.3.1–v17.3.4,2026-08-15 决策）

> **决策（用户拍板）**：不再暴力全量移植。改为文件级选择性/手动核对合并,只吸收上游 bugfix 与必要 feature,版本不升。

> **执行结果（2026-08-15）**：141 files changed, +5117/−1438。PURE 复制 94(src+test,终态+rename)+ OVERLAP 3-way 28(21+7 gap,含冲突手解 9:defs.bzl/alibaba test/config.ts/helpers.ts/agent-session.ts/gemini-cli.ts/models.json 9 块/executor.ts/acp test)+ ABSENT 补 2(claude-paths.ts 无需品牌化,issue-8542-repro.test.ts)+ skip-only src 补 19(ptree.ts 2 参 kill 等)。9 个受影响包 check:types 0 错误;CLI 冒烟 `musepi/17.3.0`。**测试**:移植修复相关 300+ 断言通过;失败均为 Windows 环境性(上游 CI=linux):terminal-appearance kitty push(win32 ConPTY)、foreign-session-stores(盘符冒号路径 ENOTDIR)、sdk-tool-activation(EBUSY 句柄)、read-multi-range/read-edit-out-of-cwd/browser-launch(path.join 反斜杠)、remote-compaction(既有挂起,基线确认)、status-line-vcs-refresh(有界轮询 >300s,单测全过)。claude-plugins 测试夹具 `.omp`→`getPluginsDir()` 品牌化修复(38/38 过)。**musepi 定制适配**:job-manager register/AsyncJob.type 联合补 `agnes-video`;gemini-cli 删除上游已移除的 ANTIGRAVITY_SYSTEM_INSTRUCTION 注入与 re-export。

### mupdf-native/pdf 移植(2026-08-15,04fab5ecb4 + a3c15d2dec)

- 新增 crates/pi-natives/src/pdf.rs(**pdf-inspector 1.14.2 / lopdf 纯 Rust,无 C 依赖**,pdfToMarkdown N-API)+ read-pdf.ts(Chromium PDF 插件页截图)
- 删除 mupdf-wasm 管线:embed-mupdf-wasm.ts、mupdf-wasm-embed.ts、6 个 markit pdf 转换器(columns/extract/grid/headers/render/types)、read-pdf-images.ts(+test)——净 −3.6k 行 TS
- 3-way 合并(全部自动无冲突):read.ts/markit.ts/bundle-dist.ts/build-binary.ts/lib.rs/index.d.ts/markit pdf index.ts——musepi 定制全部保留
- Cargo:workspace 依赖 pdf-inspector = "1" + pi-natives 引用;Cargo.lock 更新(cargo metadata 自动)
- natives 包装:index.js 加 pdfToMarkdown(rebuild 时 build-bindings 自动重生 75 exports)
- 重建:win32-x64-modern 563s 增量(冷编 pdf-inspector 链)/ darwin-arm64 ~8min 增量 / **linux-x64-modern 13m41s 全量冷构建(WSL Ubuntu,689+ crates)**——三平台哨兵均 17_3_4,linux 上 native 加载 + pdfToMarkdown function 验证通过,62/62 测试绿
- WSL 构建路径(musepi-linux,WSL Ubuntu 18 核):gh cli 2.97 device flow 认证成功,但 **WSL→GitHub 对该仓库 git 长连接静默丢包**(ls-remote/clone 全卡,小仓库 cli/cli 秒通;fake-ip 198.18.x + TUN 代理链路掐大请求),走 Windows 代理也卡 → 用 **git bundle**(Windows 生成 107MB 全历史,WSL clone)→ remote 指 https;后续 WSL pull 若仍卡可复用 bundle
- 验证:Windows pdf 相关 61+7 测试绿;macOS 62/62 绿;**win32 守卫 1 个**:read-pdf-rendering 的冒号字面路径测试(NTFS 保留冒号,posix-only)
- ⚠️ 教训:git add -A 会把工作区里**另一会话遗留的未提交删除**(packages/swarm-extension 整目录,用户有意删)一并提交;误恢复后已按用户要求重删(533426222)。提交前先核对 git status 的删除清单

### 版本涟漪 v17.3.4 + MusePi 0.4.1(2026-08-15)

- 14 个 workspace 包 version 17.3.0→**17.3.4**(agent/ai/catalog/coding-agent/hashline/mnemopi/natives/omptype/snapcompact/stats/swarm-extension/tui/utils/wire);root catalog 13 条同步;sdk 的 @musepi/pi-wire 依赖同步
- **@musepi/pi-natives 哨兵 17.3.0→17.3.4**:crates/pi-natives/src/lib.rs js_name + packages/natives/native/index.js + index.d.ts;win32 addon 本机重建(bazel-natives.ts host → 本地 napi build);darwin/linux 需对应主机/交叉构建
- **MusePi 应用 0.4.0→0.4.1**:src/musepi.ts MUSEPI_VERSION + src/musepi/branding/index.ts productVersion + packages/gui/package.json + gui/update-manifest.json;TUI 标注 `0.4.1 (OMP 17.3.4)`(cli.ts/main.ts displayVersion 自动拼接),GUI system.meta 派生显示
- bun.lock:workspace 版本 + catalog + sdk 依赖替换(注意:全量 sed 会误伤第三方包——`lint-staged@17.3.0` 被改成 17.3.4 后 npm 404,已还原;只应替换 @musepi 与 workspace version 行);`bun install --frozen-lockfile` 通过(748 installs 无变化)

### 测试清理与平台适配(2026-08-15)

- **孤儿测试移除 5 个**(上游已删、musepi 保留):browser-tab-evaluate.test.ts、eval/js-context-manager.test.ts、utils/markit-mupdf-warnings.test.ts、catalog/test/fixtures/models-lazy-provider-cache.ts **+ catalog/test/models-lazy-provider-cache.test.ts**(初查漏网——test 经 `import.meta.dir + "/fixtures/…"` 运行时读 fixture,静态 import 查不出;已 `git rm` 两个)
- **bundled-reference-laziness test/fixture 配对补齐**:fixture 已随 skip-only 批次移植为 v17.3.4(输出改走 stdout),test 仍是 v17.3.0(读 resultPath 文件)→ JSON.parse("") 必炸;已补移植 v17.3.4 test(读 stdout),catalog 563/563 全绿
- **Windows 环境性测试适配**(上游 CI=linux,win32 行为差异):
  - terminal-appearance kitty push:win32 走 ConPTY 分支推 `>1u`/`>3u`,测试期望集合扩为两种分支(契约=单推单弹)
  - browser-launch:darwin/linux 候选路径 `path.join`→`path.posix.join`(实现级修复,候选路径本就是 posix 语义)
  - read-multi-range/read-edit-out-of-cwd:期望路径 `path.join`→`path.posix.join`(实现输出恒正斜杠)
  - sdk-tool-activation:afterAll 先 `modelRegistry.authStorage.close()` 再删目录(Windows 不能删打开中的 SQLite);temp.ts 清理重试窗口 2s→5s
  - foreign-session-stores:`.projects/<encoded-cwd>` 布局 win32 盘符冒号不可建目录(生产代码 posix-only),4 个布局依赖测试 `describe.skipIf(process.platform==="win32")`
- 汇总:25 个移植+适配测试文件 684 pass / 7 skip / 0 fail(mcp-http-transport 偶发并发抖动,隔离 10/10);CLI 冒烟 `musepi/0.4.1 (OMP 17.3.4)`

### 三平台验证(2026-08-15)

| 平台 | 适配测试(6 文件) | remote-compaction | status-line-vcs-refresh | natives |
|---|---|---|---|---|
| Windows x64(本机) | 78 pass / 6 skip | 挂起(Windows 特有,pre-port 亦挂) | >300s(NTFS 轮询慢,单测全过) | win32-x64-modern 17_3_4 重建,51/51 |
| WSL Ubuntu(linux x64) | 131 pass / 0 fail | 47/47(4s) | 14/14(3s) | — |
| ARM macOS(muselinn@100.73.130.97) | 129 pass / 2 skip | 47/47(3s) | 14/14(2s) | darwin-arm64 重建中(17_3_0→17_3_4) |

- mac 环境事实:gh cli 已装但 token 失效(device flow 重登:`gh auth login -h github.com --web`);git remote 曾切 ssh 但 key 未授权 GitHub → 改回 https + `gh auth setup-git`;mac 无 timeout 命令;磁盘 21Gi 剩余
- 版本推送:commit f968ac4ba 已推 origin/master,三端 checkout 一致

### 跳过项分析与后续方案(2026-08-15 记录)

| 上游提交 | 内容 | 规模 | 方案 |
|---|---|---|---|
| 04fab5ecb4 mupdf→native pdf | 删 7 个 markit pdf TS 转换器 + embed-mupdf-wasm.ts + read-pdf-images.ts(−3.6k 行),新增 crates/pi-natives/src/pdf.rs(Rust 原生渲染)+ read-pdf.ts | 42 files +1154/−3621 | 移植全部文件 + pdf.rs + Cargo 依赖 + **natives 全平台重建**;musepi 收益:PDF 读取走原生、省 mupdf-wasm 链路。Effort 中(重建占大头) |
| a3c15d2dec pdf 截图 | read-pdf.ts 截图渲染 + read.ts 接线 + 测试 | 5 files +224/−35 | 随 04fab5ecb4 一起做 |
| ad318c7572 docker 管道 | install-tests/*.dockerfile + 根 Dockerfile + build-bindings.ts 容器化支持 | 11 files +183/−39 | 建议做(纯移植):让 linux addon 构建可容器化,配合 WSL/CI 出 linux-x64/arm64 |
| 28997c0d46 transcript 重构 | ui-helpers.ts 重组 + large-session.jsonl fixture 重写 + render-initial-messages 测试 | 5 files +1152/−1083 | 低风险,ui-helpers 已随移植到位;补 fixture+测试即可 |
| b279db1790 测试重构 | 263 测试文件去 sleep/polling,确定性等待 | 263 files +4604/−6626 | 机械但量大;建议 natives/pdf 稳定后分批做,注意与 win32 适配交互 |

### natives 平台矩阵与交叉编译(2026-08-15)

- bazel-natives.ts 目标:`linux-x64-baseline/modern`、`linux-arm64`、`linux-musl-x64/arm64`、`darwin-x64/arm64`、`win32-x64-baseline`;**无 win32-arm64 目标**
- **linux-x64 主机可交叉构建**:`linux-all` 聚合 = linux-arm64 + musl×2 + x64×2 + **win32-x64**(msvc toolchain 用 clang-cl+xwin)
- **darwin 只能 mac 主机**(darwin-all);win32 主机不能用 bazel,`host` 伪目标委托本地 napi build(cargo,build-bindings.ts)
- **ARM Windows(win32-arm64)**:上游/当前均不支持,需新增 bazel target + MSVC ARM64 交叉工具链,或 cargo `--target aarch64-pc-windows-msvc`(x64 Windows 主机 + VS ARM64 组件)
- 验证平台:本机 Windows x64(win32-x64 重建中)、WSL Ubuntu(linux 端 + 交叉)、muselinn@100.73.130.97 ARM mac(darwin-arm64,需 SSH key 授权:`ssh-copy-id muselinn@100.73.130.97`)




- 上游现状:oh-my-pi **v17.3.4**(2026-08-14 tag);musepi 基线 v17.3.0
- 差异规模:96 commits(43 fix / 7 feat)/ 697 次文件触碰(76 个带文件提交)
- 文件级评估(musepi HEAD vs 上游 v17.3.0,rename 归一后):**PURE 472**(musepi 未定制,可直接复制)/ **OVERLAP 209**(musepi 定制,需 3-way)/ **ABSENT 16**
- 移植范围决策:**只搬 src/test/build 文件**;跳过 CHANGELOG.md、docs/*.md、package.json、bun.lock、Cargo.lock、MODULE.bazel.lock(版本涟漪,选择性移植不升版本)
- 明确跳过(上游 feature 立项):`04fab5ecb4` mupdf→native pdf(需 natives 重建+新 pdf.rs/read-pdf.ts)、`a3c15d2dec` pdf 页截图渲染、`ad318c7572` docker 构建管道、`b279db1790` 测试去 sleep 化重构、`5dd0aca4b8` markit 测试套件移除、`28997c0d46` transcript 渲染重构;`834002adc5`(foreign alias→binary update)上游已回滚,跳过
- PURE 执行方式:`git show v17.3.4:<file>` + `@oh-my-pi`→`@musepi` rename 写回工作树(终态复制,天然吸收同文件多个提交)
- OVERLAP 执行方式:`git merge-file --diff3`(base=上游 v17.3.0+rename,ours=工作树,theirs=上游 v17.3.4+rename),无冲突自动应用,冲突按「保留 musepi 定制 + 吸收上游」手解
- natives 注意:devicecheck.rs / cc.bzl / defs.bzl / BUILD.bazel 变更需重建 natives 才生效;`__piNativesV17_3_0` 哨兵不动(不涉及 lib.rs),重建前 prebuilt 仍可加载

### A 组(COPY,纯 PURE 机械复制,12 提交)

| 提交 | 内容 | 核心文件 |
|---|---|---|
| 5a0b2d460d | retry 退避 abort 规范化 | utils/src/fetch-retry.ts |
| 9286b72b4f | omptype TypeBox 约束关键字 | omptype/src/typebox.ts |
| a4adf17986 / 9d7e13a158 | unsafe schema run 属性/内嵌 schema 降级 | extensibility/legacy-typebox.ts |
| 2d0eb6c41e | OpenRouter deepseek-v4-pro-0813 档位 | catalog/src/model-thinking.ts |
| 85acb9ab70 | rpc 启动失败 stderr 透出 | modes/rpc/rpc-client.ts |
| 9b389d6006 | tui direct herdr clears 保留 | tui/src/tui.ts |
| 988ccc8268 / 42d5ca5128 | DeviceCheck GUI 会话守卫(+clippy 注释) | crates/pi-natives/src/devicecheck.rs |
| f5911781c2 | hashline 悬空 range separator | hashline/src/tokenizer.ts |
| fc9d40ca30 | mnemopi channelId 下全局行召回 | mnemopi/src/core/beam/recall.ts |
| d7a8583f02 | gemini fetcher 参数类型 | catalog/src/wire/gemini-headers.ts |

### B 组(人工核对,按模块)

- **natives/Windows**:246dda7f1c+2e2bf1f3a5(win32 MSVC CRT 静态链接 /MT,免 VC++ redist——bazel/defs.bzl+pi-natives/BUILD.bazel OV,msvc/cc.bzl PURE);a9075ae509(Windows 外部编辑器修复,external-editor.ts PURE);cf1ff14f5f(browser 探测限 linux,launch.ts OV)
- **providers**:b1ce77c109+fe33232298(gemini malformed/thought-only 恢复+retry 边界,google-gemini-cli.ts OV);e1d02c3b58(antigravity thinking-only STOP failover);c92ba97538+ce65a40539+c0394ba53d(Copilot 端点/超时/cache 按凭据,openai-compat.ts OV);335637de1e(北京 Token Plan 配额);ebcbdd5297+e5d59450c8+a821f4316a+e47b0207ac(usage cache 陈旧回放/动态超时,auth-storage.ts OV)
- **session/TUI**:6563b16424+e62814b4b0(git 分支 stat-poll,status-line/component.ts OV);6fc50c3e41(post-yield TUI 卡死,agent-session.ts+executor.ts OV);bb0314a5a1+9b389d6006(HerdR 闪烁,tui.ts PURE);bdbea3f7f3(orphan fences,markdown.ts PURE);3f5cb91068(迟到 DA 响应,terminal.ts PURE)
- **extensions/cli**:7463803c95(runtime mode 入 context,runner.ts OV);6980275a50+3749478239+4ce4874e78(allowlist 扩展工具/发现后校验,main.ts OV)
- **discovery/update**:3629464cf9+406306f972(CLAUDE_CONFIG_DIR/plugin cache 按 home,config.ts+helpers.ts OV,新文件 claude-paths.ts ABSENT 需品牌化);1d6d35bd24+219123244e+642d6c0b31(并发自更新临时路径/目标锁/所有权,update-cli.ts 全 OV 手解)
- **杂项**:a02f88994b(read hashline 头 workspace-relative);83d08936ae(MCP SSE 先初始化会话);2996f16a61(codex v2 compaction header,compaction-v2-streaming.ts OV)

### C 组(暂缓立项)

- 3ce33d436b Gemini Flash 模型(models.json OV 需手工并入 musepi 4 个自定 provider 块)
- 58f319912e google 动态版本发现+rate limit(建议与 B providers 一起做)
- 0d6a7146a3 browser scope allSettled/any(run-scope.ts PURE,小)
- 04fab5ecb4+a3c15d2dec mupdf native pdf(大工程,单独立项)
- ad318c7572 docker 管道(跳过)

## 验证记录（v17.3.0 移植）

- ✅ 分类（rename 归一后）：828 = PURE 590（复制+`@oh-my-pi`→`@musepi` rename）/ OVERLAP 143（77 无冲突自动 3-way；66 手动）/ NEW 89 / DEL 6
- ✅ 执行方式：沿用树级合并（`git merge-file --diff3`，base 归一化 @oh-my-pi→@musepi，ours=工作树，theirs=原始上游）；diff3 输出写回工作树后逐块解决冲突标记，最后全局 rename @oh-my-pi→@musepi（102 文件，排除 3 个合法文件）
- ✅ 手动解决要点（66 冲突）：
  - **agents-hub/agent-hub**：上游全屏 hub 重设计（agents-hub.ts 新 1453 行 + agent-hub.ts/renderer 小改）——musepi 无独立定制冲突（56 处 t() 在 agent-hub.ts 保留），agents-hub.ts 为 NEW 直接复制
  - **interactive-mode.ts**：goal 命令 ours t() i18n + theirs #openGoalMenu/#startGoalFromObjective(obj, input) 新签名——保留 ours i18n 与旧签名（行为不变），并入 copyLocalArtifacts import（/handoff 本地产物复制）
  - **agent-session.ts**：ours #sideChannelModel 定制 + 上游新增 servingModel（retry-fallback 归属模型）——两者并存；上游删除 retryFallbackModel API（TurnRecovery 重构），musepi 死 getter 一并移除
  - **update-cli.ts**：ours 常量（MuseLinn/MusePi repo）保留 + theirs NIX_STORE_DIR 行并入
  - **settings-schema.ts**：advisor.subagents 移除 → task.agentAdvisor（自动迁移）；musepi tuiOnly/sideChannelModel/busyEnter 定制 3-way 保留
  - **status-line/segments + user-message + collab/guest + codex-reset-fireworks + late-diagnostics**：musepi t() i18n import 保留（部分 import 粘连修复）
  - **sdk.ts**：ours bundled-skills（widget-design/musepi-help）保留
  - **prompts**：system-prompt/recap-user/scan-coordinator 等保留 ours（MusePi 品牌 + 中文定制）；computer.md/init.md/plan-mode-active.md/replace.md 取 theirs（上游精简/新内容，musepi 无实质定制）
  - **bazel-natives.ts**：buildWindowsHostAddon 恢复完整 body（ours win32 定制）+ 上游新 buildLocalHostAddon 并存
  - **ProjectsRoute.tsx**（stats）：musepi const columns 与 theirs useMemo 结构混拼修复（列数组结尾）
  - **package.json**：coding-agent 保留 @musepi 名 + 17.3.0；agent 重复 key 清理
- ✅ 版本涟漪：13 个 package.json 17.2.12→17.3.0（PURE 自动）+ coding-agent/swarm-extension 手动；collab-proto 17.2.8/swarm-core 17.2.2/tool-select 17.2.2/sdk 0.3.1 保留 musepi 自有版本；sdk 的 @musepi/pi-wire 17.2.12→17.3.0；root catalog 12 条 @musepi/pi-* 17.3.0 + 补 9 项缺失（linkedom/date-fns/lru-cache/chalk/arktype/@puppeteer/browsers/@xterm/headless/fast-xml-parser/header-generator——上游 root catalog 未含但 workspace 依赖引用 catalog:）；bun.lock 直接取上游 v17.3.0 + rename（`bun install --frozen-lockfile` 通过）；root workspaces 移除 python/robomp/web（musepi fork 已清理该目录）
- ✅ natives：crates/pi-builtins 5 文件（host/ifne/ls/pgrep/proc_match/sed）+ pi-natives lib.rs/shell.rs + pi-shell + vendor brush-core 2 文件；哨兵 `__piNativesV17_3_0`；重建中（cargo，LINKEDIT 对齐自动）
- ✅ 类型检查：20/21 包 check:types 0 错误（agent/ai/coding-agent/tui/utils/wire/catalog/omptype/hashline/snapcompact/mnemopi/stats/sdk/collab-web/gui 全绿）
- ⚠️ 修复的合并残留（类型检查暴露）：① interactive-mode goal 块 try/catch 错位（ours 段与 theirs 段拼接）② agent-session servingModel 插入缺 getter 闭合 ③ 多个文件 import 粘连（`} from "x";import { y }`——3-way 输出行拼接）④ tests 缺 getProjectAgentDir import ⑤ relay-server.ts TS2349（tls.Server|net.Server 联合 once/listen 签名不兼容——HEAD 亦复现，基线既有问题；`server as unknown as tls.Server` 别名修复）⑥ ProjectsRoute JSX 闭合
- ⚠️ 上游 17.3.0 无 GUI/daemon/sdk 层改动（collab-web/gui/daemon/server.ts/sdk 不在 828 文件内）——GUI 无需代码改动，仅内核升级后回归验证

## 验证记录（v17.2.12 移植）

- ✅ 分类（rename 归一后）：641 = NEW 107 / PURE 123 / OVERLAP 36（17 无冲突自动 3-way；19 手动）/ REN-PURE 73 / DEL-SAFE 302；无 DEL-CHECK/REN-OVER（musepi crates/TS 相对 v17.2.11 全部纯净）
- ✅ 执行方式：git diff v17.2.11 v17.2.12 -M --binary 生成补丁 → `git apply --3way` 因 oh-my-pi 对象库不在 musepi 仓库（partial clone 缺 theirs blob）失败 → 改用树级合并：/tmp/up1712 提取树 + git merge-file --diff3（base 归一化 @musepi→@musepi，ours=工作树，theirs=原始上游）
- ⚠️ **树级合并的 rename 坑**：merge-file 的 theirs 传原始上游文件（含 @musepi 包名）时，ours==base 的 hunk 会采用 theirs 的 @musepi 名——合并后 30 个文件残留 @musepi（含 packages/wire/package.json 的 name 字段，导致 workspace 依赖解析失败）。处理：全局重命名 @musepi→@musepi（排除 3 个合法文件：pi-scope-aliases.test.ts、legacy-pi-bunfs-root.test.ts、tui/src/keys.ts 注释）
- ✅ 手动解决（19）：6 个 package.json（@musepi 名 + 版本 17.2.12）；models.json（取 theirs + 补 musepi 4 个 provider 块 agnes/agnes-global/stepplan/stepplan-global——musepi 的非 agnes 数值差异是 c892aa9e2 AGNES regen 的副作用，如 qwen cost 0 占位、gemma maxTokens 32768，按上游 v17.2.12 覆盖）；generate-models.ts（ours 无 getProviderDefinition 引用）；session-manager.ts（ours 保留 truncateToIndex + pause 定制）；builtin-registry 系列（见下）；command-controller（theirs 的 logger.error #7993 + ours t() i18n）；CHANGELOG.md（ours 条目 + theirs 17.2.12 段）；ci.yml（取 theirs 整文件——HEAD==base，musepi 无定制）；README.md + 3 docs（theirs + .omp→.musepi 品牌化）；bun.lock（从 HEAD 重建 + sed 17.2.11→17.2.12，frozen install 校验通过）
- ✅ **slash-command 拆分移植**（本次最大手工作业）：上游把 builtin-registry.ts（3431 行）拆成 7 个 builtin-*.ts + 统一 registry。musepi 定制 = ① i18n 层（statusLine(prefix, t(state)) 渲染时翻译 + registry 静态描述 t() 包装）② collab LAN/workspace/tunnel 特性（LocalShareManager、stopCollabSharing、扩展 collabLinkHint、/collab lan|tunnel|workspace 子命令、/leave 拆 transport）。移植：写脚本按命令名提取 musepi 旧 registry 的 getTuiAutocompleteDescription 回调（命令级 cmd_block 定位 + 括号深度感知的表达式匹配）移植进新模块 + statusLine/t import；collab 模块手工拼装（their 结构 + musepi helper/spec）。**踩坑**：① 回调正则遇字符串内逗号截断（one-liner 回调 "…, …" 断在逗号）→ 行级匹配改为括号深度计数；② 脚本把路径字符串当文件内容传给 cmd_block（len(src)=18 的幽灵 bug，耗时 1 小时定位——函数单独测没问题、放进脚本就 None，settrace 才暴露）；③ 前缀丢失（block[:idx] 排除了属性名）与双逗号/重复闭合（`}
	},
	{` 边界）；④ 不要在已拼装文件上重复 splice（三重复制）。最终：22 个回调移植 + clear 无 musepi 版本保持 theirs，collab 模块 748 行拼装完成，全 workspace typecheck 0 错误
- ✅ 版本涟漪：14 个 package.json → 17.2.12（swarm-extension 手动；collab-proto 17.2.8/swarm-core 17.2.2/tool-select 17.2.2/sdk 0.3.0 保留）；sdk 的 @musepi/pi-wire 17.2.11→17.2.12；root catalog 13 条 17.2.12；bun.lock 重写 28×17.2.11→17.2.12，`bun install --frozen-lockfile` 通过（648 installs / 789 packages no changes）
- ✅ natives：crates/pi-natives 5 文件（lib.rs/tokens.rs/macos input.rs/keys.rs）变更；重建 14 分钟（cargo，LINKEDIT 对齐自动），哨兵 `__piNativesV17_2_12`，native bucket 36 测试全过
- ✅ 测试：coding-agent 五 bucket 全过（singleton 834/ui 14/runtime 106/native 36/heavy 36）；slash-commands 114 + collab 139 全过；final local 全量见下
- ⚠️ **ci-test-ts.ts scripts bucket 挂起修复**：bun 1.3.14 把裸 `scripts/foo.test.ts` 参数当 name filter（提示 "To treat … as a path, run bun test ./scripts/…"）→ 全仓库 test 文件扫描；本仓库状态（+大量新测试文件）下扫描挂死/被 OOM（137）。修复：runner 里全部改为 `./scripts/…`（路径语义，语义等价），scripts bucket 49 测试 865ms 全过
- ✅ 最终全量：`OMP_TEST_CONCURRENCY=4 bun scripts/ci-test-ts.ts local` **exit 0**——161 chunks 全过 + Rust nextest **2139 pass 3 skip**（pi-builtins 合并新增测试）。过程：第一轮 chunk 49 browser-tab-evaluate 全量负载下偶发 1 fail（孤立 147/147 过）；第二轮 scripts bucket OOM(137)——裸 `scripts/` 路径被 bun 当 filter 全仓扫描；第三轮 `./` 修复后 chunk 47 browser-launch 又偶发（内存压力，孤立 48/48 过）+ rust bucket 因 crates 遗留空目录（`crates/pi-*` glob 命中无 Cargo.toml 的 pi-uu-diff 等）失败——`find crates -type d -empty -delete` 后 cargo 正常；第四轮 OMP_TEST_CONCURRENCY=4（默认 = availableParallelism 8，1.3GB RSS/chunk 超内存）全绿。注意：本地全量跑默认并发 8 会内存抖动，建议 `OMP_TEST_CONCURRENCY=4`；stats aggregator 的 getOverviewStats 被并发 GUI 会话未提交 WIP 改名 getModelDashboardStats 撞名（同文件已存在同名函数，TS2323），已回退改名保留其 sessionCount/tokens 新增

## 验证记录（v17.2.11 移植）

- ✅ 分类（rename 归一后）：256 = NEW 25 / PURE 173（复制+`@musepi`→`@musepi` rename，md5 校验 == v17.2.10+rename 0 mismatch）/ OVERLAP 55（46 无冲突自动 3-way；9 手动）/ D 2（bazel/patches/maudio-sys-target-bindings.patch + crates/pi-voice/bazel/maudio_layout.rs——miniaudio 移除）
- ✅ 手动解决（9）：command-controller.ts（取 theirs handoff 语义——`session.handoff()` 现在把真实 provider 错误原样 re-throw、只有真正取消归一为 "Handoff cancelled"，去掉 ours 的 AbortError 分支，保留 t() i18n）；bazel-natives.ts（取 theirs win32 host 分支 buildWindowsHostAddon + 保留 ours 哨兵/source-hash/cargo 回退守卫，两者独立共存）；package.json（catalog 13 条 17.2.10→17.2.11 + 补回 @musepi/omptype 条目——v17.2.10 同步曾把 omptype 条目从字母序位置丢失、残留在 catalog 尾部，本次归位并去重）；MODULE.bazel.lock（取 theirs——生成物，musepi 无自定义 crate）；4 个 docs（advisor-watchdog/collab/keybindings/task-agent-discovery 取 theirs 新内容 + `.omp`→`.musepi` 品牌化；collab.md 的 my.omp.sh 是真实服务 URL 不动；computer-use.md 17 处 OMP 引用为既有内容不动）
- ✅ 版本涟漪：14 个 package.json 17.2.10→17.2.11（root 0.3.0 不动；collab-proto 17.2.8/swarm-core 17.2.2/tool-select 17.2.2 保留 musepi 自有版本）；sdk 的 @musepi/pi-wire 依赖同步；root catalog 13 条 17.2.11；bun.lock 重写（28×17.2.11，0 个 17.2.10，`bun install --frozen-lockfile` 校验通过）；Cargo.toml/Cargo.lock/MODULE.bazel 直接取上游 v17.2.11
- ✅ 品牌化：docs/agent-hub.md（新文件）`~/.omp/`→`~/.musepi/`；command-help.ts worktree 帮助文本 `~/.omp/wt`→`~/.musepi/wt`（实际路径 dirs.rootSubdir 本来就是 .musepi）；task-agent-discovery.md `~/.omp/agent/config.yml`→`.musepi`；其余 `.omp` 引用经核查均为既有内容/legacy 兼容/注释（secrets `.omp/secrets.yml` 等，非本次引入）
- ✅ 类型检查：20/21 包 check:types 0 错误（pi-coding-agent/pi-ai/agent/tui/catalog 等全过）；collab-web 剩 8 个 `../ai` 文件错误（见下「既有问题」）
- ⚠️ **collab-web 既有类型错误**（非本次移植引入，52fdacb33 复现证实）：collab-web tsconfig 带 DOM lib + `types: ["bun","react","react-dom"]`（此前缺 "assets"）时，bun-types 1.3.14 的 `UseLibDomIfAvailable` 条件类型把 `MessageEvent` 解析为 DOM 构造器类型（`typeof globalThis.MessageEvent`），导致 collab-web 程序里被拉入的 ../ai 文件（openai-codex-responses/bedrock-mantle/cowork-fetch）报 MessageEvent.data/BodyInit/RequestInit 错误；ai 自己的 check:types 0 错误。根因是 widget 特性（GUI 会话引入 collab-web→coding-agent→ai 导入链）暴露的 bun-types 怪癖，修复需 project references 重构或 patch bun-types，超出同步范围。本次已顺带修复同族问题：collab-web tsconfig 补 "assets"（30 个 *.md 模块错误全消）、host.ts board.save 窄 cast→BoardRecord[]、WidgetErrorBoundary.getDerivedStateFromError 补 error 形参、widget-renderer.test.tsx 直调断言
- ✅ natives：crates/pi-voice 重写（miniaudio→coreaudio/linux/wasapi/unsupported 原生后端）+ pi-natives macos input.rs 大改；哨兵 `__piNativesV17_2_11`；cargo 重建（31m31s LTO）+ LINKEDIT 对齐后 dlopen 正常；natives 93 bun 测试全过
- ✅ 测试（最终全绿）：`bun scripts/ci-test-ts.ts local` **exit 0**——160 个 TS chunk 全过（omptype/ai 3728/catalog 569/agent 480/utils 626/tui 1429/hashline 271/snapcompact 82/natives 93/collab-web 142/mnemopi 453/coding-agent 五 bucket 全过/scripts 98）+ Rust nextest **1990 pass 3 skip**；Agent Plugins discovery 229 测试全过；CLI 冒烟 `musepi/0.3.0 (OMP 17.2.11)`
- ✅ 本次顺带修复的既有问题（非同步引入，但阻塞全量验证）：① acp-agent.test.ts + reload-plugins-mcp.test.ts 的 `.omp/agents`→`.musepi/agents`（上游新测试写 .omp 发现路径，musepi CONFIG_DIR_NAME 适配）；② WIDGET_TONES 补 fx/stocks、WIDGET_TYPES.video defaults 同步 GUI registry（widget-parity 契约，GUI 会话加 widget 时漏了 daemon 表）；③ export-html-template.test 期望更新为从已提交 collab-web src 重新生成 tool-views 后的字节（chars 514273 / bytes 535150 / sha 298712d2——v17.2.10 的 408914 对应旧 tool-views；`gen:tool-views` 产物 gitignore，改 collab-web tool-views 后必须重跑并更新期望）；④ ci-release-notes.test 的 compareVersions 改从 pi-utils 导入（v17.2.9 起脚本改为 import，测试还是 fork 时代的 re-export 假设，v17.2.10 没跑过 local 模式所以没暴露）；⑤ ci-test-ts.ts 的 localOnlyWorkspacePackages 去掉 python/robomp/web（musepi 无此目录，spawn ENOENT）；⑥ collab-web tsconfig 补 "assets" types（30 个 *.md 模块错误）；⑦ host.ts board.save cast BoardRecord[]、WidgetErrorBoundary.getDerivedStateFromError 补 error 形参、widget-renderer.test 直调断言；⑧ docs/tools/board.md + widget.md（omp:// 覆盖测试，并发 GUI 会话也写了同文件，取 theirs）
- ⚠️ **环境前提**：本机缺 cargo-nextest（`brew install cargo-nextest`）；rust bucket 必须在 `~/.cargo/bin` 前置的 PATH 下跑（否则 runner 捡到 /opt/homebrew/bin 的 stable cargo，`#![feature]` 编译失败）；`cargo fmt --check` 全工作区 5790 处漂移为既有（rustfmt 版本差异，非本次引入）
- ⚠️ 教训：同步期间并发 GUI 会话会把未提交改动 `git add -A` 合入自己的 commit——长时间任务中途若发现「工作树突然干净 + HEAD 前移」，是并发会话提交了你的改动，先验证内容在 HEAD 里再继续，不要 git reset；本机 `local` 全量模式此前从未真正跑通过（robomp ENOENT + compareVersions + nextest 缺失），本次首次全绿

## 验证记录（v17.2.10 移植）

- ✅ 分类（rename 归一后）：414 = NEW 81 / PURE 224（复制+`@musepi`→`@musepi` rename，逐文件 md5 校验 == v17.2.10+rename 0 mismatch）/ OVERLAP 109（65 无冲突自动 3-way；21 手动 + 23 含 EOF 微差走 3-way）
- ✅ 手动解决（21 冲突 + 9 docs）：main.ts + args.ts + extensions/loader.ts（取 theirs——`--trusted-extension` 新安全特性）；agent-hub.ts（取 theirs 大重做 + t() i18n 重放：Agent Hub/read-only/Failed to register 等 key）；selector-controller.ts（theirs #showFullscreenMenu + ours settings.locale 定制）；persisted-revive.ts（theirs modelPattern/subagentSettings + ours pauseGate 定制，注意：初版合并丢失了 subagentSettings/persistedModelPattern 前置定义与 formatModelRoleAlias import，2 个测试失败暴露后补回）；agent-session-message-pipeline.test.ts（取 theirs pi.arktype——消除 v17.2.9 记录的 ZodLikeSchema 类型错误）；chart-shared.tsx（取 theirs pi-utils/dates）；formatters.ts（保留 ours——date-fns zh-CN locale 是 musepi 定制，pi-utils/dates 仅英文）；Markdown.tsx（保留 ours 172 行定制 + marked import 换 pi-utils/marked）；collab-web 其余定制保留
- ✅ docs 合并：9 个冲突 docs 逐个处理（custom-tools/extensions/hooks/skills/browser 取 theirs omptype 语义；computer-use.md/computer.md 保留 ours 深度定制 + 并入 theirs platform 矩阵与 delivery 说明；porting-from-pi-mono 保留 musepi 品牌行 + theirs 新行；user-facing-packages 保留 swarm-extension + 并入 omptype 段）
- ✅ 6 个 D 删除：zod-decontaminate.ts（musepi 无引用，上游 index.ts 已删 export）、mammoth.d.ts（docx.ts 已迁 pi-utils/docx）、issue-1215-legacy-pi-ai-import.test.ts（依赖已移除的 @mariozechner/pi-ai）、omptype bench zod.ts、winston-daily-rotate-file.d.ts、patches/@agentclientprotocol（依赖已随上游移除，root package.json + coding-agent package.json 同步清 catalog/patch 引用）
- ✅ zod→omptype 迁移：ai types.ts/index.ts、catalog gitlab-duo-workflow、coding-agent extensions types.ts 等全部迁到 @musepi/omptype（上游 v17.2.10 移除 zod 依赖；omptype zod.ts 已纯内部实现）；6 个包 package.json 的 zod/arktype/handlebars/winston/marked/turndown 依赖清理（collab-web marked、coding-agent mammoth 等）
- ✅ 版本涟漪：14 个 package.json version 17.2.9→17.2.10（root 0.3.0 不动；collab-web 16.3.6/metaharness 0.0.1 等保留）；root catalog 13 条 17.2.9→17.2.10 + 移除已删依赖条目；bun.lock 重写（28×17.2.10，0 个 17.2.9）；Cargo.toml/Cargo.lock 直接取上游 v17.2.10（pi-shell bun.rs 定制不受影响）；root scripts 补上游核心脚本（check:ts/test:ts/ci:* 等，跳过 robomp/docker）
- ✅ natives：crates 5 文件（wayland/pipewire 门控）同步；cargo 重建（nightly-2026-04-29）成功；**修复 fix-linkedit-align.ts 插入点 bug**（原代码 `at: newStart` 用 r.start+delta 计算插入点，从后往前插入时 padding 插进 codesig blob 内部导致 codesign "invalid or unsupported format"——改用 r.start 原始偏移；对齐后 dlopen 正常）；哨兵 `__piNativesV17_2_10` + .source-hash 指纹 e40240f2 守卫通过，natives 93 测试全过
- ✅ 测试：omptype 1198（0 fail）、ai 4038（0 fail）、catalog 563、agent 480、utils 621、tui 1429、hashline 269（补 @musepi/pi-utils 依赖后）、natives 93、stats/wire/mnemoni/snapcompact/swarm-extension/metaharness 全 0 fail；**coding-agent 按上游官方分块方式（ci-test-ts.ts 的 singleton/ui/runtime/native 四 bucket）全量 0 fail**；collab-web 全 0 fail（shimmer 测试适配 musepi 定制语义）；20 个包官方 check:types 全部 0 错误
- ✅ 完善修复（2026-08-07 复审）：① process-exit 探针 4 个失败——root `dependencies` 显式声明 `@musepi/pi-utils: catalog:`（bun 提升到 root node_modules，探针子进程可解析），11/11 全过；② HTML export 4 个——期望值更新为 musepi 定制模板实际字节（chars 401159 / bytes 408914 / sha256 000659c0…，上游 376472 是上游模板），7/7 全过；③ collab-web shimmer 1 个——musepi 定制版有意把 pre-stream thinking 放 Composer status bar（避免双 orb，用户要求），测试适配为断言 working 时无 shimmer 且无 empty 态，92/92 全过；④ read-only kill 测试加 15s 超时（上游默认 5s 在全量负载下偶发不足）
- ⚠️ 教训：直接 `bun --cwd=packages/coding-agent test` 全量并发跑会把 collab 测试与其他 reset 全局 registry 的文件混跑（bun test 默认单进程共享全局，实验证实跨文件可见 `globalThis` 标记），collab read-only kill 用例因 `AgentRegistry.resetGlobalForTests()` 竞争稳定超时——**上游从不这么跑**（ci-test-ts.ts 分 chunk 独立进程，collab 在 runtime bucket），必须用 `bun scripts/ci-test-ts.ts coding-agent-*` 分 bucket 验证。曾尝试在测试内 reset 全局，破坏 host 订阅导致单独跑也挂，已回退

- ✅ 修复的测试：persisted-revive 5/5（合并丢失 modelPattern 定义补回）；changelog 14/14（CHANGELOG.md 补入上游 17.2.9/17.2.10 条目——musepi 保留 ours CHANGELOG 导致 parseChangelog 断言 VERSION==最新条目失败）；lsp-regressions 76/76（"custom server languageId" 测试适配 .omp→.musepi，musepi CONFIG_DIR_NAME 品牌差异）
- ⚠️ MCPManager resources 测试曾在直接全量并发下偶发 1 fail（FileLock/子进程竞争），分 bucket 后稳定；单独跑全过
- ⚠️ 磁盘：natives bazel 重建因 macOS 27 磁盘空间不足（No space left on device）多次失败，清 bazel 缓存 + cargo nightly 重建解决；bazel 缓存重建后 ~5GB

- ✅ 分类（rename 归一后）：256 = NEW 14 / PURE 176（复制+`@musepi`→`@musepi` rename，逐文件 md5 校验 == v17.2.9+rename 0 mismatch）/ THREE_WAY 80（58 无冲突自动 3-way；22 手动）
- ✅ 手动解决：auth-storage.ts（上游大重构，序列化迁入新文件 sqlite-credential-store.ts——musepi note 定制同步迁移：类型 note 字段 + authCredentialEquals + importApiKey/setCredentialNote + serialize/deserialize note 往返）；openai-codex-responses-lite.test.ts（取 theirs）；docs/python-repl.md + docs/tools/eval.md（取 theirs，agent() 签名文档去掉已删除的 model 参数）；README.md 包表（取 theirs 完整 17 包）；docs/mcp-config.md（theirs + `.musepi` 品牌化，找回被上次品牌化误删的 Imported tool configs 章节）；user-facing-packages.md（保留 ours——musepi 仍发行 swarm-extension）；tsconfig.base.json（+noImplicitOverride/noFallthroughCasesInSwitch）；2 个 CHANGELOG 保留 ours
- ✅ 版本涟漪：13 个 catalog 条目 + 8 个 package.json version 17.2.8→17.2.9（root package.json 0.3.0 不动）；sdk 的 @musepi/pi-wire 依赖 17.2.8→17.2.9；bun.lock 重写（28×17.2.9，collab-proto 17.2.8 保留为 musepi 自有包）；Cargo.toml/Cargo.lock 直接取上游 v17.2.9（musepi 无自定义 crate，此前 Cargo.lock 与上游仅差 workspace 版本 17.2.4→17.2.9 的遗留未滚）
- ✅ 测试：omptype 1198（0 fail）、catalog 563（0 fail）、agent 478（0 fail）、ai 4062（3725 pass / 337 skip / 0 fail）、coding-agent session 470 + daemon/auth 系列（含 auth-storage-note 相关 64+46）全过；workspace check:types 仅剩 1 个**既有**类型错误（见下）
- ⚠️ 既有类型错误（非本次移植引入，全量 stash 复现证实）：`coding-agent/test/agent-session-message-pipeline.test.ts(1001)` `pi.zod.object(...)`（ZodLikeSchema）不可赋给 TSchema——错误链文件（omptype zod.ts / pi-ai types.ts / extensions types.ts）全部不在本次 diff 内，v17.2.9 上游同文件类型亦相同
- ⚠️ natives 二进制仍为 `__piNativesV17_2_8` 哨兵（v17.2.9 crates 变更含 natives 缓存刷新 f687a074d）：dev 工作区加载跳过哨兵校验可正常运行（已冒烟 `musepi/17.2.9`）；正式产物需跑 `bun --cwd=packages/natives run build` 重建（源码指纹变化会自动触发 cargo 重建路径）

## 验证记录（v17.2.8 移植）

- ✅ 分类：367 src = NEW 42 / PURE 312（本地 == v17.2.4，直接覆盖+rename）/ THREE_WAY 13；另有 381 test/scripts/bench + 43 crates（Rust，pi-natives 36 个文件含 FileLock/desktop 模块化）+ Cargo.lock/MODULE.bazel.lock
- ✅ 新包 `omptype`（schema 校验/JSON-schema 生成）：14 src + package.json/tsconfig/README 引入，catalog `@musepi/omptype: 17.2.8`；agent/ai/catalog/coding-agent 4 包新增 `@musepi/omptype@catalog` 依赖；ask.ts/security-scan.ts/agnes-video-gen.ts/2 个 extensibility types 的 `arktype`/`zod/v4`/`../typebox` import 全部迁移到 `@musepi/omptype` facade
- ✅ 版本涟漪：16 个 package.json 17.2.4→17.2.8；natives 哨兵 `__piNativesV17_2_8`（index.js/native 产物已同步，Rust 二进制待定——见「已知问题」）；bun.lock 重建 506 installs / 638 packages
- ✅ 三方合并：21 文件（13 THREE_WAY + 8 WIP 重叠）经 `git apply --3way`（上游 17.2.4→17.2.8 补丁 + rename）应用；4 个手工（registry.ts bedrock-mantle、dirs.ts getBrowserRelayDir/getGlobalDaemonRuntimeDir、2 个 extensibility types 的 omptype import）
- ✅ 恢复/重建（2026-08-04 WIP 事故，见下）：session-manager `truncateToIndex`（/tmp/ours.txt 幸存）；agent-session `revertTo`（截断+`buildDisplaySessionContext` 重放+返回文本）；status-line `swarmMode` 三处（state/setter/return）；descriptors + registry 的 agnes/agnes-global/stepplan/stepplan-global 注册；openai-compat 的 `AGNES_STATIC_MODELS`/`AGNES_GLOBAL_STATIC_MODELS`/`STEPFUN_STATIC_MODELS`/`STEPFUN_GLOBAL_STATIC_MODELS`（**价格/上下文为占位值，见下**）
- ✅ 测试：ai 4038（2 fail 为 /tmp SQLite 残留 flake，清后过）；catalog 561（0 fail）；agent 470（0 fail）；coding-agent 待 natives 二进制就绪后重跑（config-cli/mcp 测试依赖 FileLock）
- ⚠️ **WIP 事故（2026-08-04）**：合并流程中 `git checkout HEAD --` 覆盖了 9 个文件的未提交 WIP 增量（registry.ts、models.json、descriptors.ts、openai-compat.ts、settings-schema.ts、system-prompt.md、sdk.ts、agent-session.ts、builtin-registry.ts）。session-manager.ts 经 /tmp/ours.txt 找回；agent-session revertTo 已重建；**builtin-registry +227 行内容未知（可能丢失新命令）；AGNES/STEPFUN 静态模型价格为占位 0 元/128k/仅 text，需用户核对原清单**。教训：任何覆盖前先 `git stash` 或备份工作区
- ✅ 冒烟：`bun run check:types` workspace 0 错误
- ✅ **定制丢失复查（2026-08-04 二次审计）**：以「HEAD vs 上游 v17.2.4 差异 = musepi 定制集合」为基准全量扫描，发现并恢复 **17 个文件的 PURE/3way 覆盖丢失**：cli.ts MUSEPI_VERSION 显示、update-cli.ts MuseLinn 更新通道（REPO/HOMEBREW/MISE，含测试期望同步）、tools/index.ts agnes-video-gen export、sdk.ts 视频工具装配（settings `agnes_video_gen.enabled` + settings-schema key 注册）、settings.ts `#migrateProjectConfigDir`（.omp→.musepi 项目配置迁移）、legacy-pi-compat PI_SCOPE_ALIASES、selector-controller settings.locale 切换、commands/* renderCommandHelp("musepi")+t()、setup-cli/command-controller/interactive-mode/assistant-message/btw-panel/tree-selector 的 t() i18n 定制（三方 merge-file，ours=HEAD 保留定制 + 17.2.8 新功能；btw-panel 动态 actions 保留 + t() 化；branching case 补回）。测试适配：settings-manager/selector-settings-side-effects/system-prompt-dedup/main-interactive-input 的 `.omp` 硬编码改 CONFIG_DIR_NAME/getProjectAgentDir；cli-commands serve 补 serveHelp 元数据。验证：coding-agent 套件 11772 pass（修复前 28 fail → 修复后仅剩 ~10 个上游自身矛盾/基线项，typebox Optional+default 与 omptype 实现冲突为上游 17.2.8 同款代码，非 musepi 引入）；GUI 浏览器实测会话列表 555 条 + 模型按钮默认 agnes-2.5-flash
- ✅ **AGNES_STATIC_MODELS 官方规格落地（2026-08-04）**：openai-compat.ts 的 agnes/agnes-global 静态 seed 按 wiki.agnes-ai.cn 更新——2.5-flash/2.0-flash = 512K 上下文、$0.03/$0.15 每 1M、text+image；2.5-pro/2.5-pro-alpha = 1M、$0.45/$0.90、text+image（此前为 WIP 事故后的占位 131072/$0/text-only）。STEPFUN 仍为占位（官网当时不可达，已标注待核对）。catalog 561 测试全过；运行时常量验证通过

## 已知问题（后续复查发现,2026-08-02）

| 问题 | 归因 | 状态 |
|---|---|---|
| **natives Rust 二进制（17.2.8）** | FileLock 绑定为 17.2.8 crates 新增；本地 bazel 构建在 macOS 27 有 ld 回归（mis-aligned LINKEDIT）。2026-08-04 另一会话 bazel 重建完成（FileLock 导出验证通过，config-cli/mcp/file-lock 测试全绿），models.json 已用新 natives 重新生成（AGNES 官方规格并入） | ✅ 完成 |
| ~~utils 全量并行测试抖动~~ → **已解决**（2026-08-02） | 根因确认为 **ld 回归坏产物**（本地 bazel 构建 .node 报 mis-aligned LINKEDIT,并行加载/进程竞争）;替换为 17.2.4 发布物后 utils 并行 503/0 稳定 | ✅ natives 发布物换装后消失 |
| ~~上游主 checkout 的 natives 加载差异~~ → 无 natives .node 的上游却测试通过:workspace 模式 loader 跳哨兵校验;上游环境另有加载路径,与 musepi 无碍（musepi 已用发布物） | 已澄清,不阻塞 |
| **上游主 checkout 的 natives 加载差异**:上游仓库无任何 `pi_natives*.node`,但 ptree 测试通过;musepi 有本地 .node 反而并行抖动 | 待查(上游加载路径不明,可能 bun 缓存/安装差异) | 记录,不阻塞 |
| **profiles.test 子进程段**(4 个 `dirs module import behavior`) | HEAD 版(合并前)同样失败 = 基线;与 17.2.4 同步无关(bun test 内 Bun.spawn 快速 pipe 退出偶发丢 stdout) | 基线环境问题,串行下亦偶发;上游同文件通过 |
| **branding 修复**(本次):config-request-id-format(dirs-cache/profiles/dirs-python-gateway)的 `.omp`/XDG `omp` 字面量 → `.musepi`/`musepi` | NEW/PURE 复制只做 @musepi→@musepi rename,`.omp` 路径/XDG 目录名未品牌化;17.2.4 新增 XDG 逻辑(dir-s.ts APP_NAME 参数化)使旧字面量失效 | ✅ 已修 |

## 已知问题（agent 包 2 测试失败）

| 测试 | 归因 | 状态 |
|---|---|---|
| `append-only-context` (775) | 上游 v17.2.2 与 v17.2.4 **自身均失败**（已在 oh-my-pi 主 checkout 复现）；`build()` 的 ArkType params 物化顺序断言，上游未修复 | 上游问题，待上游修 |
| `agent-loop` (3953) | musepi **合并前 HEAD 同样失败**；上游 v17.2.2 失败、**上游 v17.2.4 已通过**（94 pass / 0 fail 对照）→ musepi 环境差异（代码与依赖版本与上游逐字一致，疑似运行时环境，未深挖） | musepi 环境既有问题，**非本次移植引入**；下次同步可复测 |

> 注意：v17.2.2 记录中「agent-loop 上游同样失败」的归因**对 agent-loop 已不成立**——上游 17.2.4 已修复该测试，musepi 环境未跟上。append-only-context 的「上游同样失败」归因仍成立。

## 验证记录（v17.2.2 移植）

- ✅ 构建：coding-agent 二进制、collab-web tool-views、catalog 全部通过
- ✅ 测试：hashline 269、ai 3642、catalog 541、coding-agent 核心子集（edit/codex/session/mcp/browser/eval/secrets）全过
- ✅ 冒烟：`musepi --help`、`musepi models`（含 stencil 迁移后 video 列）正常
- ⚠️ agent 包 2 测试失败（append-only-context、agent-loop）：上游 v17.2.2 本身同样失败（已在上游复现），非移植引入
- ⚠️ coding-agent 全量测试部分失败：多为品牌化断言（`omp` vs `musepi` agent 名、profile alias、legacy pi scope），预期内；部分测试需真实 agent 启动（依赖 natives）会挂起
- ✅ **natives 17.2.2（记录更正，2026-08-02）**：v17.2.2 记录称「改用上游发布物」，但**实际产物是本机构建**（`native/pi_natives.darwin-arm64.node` 为 SDK 27 / 本机 ld 构建，哨兵 `__piNativesV17_2_2`，dlopen 可用）——「替换发布物」当时未真正落地，UPSTREAM 记录与仓库状态不符。natives 包版本对齐上游改为 17.2.2（与 lib.rs 哨兵一致）。
- ✅ **video 输入定制已回退**：musepi 的 17 个 video 输入定制文件经查全是死代码（file-processor 产物在 prompt 入口被丢弃、VideoResolver 从未实例化、anthropic gate 恒 false），且带 TS 类型错误。已全部回退到上游 v17.2.2 原文，删除 musepi 独有文件 `kimi-video-upload.ts`、`video-resolver.ts`。保留 `agnes-video-gen.ts`（agnes 视频生成工具，musepi 独有功能）。未来视频输入功能按 kimi-code 模式（能力声明 video_in + 上传阶梯 + ReadMediaFile）独立立项重做。
- ✅ **natives 构建守卫**（musepi 本地工程修复，双检查 + cargo fallback + 逃生舱）：`scripts/bazel-natives.ts` host 目标时，若 `--dest` 已有可加载 addon 且同时满足 ① 版本哨兵 `__piNativesV<version>` ② 源码指纹匹配（`native/.source-hash` 记录的 crates/pi-natives+pi-voice 源文件哈希 == 当前磁盘哈希），则跳过构建。首次遇到无指纹的好 addon 自动 adopt；源码变更（含同版本改动）**自动走 cargo 重建**（`cargo build -p pi-natives --release`，rustup nightly-2026-04-29 与 bazel 工具链同版本），cargo 失败才 fallback bazel。`OMP_NATIVES_FORCE_BUILD=1` 强制 bazel。已验证全链路：adopt / hash 匹配跳过 / 源码变更→cargo 重建 / 产物加载+90 测试通过。
- **本机重建可行（已实证）**：LINKEDIT mis-aligned 是 bazel/rules_rust 链接路径问题（rustc 与 ld64 均正常：平凡 cdylib 链接对齐正常；cargo 构建的 pi-natives 产物 8 对齐、dlopen 成功、90 测试全过）。musepi 不再依赖上游 prebuilt，可完全本机构建。需 rustup + nightly-2026-04-29（`curl -sSf https://sh.rustup.rs | sh` + `rustup toolchain install nightly-2026-04-29`）。
- **发布说明**：`@musepi/pi-natives-darwin-arm64` 等平台 npm leaf 包**无需为本地开发发布**——dev/测试走 workspace 本地 `native/` 目录，编译二进制走 embedded-addon（`gen:native` 从本地 `native/` 打包进 bunfs）。leaf 包仅在“从 registry 安装 musepi 作为依赖”时（即 musepi 正式 npm 发布）才需要，属未来发布流程（ci-release-publish），非 natives 修复前提。

## 定制审计记录（2026-08-01）

### 已确认完整集成 ✅

- **i18n 框架**（collab-web + TUI）：`t()` key=英文原文、zh-CN.ts（1749 keys）、locale 检测/持久化、缺 key 优雅降级英文。已验证框架健康（zh 翻译生效、en pass-through）
- **agnes/stepplan/gmiCloud provider**：registry.ts 全部注册进 ALL 数组（`_CheckRegistryComplete` 编译期校验通过），文件存在
- **agnes 图像/视频生成**：image-gen.ts（agnes-image-2.1-flash）+ agnes-video-gen.ts（CustomTool），tools/index.ts 导出
- **品牌元数据**：APP_NAME/CONFIG_DIR_NAME（.musepi）、CLI 0.3.0、brew-formula、release 脚本
- **natives 本机构建**：cargo fallback + 哨兵/指纹守卫（已验证四路径）
- **pi-shell bun.rs 定制**：crates/pi-shell/src/minimizer/filters/bun.rs（75 行）

### 本次修复 🔧

- **项目配置目录统一**：settings.ts 两处硬编码 `.omp/config.yml` 改用 `getProjectAgentDir(cwd)`（→.musepi，与 discovery/plugin-overrides/mcp.json 一致）。修复 settings-reload-cwd 2 个失败（根因：CONFIG_DIR_NAME 改为 .musepi 后 settings 未同步，导致项目配置目录分裂）。测试适配 getProjectAgentDir（双端兼容：musepi→.musepi、上游→.omp，均 39 pass）
- **command-controller.ts lint**：biome useTemplate 修复

### 测试状态 ✅（2026-08-01 全部预存在失败已修复）

`git stash` 基线对比证实早期 102 fail 中 ~99 个在改动前已存在（.musepi 品牌化遗留 fixtures 用 .omp、独立缺陷、移植遗漏）。已全部修复（commit `94135be` + `d201fe7`，11865 tests 三次全量验证 0 fail / 0 error 稳定）：

- **源码品牌化遗漏**：`omp-extension-roots.ts` 项目 scope 硬编码 `.omp` → `getProjectAgentDir`；`task/discovery.ts` `TASK_AGENT_CONFIG_SOURCE = CONFIG_DIR_NAME`（原 `.omp` 会过滤掉所有 agent 目录）；`warp-events.ts` summary "omp wants to run" → musepi；`CANONICAL_PI_SCOPE` @musepi + `PI_SCOPE_ALIASES` 追加 musepi；omfg-controller 选项文本
- **包名修正**：`@musepi/coding-agent` → `@musepi/pi-coding-agent`（legacy-pi 全链路 collect/remap/虚拟模块）
- **版本统一 17.2.2**：14 个 package.json + 依赖 spec 与上游 changelog/natives 三方对齐
- **移植补齐**：`assets/` 14 文件（assistant-message 测试依赖）、`@biomejs/biome` + cli-darwin-arm64 devDeps（biome-client 测试二进制）
- **fixture 批量适配**：~25 个测试文件 `.omp` → `.musepi`（getProjectAgentDir/getAgentDir/getPluginsDir 或字面替换）
- **并发缺陷**：read-pdf-images 共享提取 mock 加 5s 释放超时（防并发卡死 markit 其他测试）
- 遗留：早前标记的"update-cli registry 断言顺序性 flaky"系**误标**——那些断言是纯函数（buildNpmInstallArgs/buildBunInstallArgs），无共享状态，早期失败实为包名/版本对齐前的确定性失败，修复后从未再失败。实际偶发项是 `markit-converters.test.ts` 的子进程 watchdog（5s→30s 加固，防全量并发下 CLI 冷启动误报）与 read-pdf-images 共享提取并发（已加 5s 释放超时）

### 未完成/待决策 ⚠️

- **i18n 翻译覆盖度**：✅ 已补全（commit `5722135`）——settings-schema 1071 字符串全覆盖、collab-web Composer/Transcript 接线、去重 90 个重复 key，最终 2224 keys / 0 重复 / 0 missing
- **musepi/ 扩展未接线**：`src/musepi/swarm/orchestrate.ts`（createSwarmExtension，264 行完整）、`tool-select/*`、`branding/` 已写好但未注册——需用户加入 extensions 配置才启用（同上游 swarm-extension 模式：手动加 extensions 路径）。swarm_run 工具默认不可用，需补文档或默认注册开关
- **配置目录决策**：✅ 已落地（commit `5722135`）——统一到 `.musepi`，settings.ts `#migrateProjectConfigDir()` 一次性复制 `.omp/config.yml`→`.musepi`（首次项目加载，旧文件改名 `.bak`，无永久回读）；边界：.musepi 优先/无 .omp 不建/空 .musepi 仍迁移
- **boxed TUI 主题补充**：经全仓库扫描，**musepi 无此定制**——boxed/边框主题是上游 v17.2.2 原生特性（theme-schema、theme/ 目录与上游 0 diff）。如指别的功能请确认
- **视频理解**：死代码已删（见上），kimi-code 模式重做是独立立项，未实施

## 版本说明

- **workspace 包版本镜像上游**：`packages/*/package.json` 的 `version` 逐包与上游同步基线一致（当前 v17.2.2；collab-web 16.3.6、metaharness/typescript-edit-benchmark 0.0.1 是上游本来就有的版本，照搬）。原因：① `@musepi/pi-natives` 必须跟随上游（见下）；② 纯 TS 包与 natives 同轨，同步时三方（上游↔musepi）逐包对照直观，diff/changelog 无版本换算
- **`@musepi/pi-natives` 版本必须跟随上游**（当前 17.2.2）：natives 消费上游发布的二进制产物（或本地 bazel 重建），addon 导出的哨兵符号 `__piNativesV<version>` 由 lib.rs 的 `js_name` 硬编码，loader 从 package.json 推导期望哨兵——两者必须严格一致。上游产物导出 `__piNativesV17_2_2`，故 natives 包版本必须也是 17.2.2。**不要**把 lib.rs 哨兵改成 `__piNativesV0_3_0`：那会使上游 prebuilt 不兼容且必须本机重建（本机 ld 工具链坏）
- **根 package.json（`@musepi/musepi`）version 0.3.0 = MusePi 应用发布版本**，与上游无关，随 MusePi 自身发布递增
- **用户可见版本显示是组合串**：`musepi --version` / 启动横幅输出 `MusePi 0.3.0 (OMP 17.2.2)` 形式——MUSEPI_VERSION 在 src/musepi.ts（bundle-dist.ts 同步 define）设置，cli.ts/main.ts 拼 `OMP ${VERSION}`（VERSION 来自 @musepi/pi-utils 包版本 = 17.2.2）。改 0.3.0 只需改这两处常量，不动包版本
- 各 package 的 dependencies 用固定版本（如 `17.1.8`）而非上游的 `catalog:` 引用——这是有意的，避免随 catalog 漂移

## 版本边界（上游）

- **17.2.0**（28 commits）：OMP-native 安全扫描子系统（主体）、hashline 剪贴板 + Lark 语法重构、OAuth 凭据 pin 持久化、createAgentSession 竞态修复、Codex/stream 超时默认 300s、typescript-edit-benchmark 重构、CI/bazel 基建
- **17.2.1**（21 commits）：anthropic cowork 传输、ollama 远端发现超时修复（#7087）、ollama 模型缓存按 endpoint 作用域、legacy pi shim createEditTool/createWriteTool、eval py 环境代理绕过、安全归因加固、natives xwayland 修复、CI/锁文件修复
- **17.2.2**（223 commits / 306 files）：catalog 迁移 stencil.so + ETag + ZStd、GMI Cloud provider 新增、codex saved-reset 算法重写、extensions `ctx.invokeTool` 原生委托、compaction summary 预算封顶、oauth 过期凭据刷新、cursor K3 replay 系列、MCP reload 系列、hashline 重构、pi-voice crate、python/omp-rpc 模块、browser/eval/rpc/secrets 等修复

## 移植方法（已固化）

1. **三态分类**：NEW（musepi 无此文件）直接复制；PURE（musepi == 上一基线）直接覆盖；THREE_WAY 用 `git merge-file`（base=上一基线+rename，ours=musepi，theirs=新版+rename）
2. **import 重命名**：全部 TS 文件 sed `@musepi` → `@musepi`（有意的 `@musepi` 引用保留：legacy-pi-compat 别名、测试夹具、release.ts 模式）
3. **保留的 musepi 定制**：agnes/stepplan provider、视频 WIP（上游已吸收 video 支持）、collab-web i18n（t() + zh-CN）、品牌元数据（name/version/bin/homepage）
4. **锁文件**：Cargo.lock / bun.lock 从上游复制（无本地定制时），crate 新增需补 Cargo.lock 条目
5. **验证**：`bun build` → `bazel build //:natives-darwin-arm64` → 测试 → 冒烟

## 已知环境性注意

- changelog 夹具（expected 17.1.8 vs 17.2.x）：环境性，非功能回归
- native addon 路径：环境性
- pi-voice crate 依赖 audiopus_sys 等新 crate，需 bazel 全量重编译（首次 2754 目标，耗时 >10 分钟）

## 建议执行顺序（下次同步）

1. 分类脚本 `scripts/upstream-classify.sh <old-tag> <new-tag>`：md5 比较 musepi 工作树 vs 上游两 tag，输出 NEW / PURE_UPSTREAM / THREE_WAY / ALREADY
2. NEW + PURE 批量复制 + rename
3. THREE_WAY 批量 `git merge-file`，冲突文件逐个按「保留 musepi 定制 + 吸收上游」处理
4. package.json：musepi 元数据 + 上游 dependencies（键对齐即可，值保留 musepi 固定版本）
5. Cargo.lock / bun.lock 复制
6. 验证

## LAN / 隧道共享（2026-08-02 新增）

`/collab lan [port]`（默认 7654）与 `/collab tunnel [port]` 让 host 端自持 relay，不经公共 `my.omp.sh`。

- **relay-server.ts**：零依赖 RFC6455 server（net + 手写 HTTP upgrade 解析）。Bun 1.3.14 的 node:http 兼容层在 upgrade 后丢字节、且同 tick 二次 write 丢数据——全部规避（手写握手 + 合并单次 write + `end(data)` 收尾）。101 响应带 RFC 7231 `Date` 头（Bun WebSocket 客户端无此头拒连；node/undici 均可）。
- **房间语义**：与公共 relay 逐条一致（4001/4004/4009/4029、peer-joined/peer-left/room-closed、envelope 头改写转发）。13 单测 + 4 CollabSocket 集成测试 + LAN E2E。
- **staticDir**：同端口 serve collab-web dist（SPA fallback，`/r/` 保留给 relay），浏览器深链直接可用。
- **tunnel.ts**：cloudflared quick tunnel 生命周期（stderr 解析 trycloudflare URL、超时/退出/abort 拒绝、SIGTERM→SIGKILL 停止）。7 单测（fake binary）；真隧道 E2E 需本机 cloudflared（条件跳过）。
- **明文策略**（collab-proto link.ts）：`ws://` 仅允许 localhost + RFC 1918/link-local IPv4（LAN 直连），公网强制 `wss://`（隧道/公共 relay）。

### 安全模型
- 房间密钥 + 写 token 只在 link fragment（不随 HTTP 请求发送）；relay 只见 AES-GCM 密文。
- 隧道公共 URL 本身不是秘密——与公共 relay 同风险等级：**默认拒绝文件写与设置变更**（guest 无 write token 只读），写权限由 token 门控。
- LAN 明文 ws 仅限内网；公网路径（隧道/公共 relay）一律 wss。

## LAN 网页端加密:自签 TLS(2026-08-02 追加)

浏览器只在安全上下文(https 或 localhost)暴露 `crypto.subtle`——LAN 明文 http 页面无法执行 collab 的 AES-GCM,`/collab lan` 的网页端此前在非本机浏览器不可用。现已修复:

- **双端口**:`/collab lan` 起明文 relay(port,终端 join + localhost 网页)+ TLS relay(port+1,自签证书,跨机网页)。
  - 终端 link:`ws://LAN-IP:port/r/<room>.<key>`(明文,不变)
  - 本机网页:`http://localhost:port/#ws://localhost:port/r/...`(localhost 即安全上下文)
  - 跨机网页:`https://LAN-IP:port+1/#wss://LAN-IP:port+1/r/...`(同源 wss,无 mixed content;首次访问需在浏览器接受一次自签警告,之后 Chrome 记住)
- **cert.ts**:零依赖自签 ECDSA P-256 X.509 v3(纯 JS ASN.1 DER——macOS 自带 LibreSSL 不支持 openssl `-addext`,CLI 不可靠)。SAN 含 LAN IP;证书持久化 `<configRoot>/collab/collab-lan-*.pem`,LAN IP 变更或过期自动重签。4 单测。
- **踩坑记录**(已固化在代码注释):DER 长度编码 `0x81/0x82` 前缀;AlgorithmIdentifier 必须 SEQUENCE 包装(裸 OID 会让 openssl/node 拒读而 asn1parse 通过);keyUsage 位序是 MSB-first(digitalSignature=0x80,keyAgreement=0x08,组合 0x88)——TLS 服务端校验 KEY_USAGE_BIT_INCORRECT;serial 首字节 ≥0x80 需前导 00。
- **修复既有 bug**:relay close() 引用未定义的 `sockets`(ReferenceError 被 catch 吞,server 泄漏)——现在用 Set 跟踪所有 socket。
- 证书警告对移动端浏览器(QR 扫码)仍存在;扫码后需手动接受。跨机零摩擦路径仍是 `/collab tunnel`(云flare 官方证书)。

## LAN 双 relay 共享房间注册表(2026-08-02 追加)

用户实测:`/collab lan` 的跨机网页链接报「会话已结束 房间不存在」——即使 host 在线。根因:LAN share 起两个独立 relay 实例(明文 port + TLS port+1),各自持有**实例私有**的 rooms map;host 注册在明文实例,浏览器 guest 连 TLS 实例 → 该实例 rooms 里没有房间 → 4004 no such room。

修复:与 kimi-code `IConnectionRegistry` 注入模式同理——`startRelayServer` 新增可选 `rooms?: Map<string, Room>` 参数,`LocalShareManager` 持有一个共享 map 传给两个实例。跨实例 socket 写直接走共享的 Peer 引用,无需额外转发层;close() 对空 map 幂等(第一个实例 close 清空 map,第二个遍历空)。

E2E 断言(lan-e2e.test.ts):host 连 joinUrl(明文)、raw TLS WebSocket 客户端连 webJoinUrl(自签,rejectUnauthorized:false)同一房间 → 必须握手成功且无 4004、host 帧可达 guest。Bun 内置 WebSocket 拒绝手写 101 与自签证书,故 guest 侧用 tls.connect + 手写握手;握手响应与致命 close 帧同段时 tail 字节必须喂给帧解析器(否则 4004 静默丢失)。

同一轮的其他修复:
- `/leave`(host 分支)现在与 `/collab stop` 一致,停 host **并**停 transport——此前只停 host,relay 端口泄漏,再次 `/collab lan` 报 "Failed to listen at 0.0.0.0"
- `/collab lan|tunnel` 失败时按模式追加中文提示:端口被占用(/collab stop first)或 cloudflared 未安装(brew install cloudflared)
- formatCollabLink 对 localhost/RFC1918 私网 wss 保留完整 scheme(原逻辑剥成 `host[:port]/r/…`,链接显示与复制时无 wss 前缀,易混淆);公共 wss relay 仍 compact

## collab 体验轮:languagechange、网卡发现、ngrok 备选(2026-08-02)

- **collab-web i18n**:监听 `window` 的 `languagechange` 事件,系统/浏览器语言切换即时生效(原为模块加载时检测一次,需刷新)。`setLocale` 已有 emit + localStorage 持久化,事件处理器只做重检。
- **LAN 网卡发现**(BitFun lan.rs 语义):`listLanIpv4()` 列出全部可路由 IPv4,排除 loopback + link-local(169.254/16),**RFC 1918 私网优先排序**(VPN/VM/docker 网卡不会遮蔽真实 LAN 网卡);`findLanIpv4()` 取排序首位。kimi-code 无网卡发现(已核实,其 kap-server 是本地 IDE assistant,不跨机)。
- **tunnel ngrok 备选**(OpenChamber 同款双 provider):`/collab tunnel` 默认 cloudflared;`/collab tunnel ngrok` 走 ngrok(`ngrok http <port> --log stdout --log-format json`,BitFun 同款语法)。`ngrok.ts` 与 `tunnel.ts` 同构:URL 扫描、30s 超时、AbortSignal、SIGTERM→SIGKILL;ENOENT 提示 `brew install ngrok/ngrok/ngrok` + `ngrok config add-authtoken` 指引。fake binary 测试 7 个 + LocalShareManager provider 转发集成测试(PATH 前缀 fake ngrok)。

## LAN 多网卡/Tailscale 支持(2026-08-02 追加)

用户要求 kimi-code web `--host` 式体验:LAN 模式列出所有可达 IP,每个都能连。

- **listLanIpv4()**:RFC1918 私网优先;排除 loopback/link-local + 不可路由特殊网段(0/8、RFC 2544 benchmark 198.18/15(VPN 假 IP)、文档网段、组播);**保留 Tailscale CGNAT 100.64/10**(tailnet 内可达,`isTailscaleIpv4` 识别)
- **/collab lan 输出**:本机 localhost 深链 + 主局域网链接 + 每张额外网卡一行(`⬤ Tailscale: https://100.x:7655/#wss://…`,按 IP 替换构造);**QR 优先编 Tailscale 链接**(手机扫码蜂窝/ WiFi 都可达),无 tailscale 时编局域网
- **证书**:ensureLanCertificate 接收 IP 数组,SAN 覆盖全部当前 IP(局域网 + Tailscale),任一 IP 变化即重签——浏览器在任何候选 IP 上都一次警告
- **link.ts**:CGNAT 100.64/10 纳入 isPrivateIpv4——`ws://100.x` 终端 join 合法 + Tailscale wss 链接保留完整 scheme(原被剥成 scheme-less compact form)
- 验证:本机 NIC en0=192.168.31.230 + utun4=100.73.130.97(tailscale);浏览器 https://100.73.130.97:7655 深链接受警告后自动加入(host 在 192 明文实例,共享 rooms 跨实例仍工作)

## Tailscale Serve:LAN 免证书警告路径(2026-08-02 追加)

用户问「证书警告能处理吗」——结论:纯 LAN IP 的自签警告无法消除(公共 CA 不给私网 IP 签证书,浏览器安全模型),但 Tailscale 用户有零警告正解:

- **tailscale serve**(`serve --bg http://localhost:<relayPort>`)把明文 relay 暴露为 `https://<machine>.<tailnet>.ts.net`——**Let's Encrypt 权威证书,浏览器无警告**,且 serve 在 443 终结 TLS、反代明文 WS,host 仍连 192.x 明文实例(共享 rooms 天然工作)。
- `startTailscaleServe()`:仅当 tailscale CLI 可用 + `serve status` 无既有配置(绝不覆盖用户 serve 配置)+ 启动成功才启用;失败(HTTPS 是 Tailscale 付费功能/无 CLI)优雅降级 null。stop() 执行 `serve reset`(只清自己创建的)。
- **QR 优先编 serve 链接**(零警告 > Tailscale IP > 局域网);展示行 `⬤ Tailscale(无证书警告)`;serve 存在时隐藏冗余的 Tailscale IP 行。
- 坑:ts.net 域名是 `<machine>.<tailnet>.ts.net` 两段,URL 正则要 `[a-z0-9.-]+`;`serve status --json` 空配置是 `{}`。
- 验证:openssl 显示 issuer=Let's Encrypt;`curl --resolve` HTTP 200(首次超时是 tailscaled 未就绪,稍后即通)。**本机 DNS 特例**:用户 mac 手动配置 114.114.114.114 覆盖了 MagicDNS split-DNS,ts.net 在本机解析不了(`dig @100.100.100.100` 正常)——手机/其他 tailnet 设备不受影响;本机场景走 localhost 深链即可。

## 纯明文 http 选项:无加密访客模式(2026-08-02 追加)

用户追问「为什么非得要证书,不搞证书应该也没警告吧;kimicode 的 web 就没警告」——真相:**警告不是证书问题,是浏览器端 E2E 加密的必然代价**。collab 每帧 AES-GCM(`collab-proto/crypto.ts` seal/open),而 `crypto.subtle` 只在安全上下文(https/localhost)存在,所以 LAN IP 上必须 https+自签 → 必警告(公共 CA 不签私网 IP)。kimi-web 没警告是因为它压根不加密:连 `http://127.0.0.1:58627`(localhost 天然安全上下文)+ bearer token 明文。

用户决定:**保留 E2E,额外加纯明文 http 选项**(「既保留加密也给个额外选项」):

- 访客带 `?plaintext=1` 加入(仅 guest;host 永远加密),relay 记录模式并在 `peer-joined` 控制消息携带 `plaintext` 标志
- 帧格式不变(仍是 `[4B peerId][payload]`),只是 payload 是裸 JSON 而非密文;relay 依旧字节透明
- **host 按收件人编码**:`CollabSocket.setPeerMode(peerId, plaintext)` + `#broadcast` 改为按 peer 定向扇出(混合房间无法单编码广播);接收端自动检测(先试 GCM open,失败 fallback JSON——GCM 认证失败概率 2^-128/块,密封帧不可能被误读为 JSON)
- 浏览器:http 页无 `crypto.subtle` → 自动降级明文模式 + 顶部横幅「明文会话:未加密——同网段可读」;https/wss 链接仍走加密
- `/collab lan` 新增一行 `无加密 http(明文,免证书警告): http://<ip>:7654/#ws://…`——QR 仍优先加密链接(serve > Tailscale IP > LAN)
- 安全语义:明文模式 = 知道 roomId 即可读(和 kimi 的 token 模型同级);host 端 hello 前不纳入 #peers(仅 setPeerMode,保持「hello 才准入」语义,防止 stale-proto 访客出现在参与者列表)
- 验证:浏览器 E2E `http://192.168.31.230:7700/#ws://…` → `isSecureContext:false` + `crypto.subtle` 缺失 + 横幅显示 + 真实会话内容明文到达(零警告);测试:plaintext-mode 2 + plaintext-socket 1;全量 coding-agent 152、web 79、proto 16、wire 1、类型 0
## Tailscale IP 行保留 + 自签警告引导(2026-08-02 追加)

- **`0591535` 反转 serve 节的「隐藏 TS IP 行」**:serve 存在时**不再**过滤原始 Tailscale IP 链接,改为保留显示(label「Tailscale IP」)。原因:MagicDNS 名称在本机被手动 DNS(114.114.114.114)遮蔽时解析不了,100.x 直连是可靠 fallback;serve 链接仍是 QR 首选(零警告),但 TS IP 行始终列出。
- **自签警告首次访问引导**(builtin-registry.ts):浏览器证书警告发生在页面加载前,页面内任何文案用户第一次都看不到 → 引导只能放终端 `/collab lan` 输出。`collabLinkHint`/`showCollabLink` 新增 `certHint` 参数:LAN 分支检测主链接与 alt 中所有非 `*.ts.net` 的 https 深链(即自签链接),存在则输出一行「首次访问浏览器会提示自签证书警告——点「高级」→「继续前往」即可」。serve(Let's Encrypt)、localhost、明文 http 链接不触发。i18n en/zh。
- **dirs.ts 注释修正**(未提交,`packages/utils/src/dirs.ts` git diff +45/−42):全文件约 45 处 OMP 拷贝残留注释(".omp"/"omp"/"$XDG_*_HOME/omp/")修正为 .musepi/musepi;保留 `omp-plugins.lock.json` 真实文件名、OMP_* env 名、`OMP_PROFILE` 参数名;tsgo 0 errors。纯注释,无行为变化。

## GUI 完善 4 阶段(2026-08-05,guided goal,9 commits)

P1 **模型设置 = /model 等价**:设置面板模型 tab 重构为左右分栏(二级圆角容器:默认/当前会话/角色模型/供应商/自定义/添加 6 tab);角色列表 = 内置 10 角色 + 自定义(daemon settings.get 新增 knownRoleIds);每角色 清除(→自动选择)+ 自定义可删;供应商 tab 可展开每供应商模型列表(TUI model-browser 详情行:ctx/out/$每M/reasoning/vision — daemon modelDetailRow 新增,models.list/listAvailable 全量返回详情);`/setup` 等价 = providers.importApiKey RPC + AuthStorage.importApiKey(新公开方法,委托 store.replaceAuthCredentialsForProvider,缓存同步同 OAuth 路径)+ GUI key 按钮弹窗;**思考等级按模型联动** = session.thinkingInfo 返回模型 supported efforts(getSupportedEfforts),ThinkingSelector 渲染 off/auto+精确档位(4 调用点:composer/welcome/settings);models.detail RPC 服务无 session 的欢迎态;修 providers.list 在无会话时永不加载的既有 bug(settings 打开卡 loading)
P2 **空态↔会话态动效**:两个 bug — ①overlap 窗口两 scene 都是 flex-1 各占一半(用户看到的"空态只显示上半");改 absolute inset-0 全尺寸共存;②FLIP morph 从未执行(flag-diff layout effect 在 store 就绪前跑 + class-toggle rAF 取消 transition);改 scene 挂载 ref callback 触发 + WAAPI 动画(不依赖 CSS transition 生命周期);反向(会话→空态)用 render 期缓存的 session frame rect(卸载后无法测量)。验证:正向 382→624/560→1037、反向 624→385/1069→560,420ms 平滑
P3 **attach 菜单 + 上下文圆环**:paperclip 菜单(两个 composer):添加图片(文件选择器 → 附件 chips)+ plan/swarm/goal 行(kimi-code-web 描述文案;plan/goal 为开关联动 session.setPlan/setGoal;swarm 为状态行 — 活跃子代理 badge,swarm 由工具驱动无 mode toggle);上下文圆环 = daemon 新增 session.contextUsage(SessionStats.contextUsage 透传),conic-gradient donut(ok/warn/danger)+ hover 悬浮详情(used/window/percent)。验证:菜单 4 行、plan 开关往返、圆环真实数据(25K/524K/5%)
P4 **消息渲染细节**:`<advisory>` 块(advisor 工具 note 格式)渲染为严重度着色卡片(blocker/concern/nit + advisor 名 + 引导语)— 此前被剥离成无样式正文;工具卡展开高度动画(WAAPI effect — body 随 open 挂载,grid 0fr→1fr 在 Chromium snap);streaming 逐行 reveal + caret、code block highlight、gfm table 均已存在,核对无缺。验证:真实会话 concern 卡片、task 工具卡 19→528px
- 遗留:STEPFUN 官网规格仍占位(官网不可达);builtin-registry +227 行未知;tk/s 字段 catalog 无数据源(TUI 同款可选 perf 列),GUI 详情行不展示

## GUI 功能完善轮(2026-08-05,openchamber 对齐)

延续 guided-goal 的 GUI 轮次,基于 openchamber v1.18.0 源码侦察(packages/ui/src)逐项复现/对齐,全部提交在 master:

- **点阵标题三轮修复**:①打字/聚焦时"一直浮现消失" = accentColors 默认参数数组每次渲染新引用 + 在 effect deps → 每次重渲染重置 built/lastW 全量重建重播入场散开;修复 = 调色板提升模块级常量 + deps 移除(实测打字 50 帧采样零清空帧);②同尺寸 resize/IO 重入不重建(canvas.width 重设会清空画布);③M 不对称 = 2×2 子采样 + 整数偏移(±半格错位导致竖线单侧侵蚀)
- **输入框阴影丢失真根因**:BorderBeam wrapper `overflow:hidden + border-radius` 裁剪 frame 自身 box-shadow(computed style 存在但绘制被裁 — 此前误判为对比度问题)。修复 = 阴影上移到 beam wrapper 绘制 + wrapper 加入 --gui-input-shadow 定义组;三处圆角统一 14px(beam/阴影/card 曾 18 vs 14 错位)
- **场景切换 morph 覆盖阴影/beam**:morphFrame 原本 transform 动画 frame 元素,阴影/beam 在 wrapper 上瞬间跳变;data-flip-anchor 移到 BorderBeam wrapper(morph 整卡)。实测双向 420ms:0.54→1.0 / 1.57→1.0 scale
- **性能轮**:Composer 双轮询(2s modes + 3s usage)每 tick setState 全量重渲染 + 后台照跑 → 值比较(JSON/数值)跳过无变化渲染 + visibilitychange 暂停(实测 hidden 4.2s 零 RPC);SettingsView 4 轮询 + AgentAvatar/tip 装饰循环同加 guard
- **富视觉 slash 菜单**:两行布局(图标 chip + accent 命令名 + 子命令提示 + kind/scope 双 tag 徽章 + 描述 + 导航提示 footer);daemon commands.list 合并 skills(TUI 同款 /skill:<name> 可执行语义,scope 徽章 = discovery source user/project)+ 55 命令 8 类 category 映射
- **会话导航**:TurnRail 改 user 消息轮次标记(openchamber PromptNavigatorRail 语义);JumpToBottomButton(滚动离开底部浮现,回底消失)+ mask-image 内容渐变(data-top/bottom-scroll 数据驱动,仅溢出时生效,openchamber ScrollShadow 同款)
- **右侧面板**:变更树(staged/unstaged/untracked 分组 + 每文件展开 diff — daemon git.status 解析 porcelain v1 + git.diff path 参数);git 面板分支 + ↑ahead/↓behind;PR 面板 gh pr list(gh 缺失明确报错,open/draft/merged 徽章);浏览器面板(URL 栏 + 5173/3000/8080/4173 快捷 + sandbox iframe);local 菜单升级 host-switcher 风格(current 徽章 + 实时延迟 + ws:// URL + 版本行 + 刷新);open-in 候选 8→16(Ghostty/BBEdit/JetBrains,~/Applications roots)。未做:guide 导读(需 range-diff + 小模型 AI 叙事,无基础设施)、并排聊天(需多 store 架构)
- **LSP 配置可见 + /queue GUI**:设置面板新增"文件与 LSP"section(8 开关:lsp.enabled/lazy/shared/formatOnWrite/diagnosticsOnWrite/diagnosticsOnEdit/diagnosticsDeduplicate + read.toolResultPreview,settings.get/set 白名单扩展);working 时 placeholder 引导 + 发送按钮变"排队发送" + deliverAs: followUp(修了 onSend 参数错位 bug — deliverAs 落进 sessionId 槽报 Unknown session: followUp)+ 新 session.queued RPC + "队列 N" chip(实测 5→0 逐条消费)。**注意**:浏览器缓存会保留旧 bundle(验证须 `?t=N` 强制刷新)

验证基准(本轮末):gui/collab-web/coding-agent tsgo 0;daemon 35/35;catalog 561 全过;截图 docs/gui-verification/(feedback-* 轮次截图全)。

## GUI 功能完整性 gap 核对(2026-08-07,openchamber v1.18.1 对照)

对照 openchamber v1.18.1 components/ 逐目录核对(含 scout 侦察 + 人工复核修正):

- ✅ **已覆盖(修正误判)**:diff 视图(DiffPane,ContextPanel 内);语音输入(dictation:lib/voice.ts + Composer 麦克风按钮);文件附件 + plan/goal 开关(AttachMenu 合体 FileAttachment+SessionGoalRow);权限卡(ApprovalCard 等价 PermissionCard);skill 补全(slash 菜单 SlashRow 覆盖 SkillAutocomplete);advisory 卡片(transcript.css);工具卡展开动画
- ⚠️ **部分/等价替代**:DraftPresetChips(无——Composer 无草稿预设 chips);QuestionCard(无独立卡片,交互问题走 approval 卡片路径);TurnChangedFilesDropdown(无——会话内变更经 diff 面板,无 turn 级文件下拉)
- ❌ **确认缺失**(openchamber 独有产品特性,musepi 无对应产品面):AutoReviewBanner(AI 自动审查横幅);TimelineDialog(会话时间线对话框);SnippetAutocomplete(代码片段补全);FileMentionAutocomplete(@文件引用补全);multirun(多会话并行运行启动器);comments(行内批注/评论,含 diff 评论浮层)
- 📌 **决策**:以上缺失项中,multirun/comments/AutoReview 属 openchamber 产品级特性(依赖其多 store/审查基础设施),musepi 当前无对应产品需求,暂不实现;Snippet/FileMention 补全与 TurnChangedFilesDropdown 为输入体验增强,列入 backlog;guide 导读 + 并排聊天维持"未做"(依赖缺失基础设施)

## GUI 远程控制 + 多会话工作台(2026-08-07)

- **弹窗动画**:CollabDialog/ConnectDialog 接入 DialogFrame(两阶段进入 pending→entered 防 backdrop-filter 闪烁 + closing 退出动画,同 Pop.tsx 机制;rAF 节流兜底 80ms);prompt-dialog 后续同款可并
- **开始共享修复**:①历史会话自动激活(collab.start 对非 live 会话调 host.activate——daemon 会话若无 SDK jsonl 报"无消息可共享"友好错误);②无会话时按钮 disabled + 提示文案
- **多会话工作台共享**(聚焦工作推进):
  - 协议:wire 新增 WorkspaceSessionInfo + workspace(目录)/workspace-session(增量)/workspace-select(聚焦切换)frames
  - CollabHost workspace 模式:hello→目录帧(非 welcome);select→焦点切换(provider.switchWorkspaceSession 重绑订阅)→重新 welcome 全体 guest;select(null)→回目录解绑
  - daemon:collab.start 加 mode 参数;stub 用真 SessionManager(修复 guest hello 崩溃:snapshotForReplication/onEntryAppended 缺失);补 settings/emitNotice/abort/promptCustomMessage cast(崩溃根因:collabDisplayName 读 ctx.settings.get);workspace provider = knownSessions 映射 + eventBus agent_start/end 目录刷新 + activate-on-focus
  - guest UI:WorkspaceView(会话卡片:标题/working 转圈/paused/消息数/相对时间/cwd/live 或 history 徽标;88 卡实测);点击 live 会话→welcome 直播流→header back 返回目录;workspace 帧取消 welcome 超时
  - Desktop CollabDialog:「当前会话 / 工作区」segmented
  - TUI:/collab workspace [lan|tunnel](目录 = listAllSessions + 当前会话 live;TUI 只能直播自身会话,其余 history disabled)
  - 验证:端到端 ws guest(目录 88/1 live→select→welcome+chunks→back);浏览器 guest 工作台渲染 + 聚焦 + 返回全通

## collab-web dist 陷阱（2026-08-07 踩坑）

- **daemon 的 relay serveStatic 从 packages/collab-web/dist/ 读文件**——src 改动（workspace 帧、i18n、UI）不 rebuild 时 guest 页面跑旧代码，表现为"等待宿主欢迎超时"（旧 client 收到 workspace 帧直接忽略）。改 collab-web 后必须 `bun run build`；daemon 无需重启（每请求读盘）。
- 浏览器两条可用路径（均实测 92 卡渲染）：https://ip:7655/#wss://ip:7655（自签证书例外**会传播到同 host wss**，点一次"继续"即可）+ http://ip:7654/#ws://ip:7654 明文同源。plaintext 备选 hash 用 host.link（已是 ws://relay.port）无需改。
- 空闲回顾文案与"终端"无关（TUI 语境残留）——已统一为"会话空闲"。

## collab 工作台可用性 + 折叠动画（2026-08-07）

- **历史会话可打开**：guest 目录中所有会话可点——daemon switchWorkspaceSession 对非 live 会话 activate-on-focus（journal 有 SDK jsonl 的都能流式）；空会话（无消息）返回友好错误 "This session has no messages to stream yet — send something first"
- **失败聚焦回目录**：guest error 帧在目录语境（#workspace !== null）只 toast 不 #end（原来 #end 整个连接——点空会话后 guest 被踢）；error 时 focusedSessionId 重置 null + phase 回 workspace。guard 必须用 #workspace 而非 phase（select 后 phase 是 "waiting" 不是 "workspace"）
- **折叠动画双向**：useCollapseHeight（collab-web/src/lib/use-collapse.ts）——body 保持挂载、--h var 驱动 height（CSS transition 220ms）、--closed 归零 padding/border（同步过渡）。border-box 下 height:0 压不掉 padding（残留 4px）——必须 content-box + --closed 清 padding。grid 0fr↔1fr 折叠仍不可用
- **bun build [hash] 陷阱**：--entry-naming=[hash] 是入口稳定 hash（非内容指纹）——改 src 后重建可能生成同名 bundle，浏览器缓存旧 JS 表现为"修了但没修"。必须 rm -rf dist 重建（bun build 输出缓存还会返回陈旧产物）；浏览器验证前先确认 script src 文件名变了
