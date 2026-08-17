# musepi-omp 上游同步计划:v17.2.1 → v17.2.2

> 状态:分析完成,待执行。2026-08-01
> 数据源:本地 `oh-my-pi/`(已 pull 到 v17.2.2,`80627462b`)

## 1. 结论摘要

上游 17.2.1 → 17.2.2 共 **223 commits / 306 files(+61,634 / −3,559)**。

musepi-omp 为独立 git 仓库(3 commits,与 oh-my-pi 无共享历史),**不能 merge/cherry-pick,只能 diff/patch 移植**。

移植总策略:**以 v17.2.2 为基底 + sed 重放 `@musepi`→`@musepi` import 重命名 + 保留 musepi 本地定制(视频 WIP、agnes/stepplan provider、品牌元数据)**。

## 2. 文件三态分类(306 files)

| 类别 | 数量 | 处理方式 |
|---|---|---|
| **NEW**(musepi 无此文件) | 29 | 直接复制 v17.2.2 版本 + rename |
| **PURE_UPSTREAM**(musepi == v17.2.1) | 49 | 直接覆盖为 v17.2.2 + rename |
| **THREE_WAY**(双方都改) | 228 | 三方合并,见第 4 节 |
| SAME / ALREADY | 0 | — |

### NEW(29)
- `crates/pi-voice/*`(新 crate:BUILD.bazel / bazel/maudio_layout.rs / src/audio.rs)
- `bazel/patches/audiopus-sys-libdir.patch`
- `packages/ai/src/registry/gmi-cloud.ts` + `packages/catalog/test/gmi-cloud-provider.test.ts`(17.2.2 新增 GMI Cloud provider)
- `packages/agent/test/compaction-summary-cap.test.ts`
- coding-agent 测试 15 个(codex-auto-reset-integration、kernel-owner-scoping、reload-plugins-mcp、browser-profile-cleanup、duckduckgo 等)
- `python/musepi-rpc/*`(5 个:client/protocol/__init__ + 2 tests)
- 其他:catalog synthetic/google-aistudio 测试、mnemopi statement-lifetime、fixtures/cli-initial-title-probe、otel-resource-probe、chromium-probe

### PURE_UPSTREAM(49,直接覆盖)
- **hashline/src/\*** 全部 11 个(apply/block/clipboard/format/grammar.lark/input/messages/parser/patcher/prefixes/prompt.md/tokenizer/types)——musepi == v17.2.1,上游 27 files / +1508 −1028 重构,全量采用
- catalog 8 个(src/models.ts、generated-policies、compat/openai、discovery/cursor、hosts、cache-provider-id、cursor-discovery.test)
- ai 3 个(transform-messages、openai-codex-reset、bedrock 测试等)
- coding-agent 9 个(eval/js/executor、hotkeys-markdown、plan-mode-active.md、reset-usage、persisted-revive、bash-interceptor、shell-tokenize、web/search/types)
- docs 7 个、natives 2 个、tui 1 个、mnemopi 3 个、scripts 1 个

## 3. musepi 本地定制清单(合并时必须保留)

| 定制 | 位置 | 处理 |
|---|---|---|
| `@musepi/*` → `@musepi/*` import | 全部 TS | sed 自动重放 |
| 品牌元数据(name/version/bin/homepage) | 各 package.json | 保留 musepi 值,只合并 dependencies |
| **agnes provider**(MusePi 私有) | `packages/ai/src/registry/agnes.ts` | 保留,registry.ts 合并时重放 |
| **stepplan provider**(MusePi 私有) | `packages/ai/src/registry/stepplan.ts` | 同上 |
| **视频 WIP**(`"video"` input capability) | `packages/catalog/src/provider-models/openai-compat.ts` | 上游 17.2.2 已吸收 video 支持(4 处),无需再打补丁 |
| collab-web i18n(用户可见文本 t()) | `packages/collab-web/src/**` | 三方合并时保留 |
| package-lock.json 删除 | 根目录 | musepi 用 bun.lock,保留删除 |

## 4. THREE_WAY(228)处理子分类

按"v17.2.2 + rename 后与 musepi 的差异行数"分级:

| 子类 | 数量 | 处理 |
|---|---|---|
| 差异小(≤20 行) | ~110 | 手工三方合并(上游新逻辑 + musepi 定制) |
| 差异中(20-100 行) | ~60 | 同上,逐文件 diff 审查 |
| 差异大(100-900 行) | ~55 | 重点:见下 |

### 大差异重点文件(按行数排序)
1. `coding-agent/test/codex-auto-reset.test.ts`(905)— 上游重写 codex saved-reset 算法
2. `coding-agent/src/session/agent-session.ts`(856)— **核心**:上游重写 codex-auto-reset 接口(CodexAutoRedeemCoordinator → evaluateCodexAutoRedeem),musepi 有视频/agnes 集成
3. `coding-agent/src/session/codex-auto-reset.ts`(794)— 上游整体重写
4. `mnemopi/src/core/beam/store.ts`(727)— 上游语句生命周期修复,musepi 可能有定制
5. `catalog/src/provider-models/openai-compat.ts`(627)— video 定制与上游新逻辑融合
6. `ai/src/providers/cursor.ts`(456)— 上游 cursor K3 replay 系列
7. hashline/test/*(438/413/312/306/263/181/159/140)— musepi 的测试与 v17.2.1 有差异,需逐个审查
8. `coding-agent/src/sdk.ts`(300)— 上游 sdk 新选项(musepi 有 @musepi 定制)
9. `coding-agent/src/task/executor.ts`(249)— 上游任务守卫
10. `tui/src/terminal.ts`(220)— 上游 code block 保留
11. package.json(228)— 依赖合并
12. `AGENTS.md`(179)— musepi 版保留,按需更新

## 5. 执行步骤

1. **备份基线**:`git stash` 或记录当前 HEAD(503726c)与 213 个本地修改文件清单(已存 /tmp/classify3.txt)
2. **NEW(29)**:`git show v17.2.2:<f> | sed @musepi→@musepi > musepi-omp/<f>`
3. **PURE(49)**:同上直接覆盖
4. **THREE_WAY 小差异(~110)**:`git show v17.2.2 + rename` 后手工 merge musepi 定制
5. **THREE_WAY 大差异(~55)**:逐个文件三方 diff(v17.2.1 ↔ v17.2.2 ↔ musepi),保留 musepi 定制 + 吸收上游
6. **依赖合并**:每个 package.json 用 musepi 元数据 + 上游 dependencies
7. **bun.lock**:上游 v17.2.2 的 bun.lock + musepi patches(3 个 patch 文件保留)
8. **验证**:bun install → build → 测试 → 冒烟
9. **更新 UPSTREAM.md**

## 6. 风险

- **codex-auto-reset 接口重写**(最高):agent-session.ts + codex-auto-reset.ts 是联动重构,合并错误会破坏会话循环。建议先合并这两文件并跑 agent-session 测试
- **hashline 重构**:上游 27 文件重构,musepi 的 edit/hashline/*(coding-agent 侧 5 个文件)需同步适配
- **bun.lock 冲突**:musepi patches(@ark/schema、puppeteer-core、@agentclientprotocol/sdk)必须保留
- **pi-voice 新 crate**:需要 bazel/native 构建链支持,若环境不支持可延迟(不影响 TS 主链路)
- **python/musepi-rpc**:新模块,musepi 若无 python 侧需求可延迟

## 7. 决策点(需用户确认)

1. **GMI Cloud provider**:17.2.2 新增,全量移植应包含——是否引入?(默认:引入)
2. **pi-voice crate**:新增 Rust crate,涉及 native 构建——本次是否移植?(默认:先复制文件,构建验证失败则延迟)
3. **python/musepi-rpc**:新增 Python 模块——是否移植?(默认:复制,不影响主链路)
