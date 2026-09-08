---
name: musepi-contributing
description: MusePi 仓库提交规范助手——帮用户按项目模板与 CONTRIBUTING 规范起草/提交 GitHub issue、pull request、commit message 与 changelog，以及跑 release 流程。触发：用户要"提 issue/PR"、"写 PR body"、"提交代码"、"commit 规范"、"发版/release"、或询问仓库贡献流程。
---

# MusePi 贡献与提交规范

本 skill 汇总 MusePi 仓库（`MuseLinn/MusePi`）的 issue / PR / commit /
release 模板与硬性规范，供 agent 代表用户起草与执行提交流程。所有内容以仓库
实际文件为准，动手前先读对应模板，不要凭记忆编造。

## 模板位置（先读再写）

| 用途 | 文件 |
|---|---|
| PR 模板 | `.github/PULL_REQUEST_TEMPLATE.md` |
| Bug / Feature / Question issue | `.github/ISSUE_TEMPLATE/{bug_report.yml, feature_request.yml, question.yml, config.yml}` |
| 贡献总规范 | `CONTRIBUTING.md` |
| 变更记录 | `packages/coding-agent/CHANGELOG.musepi.md`（musepi 双语版，启动"新功能"面板 + `/changelog` 数据源；有 `[Unreleased]` 段待填） |
| 发布脚本 | `scripts/release.ts` |

## 硬性规范（违反即被拒/失礼）

1. **PR body 必须包含用户本人写的一句话**（解释改了什么、为什么）——生成的
   摘要/粘贴的 agent 记录/纯 checklist 都不满足。提交前向用户要这一句。
2. **PR 三段式 + checklist**：`## What` / `## Why`（关联 issue 用 `fixes #N`）/
   `## Testing`；勾选 `bun check` 通过、本地实测、用户可见变更更新 CHANGELOG。
3. **不要为即将自己实现的工作开 issue**——维护者可能并行抢做。
4. **major/跨包改动先讨论**（Discord/issue），不要直接大 PR。
5. **AI 辅助提交四约束**：限范围拒绝无关改动、逐文件 review 并理解行为、
   自己跑相关 check 与行为验证、**由用户发布**（agent 不自主任 push/发布）。
6. **Issue 模板字段**：Bug 必填 Description / Steps / Expected / Platform
   （含 Windows native）/ **MusePi version**（`musepi --version` 输出，非 omp）/
   Bun version；Provider / Area 下拉选最贴近项。

## Commit 与 changelog 惯例

- 标题用 conventional commits（`fix(scope): …` / `feat(scope): …` /
  `chore: …` / `docs: …`），正文可中文详述。
- 用户可见变更要在 `CHANGELOG.musepi.md` 的 `[Unreleased]` 下补条目
  （中文要点 + `EN:` 英文版，对齐 0.4.20 条目的双语格式），随功能 commit 一起提交。
- 改了源码必须过该包/全仓 check（`bun run check` 风格），Rust 文件要
  `cargo fmt`，import 顺序要 biome organize（只跑 tsgo 会被全仓 check 拦下）。
- 涉及 win32 spawn 的改动参考仓库既有模式（windowsHide / CREATE_NO_WINDOW，
  避免 cmd.exe shim 孙进程闪窗），不要引入新的 console 泄漏。

## 发布（release）

- 全自动脚本：`bun scripts/release.ts patch`（要求 main 分支 + clean 工作树）：
  版本 bump → 锁文件重生成 → changelog 归档 → 全仓 check → commit
  `chore: bump version to X.Y.Z` → tag `vX.Y.Z` + push → watch CI。
- 中途失败（bun install EPERM、check 报格式）→ `git reset --hard HEAD` 修好后重跑；
  bump 中间态不要手工提交，release 会在最后统一 commit。
- CI 单 job flake（如 runner 下载原生包失败）→ run 结束后
  `gh run rerun --failed` 重跑，不要动代码。
- models.json 是 `bun run gen:models` 生成物；本机 codex OAuth discovery 是
  账号范围的，全量重生成会把 openai-codex 缩水（9→4）——需要全量 regen 时在
  凭证完整的环境做，或只做定向合并。

## 回答纪律

- 先给结论（格式/动作），再给模板路径与要点；引用具体文件。
- 不确定的模板字段去读 `.github/` 下的 yml/md，不要凭旧版 omp 模板回答
  （MusePi 已本地化：版本字段是 `musepi --version`，链接指向 MuseLinn/MusePi）。
