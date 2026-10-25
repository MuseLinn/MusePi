# Panel Tabs and PR Workspace Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 整理 Issue/PR 工具区、右侧零标签卡片空态，并为 surface/browser 标签增加统一且可降级的开关动效。

**Architecture:** 保留现有业务状态和 WebView dispose 顺序，新增一个只管理展示标签的 `useTabMotion`。PR 工具区使用局部 grid，右侧空态沿用现有 flex 高度链和 card tokens。

**Tech Stack:** React 19、TypeScript、Bun、Biome、Happy DOM、现有 CSS motion tokens。

**Spec:** 会话计划 `john-stewart-green-arrow-gorgon.md` 与 `docs/gui-design.md` 的 panel tabs、motion 和 master-detail 规范。

## Global Constraints

- 不新增依赖，不提交 commit，保留其他未提交工作。
- 不改变 webview ref detach → guest-gone → main dispose 顺序。
- 不用 transform 动画覆盖 dnd-kit inline transform；不做 source-grep 测试。
- 双语文档和 changelog 必须保留其他工作区条目。

## Review Focus

- 关闭中重开：不能误删重新出现的标签；Task 1 测试。
- 首次恢复与 active/title 更新：不能重播动画；Task 1 测试。
- closing 标签：不得进入 roving tabindex 或 dnd items；Task 1/2 测试。
- 浏览器最后一个标签关闭：业务仍立即删除并自动重建，动画不能延迟 dispose；Task 2 测试。
- 窄屏工具区和空态：内容不得溢出或回到顶部；Task 3 测试与真实截图。

---

### Task 1: 共享标签展示生命周期

**Files:**
- Create: `packages/desktop-app/src/lib/use-tab-motion.ts`
- Test: `packages/desktop-app/test/tab-motion.test.tsx`

**Interfaces:**
- Produces: `useTabMotion<T extends { id: string }>(tabs: readonly T[]): { tabs: readonly T[]; enteringIds: ReadonlySet<string>; closingIds: ReadonlySet<string> }`。

- [ ] 写失败测试：首次无 entering、 added entering、removed closing 后清理、closing 中重开取消、active/title 更新不重播、卸载清理。
- [ ] 运行测试，确认模块不存在而失败。
- [ ] 实现 130ms enter / 140ms closing 和 timer 清理。
- [ ] 重跑测试与 desktop `check:types`。

### Task 2: Surface 与浏览器标签接入

**Files:**
- Modify: `packages/desktop-app/src/components/surface-tabs.tsx`
- Modify: `packages/desktop-app/src/components/ManagedBrowserPane.tsx`
- Modify: `packages/desktop-app/src/styles/gui-settings.css`
- Test: `packages/desktop-app/test/surface-tabs.test.tsx`
- Test: managed browser 现有相关测试

**Interfaces:**
- Consumes: Task 1 `useTabMotion`。

- [ ] 写失败测试：closing 不进入 tab 顺序或 dnd items，host tabs 仍立即删除且 active 邻居语义不变。
- [ ] 运行并确认失败。
- [ ] 两套 strip 接入展示状态；closing `aria-hidden`/`inert`/不可拖，CSS 仅 opacity/max-width，reduced-motion 即时完成。
- [ ] 重跑相关测试，确认浏览器 dispose 调用顺序未变。

### Task 3: PR 工具区与右侧空态

**Files:**
- Modify: `packages/desktop-app/src/components/pr-center.tsx`
- Modify: `packages/desktop-app/src/styles/gui-workspace.css`
- Modify: `packages/desktop-app/src/styles/gui-settings.css`
- Test: `packages/desktop-app/test/pr-center.test.tsx`

**Interfaces:**
- Produces: `.gui-pr-toolbar` 搜索+subtabs 组合；`.gui-panel-empty-list` 自适应卡片 grid。

- [ ] 写失败测试：搜索和 subtabs 同属 toolbar；窄屏列表选择与 filters 保持各自区域。
- [ ] 实现 toolbar grid、filters 明确左右区和空态垂直居中卡片 grid。
- [ ] 重跑 PR/右侧相关测试与 desktop check/build。

### Task 4: 文档与真实验证

**Files:**
- Modify: `docs/gui-design.md`、`.zh-CN.md`、`docs/gui-implementation.md`、`.zh-CN.md`、pairing yaml、`packages/coding-agent/CHANGELOG.musepi.md`

- [ ] 同步工具区、空态和标签 chrome 契约，删除 880px 旧口径；更新 pairing hash 和 Unreleased 双语条目。
- [ ] 运行 changelog/i18n/docs/CSS 门禁。
- [ ] 用隔离 Web + daemon 检查 PR 宽窄屏、右侧空态、两套标签开关和 reduced-motion 截图；若 Electron 可用则补实窗，不可用则明确平台限制。
- [ ] 独立评审全部差异并修复 Critical/Important，不提交 commit。
