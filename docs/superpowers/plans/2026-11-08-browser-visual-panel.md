# Browser Visual Actions and Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe interactive-click candidates, visual text entry, element-scoped reads, and managed panel activation to the existing browser tool.

**Architecture:** Compile visual actions into the existing run scope, resolve element handles for subtree reads, and use a dedicated managed-panel command for authoritative visibility. Return candidates without clicking when the requested point is not interactive.

**Tech Stack:** TypeScript, Puppeteer, Electron CJS, Bun tests, React 19, static prompts and client-core i18n.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-visual-panel-design.md`

## Global Constraints

- Nearby candidates are never clicked automatically; only the exact interactive target is clicked.
- Radius defaults to 48 and is bounded to 8–128.
- Element reads resolve the same snapshot ref and exclude sibling text.
- Panel reveal changes only visibility, not tab ownership or active target.
- Execute inline without commits.

## Review Focus

- A noninteractive point near a button must not click the button.
- Radius outside 8–128 must be rejected before mouse input.
- Visual replacement must select existing text before typing.
- Element-scoped text must exclude siblings and preserve pagination.
- activate_panel must reveal without creating or switching a tab.

---

### Task 1: Safe visual interactions

**Files:**
- Modify: `packages/coding-agent/src/tools/browser/snapshot-actions.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Modify: `packages/coding-agent/test/tools/browser-snapshot-actions.test.ts`
- Modify: `packages/client-core/src/tool-render/tools/browser-structured.tsx`
- Modify: `packages/client-core/test/browser-snapshot-card.test.tsx`

**Interfaces:**
- Produces `click_if_interactive` and `visual_type` results with outcome/candidates, using existing visual snapshots and receipts.

- [ ] Add failing tests for exact clicks, no-click candidates, radius validation, visual type/replace and press focus.
- [ ] Implement interactive detection, bounded candidates, visual typing and optional press focus.
- [ ] Run snapshot and card tests plus client-core type check.

### Task 2: Element-scoped text and panel activation

**Files:**
- Modify: `packages/coding-agent/src/tools/browser/page-text.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Modify: `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Modify: `apps/desktop/electron/managed-browser.cjs`
- Create: `packages/coding-agent/test/tools/browser-element-text-panel.test.ts`
- Modify: `apps/desktop/test/managed-browser-menu-ipc.test.cjs`
- Modify: `packages/client-core/test/browser-structured-card.test.tsx`

**Interfaces:**
- `read` accepts `scope:"element"`, `snapshotId`, `ref`; `activate_panel` publishes `control { action:"activate_panel", panelVisible:true }`.

- [ ] Add failing tests for subtree-only text, missing ref, and panel reveal without target changes.
- [ ] Implement handle-scoped reads and the managed activation path/card.
- [ ] Run element-text, panel host and card tests.

### Task 3: Prompt, docs and real-page proof

**Files:**
- Modify: `packages/coding-agent/src/prompts/tools/browser.md`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] Add failing prompt assertions for no-click candidates, visual typing, element text and panel activation.
- [ ] Update examples, guidance, bilingual docs and changelog.
- [ ] Run the full related browser suite, generated views and desktop build.
- [ ] On isolated real pages, prove no-click candidates, exact click, visual typing, subtree-only text and authoritative panel visibility; perform scoped self-review.
