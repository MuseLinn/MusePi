# Overlay and Liquid Glass Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 desktop-app 与 client-core 的 tooltip、toast、alert、modal、确认和 drawer 的交互契约及液态玻璃材质。

**Architecture:** 在 client-core 提供共享模态焦点/叠层栈与破坏性确认表面，desktop 复用而不维护第二套焦点逻辑。保留现有宿主组件、Promise 动画时序和 CSS 玻璃体系；openchamber 仅提供行为参考，不引入 Base UI 或 Sonner。

**Tech Stack:** React 19、TypeScript、Bun、Biome、tsgo、Happy DOM、现有 `--glass-*` tokens。

**Spec:** `docs/gui-design.md` §5s/§5u/§5x、`docs/gui-dialog-spec.md` 及会话计划 `cyclone-rictor-tempest.md`。

## Global Constraints

- 不新增 UI 依赖；不直接编辑生成的 `tailwind.out.css` 或 catalog `models.json`。
- 不提交 git commit；所有改动留在工作区。
- 遵守 `AGENTS.md`：无 `ReturnType`、无内联类型 import、Promise 使用 `Promise.withResolvers()`、测试不断言源码文本。
- 新 UI 文案同步 zh-CN/en-US 域文件；活跃双语文档同步并更新 pairing hash。
- 测试与 smoke 不接触生产 session store 或 daemon socket。

## Review Focus

- 嵌套 modal 的开关顺序与 component unmount：只有最上层响应键盘，opener 已断开时不抛错；Task 1 测试嵌套栈和失效 opener。
- destructive confirm 的 Enter、重复 Enter 和重复请求：不执行删除且 Promise 不悬挂；Task 2 测试。
- toast 在 hover、focus、重新渲染和定时器交叉时的剩余时间：不能提前消失或误删新 toast；Task 4 测试。
- tooltip 原有多值 `aria-describedby`、窗口由窄变宽、触屏移动：关联不丢失、宽度恢复、长按不误触；Task 4 测试。
- reduced-motion、reduced-transparency、Windows 无 blur：进出无中间动画且文本可读；Task 5 的 CSS 与实机验收。

---

### Task 1: 共享 modal focus 与叠层栈

**Files:**
- Create: `packages/client-core/src/lib/modal-focus.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `packages/desktop-app/src/lib/use-focus-trap.ts`
- Test: `packages/client-core/test/modal-focus.test.tsx`

**Interfaces:**
- Produces: `useModalFocus<T extends HTMLElement>(active: boolean, options?: { initialFocus?: "first" | "container" }): RefObject<T | null>`。
- Produces: `isTopModal(element: HTMLElement): boolean`，供 modal Escape handler 判断键盘所有权。

- [ ] 写失败测试：首焦点、空容器 fallback、Tab/Shift+Tab 循环、关闭恢复 opener、嵌套仅顶层响应、卸载安全。
- [ ] 运行 `bun test packages/client-core/test/modal-focus.test.tsx`，确认因 API 不存在而失败。
- [ ] 实现共享 hook 与栈；desktop `useFocusTrap` 保留原签名并委托共享 hook。
- [ ] 重跑测试及 `bun run --cwd=packages/client-core check:types`，要求通过。

### Task 2: DialogFrame 与 Promise confirm

**Files:**
- Modify: `packages/desktop-app/src/components/DialogFrame.tsx`
- Modify: `packages/desktop-app/src/lib/prompt-dialog.tsx`
- Modify: 删除会话/项目等 `useConfirm` 调用点
- Test: `packages/desktop-app/test/dialog-frame.test.tsx`
- Test: `packages/desktop-app/test/prompt-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `useModalFocus` / `isTopModal`。
- Produces: `confirm(message: string, okLabel?: string, options?: { destructive?: boolean }): Promise<boolean>`；原两参数调用不变。

- [ ] 写失败测试：phase 变化不抢焦点、可访问名称、普通 Enter 确认、destructive Enter 不确认且默认焦点取消、所有取消路径 settle 一次。
- [ ] 运行上述两个测试，确认出现对应失败。
- [ ] DialogFrame 接入共享焦点；prompt/confirm 使用同一焦点和顶层栈规则，保留 180ms 退场后 resolve。
- [ ] 永久删除调用显式传 `destructive: true`，普通确认保持 Enter 行为。
- [ ] 重跑测试和 `bun run --cwd=packages/desktop-app check:types`。

### Task 3: 私有 modal、drawer 与原生确认迁移

**Files:**
- Create: `packages/client-core/src/components/shell/ConfirmDialog.tsx`
- Modify: `packages/client-core/src/components/agents/AgentDrawer.tsx`
- Modify: `packages/client-core/src/components/shell/SessionsSheet.tsx`
- Modify: `packages/client-core/src/components/panels/FilePanel.tsx`
- Modify: `packages/client-core/src/components/shell/WorkspaceView.tsx`
- Modify: desktop `TaskModal.tsx`、`CapabilityCenter.tsx`、`BoardPage.tsx`、`SketchPad.tsx`、`OnboardingOverlay.tsx`、`AnnouncementOverlay.tsx` 及 client-core `image-lightbox.tsx`
- Test: `packages/client-core/test/confirm-dialog.test.tsx`
- Test: `packages/client-core/test/sessions-sheet.test.tsx`

**Interfaces:**
- Produces: `ConfirmDialog({ open, title, confirmLabel?, busy?, onConfirm, onClose }): ReactNode`，destructive 永远不允许 Enter 确认。
- Consumes: Task 1 的 modal hook。

- [ ] 写失败测试：ConfirmDialog 的取消/确认/忙状态/危险 Enter；sheet 的焦点归还、Escape claim 与隐藏滑动操作不可 Tab。
- [ ] 运行测试并确认失败。
- [ ] 实现 ConfirmDialog 并替换两个 `window.confirm`；私有桌面与移动浮层接入共享焦点、ARIA 和 Escape 规则，保留各自动画和手势。
- [ ] 重跑 client-core 测试与 desktop 相关测试。

### Task 4: Toast 与 tooltip 行为

**Files:**
- Modify: `packages/desktop-app/src/lib/action-toast.ts`
- Modify: `packages/desktop-app/src/components/ActionToast.tsx`
- Modify: `packages/desktop-app/src/lib/tooltips.ts`
- Modify: `packages/desktop-app/src/components/RailTooltip.tsx`
- Modify: `packages/client-core/src/components/shell/Toasts.tsx`
- Modify: client-core 入口与 BrowserGuiHint 挂载/样式
- Test: `packages/desktop-app/test/action-toast.test.ts`
- Test: `packages/desktop-app/test/tooltips.test.ts`
- Test: `packages/client-core/test/toasts.test.tsx`

**Interfaces:**
- Preserves: `pushActionToast`、`dismissActionToast`、`initTooltips` 的现有公开签名。
- Produces: toast 的 hover/focus 暂停、手动关闭、按 kind 的 live-region 语义；tooltip 的 aria 合并恢复和触屏长按。

- [ ] 扩充失败测试：toast 暂停/恢复/关闭/错误持久；tooltip 保留原 aria token、宽窄窗口恢复、触屏移动取消。
- [ ] 运行测试确认失败。
- [ ] 实现行为并接入 client-core tooltip；RailTooltip 增加稳定 id 与 focus 等价路径；BrowserGuiHint 与统一 corner 消除竞争。
- [ ] 重跑相关测试。

### Task 5: 玻璃、降级与文档

**Files:**
- Modify: desktop `gui-composer.css`、`gui-chat.css`、`gui-widgets.css`、`gui-workspace.css` 中对应规则
- Modify: client-core `shell.css`、`agents.css`、`tokens.css` 中对应规则
- Modify: `docs/gui-design.md`、`docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md`、`docs/gui-implementation.zh-CN.md`
- Modify: `docs/gui-dialog-spec.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

**Interfaces:**
- Consumes: 现有 `--glass-bg(-strong)`、`--glass-border`、`--glass-sheen`、`--glass-shadow`、`--spring-liquid`；不新增平行玻璃体系。

- [ ] tooltip/toast/drawer 采用 L2，modal/确认采用 L3；移除硬编码深色 ApprovalCard 和表外 scrim。
- [ ] 所有相关浮层同时降级 entrance/exit；补 reduced-transparency、无 backdrop-filter 与 Windows 无 blur 的可读性规则。
- [ ] 文档形成六类浮层选择表和键盘/焦点/材质契约，记录嵌套栈真实行为并移除已还清 debt；同步翻译、changelog 与 pairing hash。
- [ ] 运行 `bun run verify-translation-pairing`、`bun run check:changelog-i18n` 和相关 CSS 检查。

### Task 6: 全量验证与实机走查

**Files:**
- Modify: 仅修复验证发现的问题。

- [ ] 运行 `bun run --cwd=packages/client-core check` 与 `bun run --cwd=packages/client-core test`。
- [ ] 运行 `bun run --cwd=packages/desktop-app check`、`bun test packages/desktop-app/test`、`bun run --cwd=packages/desktop-app build`。
- [ ] 通过 `bun scripts/dev-smoke.ts -- <command>` 启动隔离环境，验证 modal、嵌套确认、toast、tooltip、drawer、sheet 的鼠标与键盘完整流程。
- [ ] 检查深色/浅色、窄屏、reduced-motion 的真实窗口截图；Windows 验证无 blur 补偿，无法本机验证的 macOS 原生模糊明确标注。
- [ ] 汇总改动、测试证据和未验证平台限制；不提交 commit。
