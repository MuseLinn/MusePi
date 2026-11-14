# Browser Dialogs and Tab Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured pending/handled dialogs and explicit activate/switch/release actions while preserving existing close and ownership behavior.

**Architecture:** Worker emits dialog lifecycle records through the existing supervisor and run results. Tab control uses real targets and a separate detach path; managed control is cleared in Electron so status remains authoritative.

**Tech Stack:** TypeScript, Electron CJS, React 19, Bun tests, static prompts and client-core i18n.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-dialog-control-design.md`

## Global Constraints

- `dialog_respond` acts only on the current pending dialog and records actor/outcome/text.
- `release` detaches without closing the page; `close` behavior is unchanged.
- No implicit turn-end release, no fake dialog records, and no stale managed control after release.
- Existing auto-dialog policies and upload confirmation remain intact.

## Review Focus

- Responding with no pending dialog returns an explicit error.
- Auto-handled dialogs are not also reported as Agent-handled.
- Releasing one tab must not close its target or mark it controlled in subsequent status.

---

### Task 1: Dialog protocol and actions

**Files:**
- Modify: `packages/coding-agent/src/tools/browser/tab-protocol.ts`
- Modify: `packages/coding-agent/src/tools/browser/tab-worker.ts`
- Modify: `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Create: `packages/coding-agent/test/tools/browser-dialogs.test.ts`

**Interfaces:**
- Adds `BrowserDialogInfo`, `BrowserHandledDialog`, `dialog`, `dialog_respond`, and `pendingDialogs`/`handledDialogs` details.

- [ ] **Step 1:** Write failing tests for schema, dialog response, auto-policy actor mapping, and missing-dialog errors.
- [ ] **Step 2:** Implement worker dialog state, TabApi `dialog`/`respondDialog`, result propagation and tool actions.
- [ ] **Step 3:** Run focused tests and coding-agent type check.

### Task 2: Activate, switch and detach

**Files:**
- Modify: `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Modify: `apps/desktop/electron/managed-browser.cjs`
- Modify: `apps/desktop/test/managed-browser-menu-ipc.test.cjs`
- Create: `packages/coding-agent/test/tools/browser-control.test.ts`

**Interfaces:**
- Adds `activate`, `switch`, `release`, `activateTabTarget`, `releaseManagedAgent`, `detachTab`, and `control` details.

- [ ] **Step 1:** Add failing tests proving activate does not reveal, switch activates the real target, and release detaches without closing.
- [ ] **Step 2:** Implement target activation and a separate detach path. Add `ManagedBrowser.releaseAgentTab` and make `controlled` depend on the live `agentTabId` only.
- [ ] **Step 3:** Run control and managed-host tests plus type checks.

### Task 3: Prompt, cards, docs and real-page proof

**Files:**
- Modify: `packages/coding-agent/src/prompts/tools/browser.md`
- Modify: `packages/client-core/src/tool-render/tools/browser-structured.tsx`
- Modify: `packages/client-core/src/tool-render/tool-render.css`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Create: `packages/client-core/test/browser-dialog-control-card.test.tsx`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1:** Add failing dialog/control card and prompt tests.
- [ ] **Step 2:** Implement bilingual cards and update prompt/docs/changelog.
- [ ] **Step 3:** Run the full related browser suite, client-core check, generated tool views, translation pairing and desktop build.
- [ ] **Step 4:** On an isolated real page, read and answer alert/prompt dialogs; activate, switch and release a managed tab without closing it. Verify handled records, status and card evidence.
