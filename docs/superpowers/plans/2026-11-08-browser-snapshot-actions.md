# Browser Snapshot Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add expiring element/visual snapshots and explicit ref/coordinate actions to the existing browser tool, with matching prompts and user cards.

**Architecture:** A small daemon-side snapshot registry binds observations and screenshots to named tabs for 60 seconds. New actions reuse existing observation handles and the run pipeline; typed details drive client-core cards without another runtime channel.

**Tech Stack:** TypeScript, Bun tests, React 19, existing browser workers, static prompts and client-core i18n.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-snapshot-actions-design.md`

## Global Constraints

- Snapshots expire after 60 seconds and never cross named tabs.
- Element refs use existing `tab.id(n)` observations; visual coordinates map through the original screenshot/viewport ratio.
- No blind fallback after stale/invalid snapshots, no second browser tool, and no legacy action removals.
- Element pages default to 100 rows/8000 chars; limits are 1–500 rows and 2048–24000 chars.
- No new dependencies or Git commits.

## Review Focus

- Cursor continuation without `snapshotId`, expired snapshots, and cross-tab refs fail without a fresh capture or click.
- Coordinate scaling uses each snapshot's own dimensions, not current window size.
- Failed actions return an error receipt and never a fabricated success.

---

### Task 1: Snapshot registry and pure pagination/mapping

**Files:**
- Create: `packages/coding-agent/src/tools/browser/snapshots.ts`
- Create: `packages/coding-agent/test/tools/browser-snapshots.test.ts`

**Interfaces:**
- Produces expiring `create/readElementSnapshot`, `create/readVisualSnapshot`, `paginateElementSnapshot`, and `visualPointToCss` plus snapshot result types.

- [ ] **Step 1:** Write failing tests for TTL expiry, tab ownership, role/text filtering, limit/maxChars/cursor continuation, invalid cursors, and visual coordinate scaling.
- [ ] **Step 2:** Run the focused test; expect missing-module failure.
- [ ] **Step 3:** Implement the bounded registry and pure helpers with injectable time and explicit errors.
- [ ] **Step 4:** Re-run tests and coding-agent type check.

### Task 2: Tool actions and Agent prompt

**Files:**
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Modify: `packages/coding-agent/src/prompts/tools/browser.md`
- Modify: `packages/coding-agent/test/tools/browser-schema.test.ts`
- Create: `packages/coding-agent/test/tools/browser-snapshot-actions.test.ts`

**Interfaces:**
- Adds `elements`, `visual`, `click`, `fill`, `type`, `press`, `hover`, `scroll`, `drag`, `select_option`, `set_checked`, and `scroll_into_view` actions plus `elementsSnapshot`, `visualSnapshot`, and `actionReceipt` details.

- [ ] **Step 1:** Add failing schema, prompt, action-dispatch, stale-ref, and error-receipt tests.
- [ ] **Step 2:** Run focused tests; expect unknown actions and missing snapshot details.
- [ ] **Step 3:** Implement actions through the existing run path and registry. `elements` paginates one observation; `visual` maps its screenshot; ref actions use `tab.id(n)` and coordinate actions use `page.mouse`/keyboard. Preserve cancellation and image output.
- [ ] **Step 4:** Update prompt/examples with snapshot/ref/coordinate rules and error handling. Re-run focused tests and coding-agent check.

### Task 3: User cards, docs and real-page proof

**Files:**
- Modify: `packages/client-core/src/tool-render/tools/browser-structured.tsx`
- Modify: `packages/client-core/src/tool-render/tool-render.css`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Create: `packages/client-core/test/browser-snapshot-card.test.tsx`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

**Interfaces:**
- Consumes Task 2 snapshot and receipt details without importing daemon modules.

- [ ] **Step 1:** Write failing element/visual/receipt card tests.
- [ ] **Step 2:** Implement compact bilingual cards and update owning docs/changelog.
- [ ] **Step 3:** Run card and full related browser tests, client-core check, generated tool views, translation pairing and desktop build.
- [ ] **Step 4:** On an isolated real browser page, execute element and visual snapshots, ref click/fill and coordinate click; verify actual DOM state, stale-ref rejection, and card evidence.
