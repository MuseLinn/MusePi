# Structured Browser Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kimi-inspired browser state, bounded text-read and screenshot contracts to the existing tool, with matching Agent guidance and dedicated user cards.

**Architecture:** Extend the current `browser` tool rather than creating another tab registry. The managed Electron bridge supplies real panel/tab state; the existing run pipeline supplies text evaluation, operation activity and screenshots; typed details drive specialized client-core renderers.

**Tech Stack:** TypeScript, Bun tests, Electron CJS, React 19, existing static Markdown prompts and client-core i18n.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-structured-results-design.md`

## Global Constraints

- Preserve `open`/`run`/`close`, backend selection, tab ownership and user takeover.
- Text reads default to `viewport`, `maxChars=12000`, allow 2048–24000, never scroll, and continue only through `nextCursor`.
- Do not expose text-block ids as element refs or fabricate panel facts for non-GUI backends.
- Model prompts stay in static Markdown. Agent-facing schema, examples, guidance, result fields and renderer behavior must agree.
- No new dependencies or Git commits; preserve unrelated concurrent changes.

## Review Focus

- A block longer than `maxChars` must continue at the correct block/character offset without duplication or a stalled cursor (Task 1 tests).
- An invalid cursor or length must reject explicitly rather than silently reading from the start (Task 1 tests).
- Hidden/non-content DOM and offscreen viewport text must not leak into a viewport read (Task 1 real-browser verification).
- A hidden panel or non-GUI backend must not be reported as visible (Task 2 tests).
- Strict intent injection must accept the new action fields without reopening closed schema branches (Task 2 tests).

---

### Task 1: Bounded page-text collection

**Files:**
- Create: `packages/coding-agent/src/tools/browser/page-text.ts`
- Create: `packages/coding-agent/test/tools/browser-page-text.test.ts`

**Interfaces:**
- Produces: `PageTextScope`, `PageTextOptions`, `PageTextPage`, `PageTextSnapshot`, `paginateTextBlocks(blocks, options)`, `evaluatePageText(options)` and `pageTextCode(options): string`.
- `PageTextSnapshot` contains `scope`, `url`, `title`, `text`, `blocks`, `blockCount`, `totalBlocks`, `truncated`, `scanTruncated`, optional `nextCursor`, and ISO `capturedAt`.

- [ ] **Step 1:** Write failing tests for default limits, viewport/document options, mid-block continuation, next-block continuation, exhausted results, invalid cursors, and min/max lengths. Assert exact cursor positions and text, not only successful calls.
- [ ] **Step 2:** Run `bun test packages/coding-agent/test/tools/browser-page-text.test.ts`; expect missing-module failure.
- [ ] **Step 3:** Implement pure cursor pagination and a serializable DOM evaluator. Exclude hidden/script/style/template content, intersect viewport scope with the current viewport, cap scanned text nodes, and keep `scanTruncated` separate from output `truncated`. `pageTextCode` returns `return await tab.evaluate(<evaluator>, <options>);` for the existing run scope.
- [ ] **Step 4:** Re-run the focused test and `bun run --cwd=packages/coding-agent check:types`; expect PASS.

### Task 2: Structured actions, managed state and Agent prompt

**Files:**
- Modify: `packages/coding-agent/src/tools/browser/tab-protocol.ts`
- Modify: `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Create: `packages/coding-agent/src/tools/browser/state.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Modify: `packages/coding-agent/src/prompts/tools/browser.md`
- Modify: `packages/coding-agent/test/tools/browser-schema.test.ts`
- Create: `packages/coding-agent/test/tools/browser-structured-actions.test.ts`
- Modify: `apps/desktop/electron/managed-browser.cjs`
- Modify: `apps/desktop/test/managed-browser-menu-ipc.test.cjs`

**Interfaces:**
- `BrowserToolDetails` gains `status?: BrowserStatus`, `pageText?: PageTextSnapshot`, and `pageScreenshot?: ScreenshotResult & { capturedAt: string }`.
- `BrowserStatus` contains `available`, optional `panelVisible`, optional `activeTabId`/`visibleTabId`/`url`/`title`, and `tabs: BrowserTabStatus[]`.
- `listTabs(): readonly TabSession[]` exposes live supervised tabs without mutation.
- `readManagedBrowserStatus(baseUrl, signal): Promise<BrowserStatus>` reads `/musepi/state`.
- Actions are `open | close | run | status | read | screenshot`; read accepts `scope`, `maxChars`, `cursor`, and screenshot accepts `selector`, `fullPage`.

- [ ] **Step 1:** Add failing tests proving the new schema variants and intent injection, status mapping for visible/hidden panels, fallback supervised tabs, and prompt guidance for status/read/cursor/observe/screenshot. Add a host test for `/musepi/state` navigation and control fields.
- [ ] **Step 2:** Run the focused tests; expect unknown-action, missing-module, missing-endpoint and missing-guidance failures.
- [ ] **Step 3:** Implement the managed state projection and tool actions. `status` requires no tab; `read` and `screenshot` use the named open tab through the existing run path. Store typed structured details and preserve output caps, operation updates, cancellation and image content.
- [ ] **Step 4:** Update the static prompt and examples: discover with `status`, use `read` for rendered text, continue only with `nextCursor`, use `observe` for interactive refs, and use `screenshot` for appearance. State that block ids are not element refs.
- [ ] **Step 5:** Run the focused browser schema/state/host tests and coding-agent type check; expect PASS.

### Task 3: Dedicated user cards

**Files:**
- Modify: `packages/client-core/src/tool-render/tools/browser.tsx`
- Modify: `packages/client-core/src/tool-render/tools/browser-activity.ts`
- Modify: `packages/client-core/src/tool-render/tool-render.css`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Create: `packages/client-core/test/browser-structured-card.test.tsx`

**Interfaces:**
- Consumes Task 2 `status`, `pageText`, `pageScreenshot`, `result`, `screenshots`, and ordinary result image content without importing coding-agent implementation modules.

- [ ] **Step 1:** Write failing DOM tests for status rows/tab inventory, text scope/block count/truncation/capture time/raw JSON, and screenshot dimensions/capture time/image. Assert no raw JSON dump replaces the dedicated cards.
- [ ] **Step 2:** Run the renderer test; expect missing fields/cards failure.
- [ ] **Step 3:** Implement compact bilingual status, read and screenshot sections while preserving the existing run timeline and `ResultImages`. Put raw JSON behind a disclosure for structured actions and style the new sections consistently with existing browser groups.
- [ ] **Step 4:** Run renderer/browser activity tests, `bun run --cwd=packages/client-core check`, and desktop type checks; expect PASS.

### Task 4: Standing prompt rule, documentation and end-to-end proof

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1:** Add the standing rule: every agent-facing capability must consider tool schema/description, static prompt guidance, structured results, user rendering and behavior tests together, or record why no prompt change is needed.
- [ ] **Step 2:** Update bilingual owning docs and Unreleased changelog with the structured actions, prompt behavior, pagination limits and result-card ownership.
- [ ] **Step 3:** Run focused browser suites, package checks, translation pairing, changelog i18n and `git diff --check`. Record unrelated concurrent failures separately.
- [ ] **Step 4:** In an isolated real browser session, execute `status`, read a page in two cursor-bounded chunks, and take a screenshot. Verify no scrolling during reads, correct continuation and visible dedicated cards. Do not use production session storage.
