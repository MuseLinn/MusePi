# Browser Extensions UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a truthful, discoverable extensions/profile-data workflow to the managed browser and group browser settings without changing guest or Agent architecture.

**Architecture:** Shared renderer components call the existing daemon RPCs. A small preference model coordinates toolbar/settings state; the existing floating-menu and segmented controls provide all overlay and keyboard behavior.

**Tech Stack:** React 19, TypeScript, Bun tests, existing MusePi `Icon`, `Segmented`, `useFloatingMenu`, and daemon JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-extensions-ux-design.md`

## Global Constraints

- Do not change webview ownership, panel-tab projection, Agent/CDP behavior, or add dependencies.
- Import copy must say cookies + localStorage → shared automation Chromium; never imply passwords, managed-partition import, or sync.
- Reuse `useFloatingMenu`, `Segmented`, `Icon`, and existing preference storage/event patterns; add zh-CN and en-US copy together.
- Preserve unrelated worktree edits. Do not commit.

## Review Focus

- RPC rejection or a false/empty result must produce visible failure feedback rather than a permanent spinner (Tasks 2 and 3).
- Shared-Chromium actions must not be described as managed-browser data operations (Tasks 2 and 3).
- Hiding the extensions button must not remove access through Settings → Extensions (Tasks 1 and 4).
- Popup content must remain usable on blank tabs and narrow panes (Task 4).
- Switching settings tabs must preserve the existing engine/Agent/runtime controls and their live state (Task 3).

---

### Task 1: Browser preference and address models

**Files:**
- Create: `packages/desktop-app/src/lib/browser-preferences.ts`
- Create: `packages/desktop-app/src/lib/browser-address.ts`
- Create: `packages/desktop-app/test/browser-preferences.test.ts`
- Create: `packages/desktop-app/test/browser-address.test.ts`
- Modify: `packages/desktop-app/src/components/ManagedBrowserPane.tsx`

**Interfaces:**
- Produces: `BrowserSettingsTab = "general" | "extensions" | "data"`; `readBrowserSettingsTab()`, `writeBrowserSettingsTab(tab)`, `readBrowserExtensionsToolbarVisible()`, `writeBrowserExtensionsToolbarVisible(visible)`, `readBrowserShowFullUrl()`, `writeBrowserShowFullUrl(visible)`, and `BROWSER_PREFERENCES_CHANGED_EVENT`.
- Produces: `formatAddressDisplayParts(url, title?, showFullUrl = true)` returning `{ url, title? }`.

- [ ] **Step 1: Write failing model tests.** Cover unknown/corrupt stored values, all three settings tabs, boolean round trips, change-event delivery, blank URLs, and full versus host-only address display.
- [ ] **Step 2: Run `bun test packages/desktop-app/test/browser-preferences.test.ts packages/desktop-app/test/browser-address.test.ts`; expect missing-module failure.**
- [ ] **Step 3: Implement the models and move the existing address formatter behind the new optional `showFullUrl` argument.** Storage keys are `musepi-gui-browser-settings-tab`, `musepi-gui-browser-extensions-toolbar`, and `musepi-gui-browser-show-full-url`; writes dispatch the shared change event.
- [ ] **Step 4: Re-run the focused tests; expect PASS.**

### Task 2: Shared Chrome import card

**Files:**
- Create: `packages/desktop-app/src/components/browser-import-card.tsx`
- Create: `packages/desktop-app/test/browser-import-card.test.tsx`

**Interfaces:**
- Consumes: existing `RpcClient.request("browser.importChrome", {})` returning `{ ok?: boolean; importedFrom?: string; error?: string }`.
- Produces: `BrowserImportCard({ rpc, compact?, dismissible?, onOpenData? })` with inline import progress/result and optional dismissal/settings actions.

- [ ] **Step 1: Write failing component tests.** Assert the destination copy, a real RPC call on Import, inline error on `{ok:false,error}` and rejection, success feedback, dismissal persistence, and `onOpenData` navigation.
- [ ] **Step 2: Run `bun test packages/desktop-app/test/browser-import-card.test.tsx`; expect missing-component failure.**
- [ ] **Step 3: Implement the card with `Icon`, local state, guarded async completion, and the shared dismissal key `musepi-gui-browser-import-dismissed`.** No password or managed-profile claims; preserve the error text and do not reduce success to a raw filesystem path.
- [ ] **Step 4: Re-run the test; expect PASS.**

### Task 3: Relay/extensions panel and settings views

**Files:**
- Create: `packages/desktop-app/src/components/browser-extensions-panel.tsx`
- Create: `packages/desktop-app/test/browser-extensions-panel.test.tsx`
- Modify: `packages/desktop-app/src/components/settings-sections/browser.tsx`
- Modify: `packages/desktop-app/src/components/SettingsNav.tsx`
- Modify: `packages/desktop-app/src/app.tsx`

**Interfaces:**
- Consumes: Task 1 preference API and Task 2 `BrowserImportCard`.
- Consumes: `browser.relayStatus`, `browser.relayInstall`, `browser.relayUninstall`, and `browser.extensions` RPCs.
- Produces: `BrowserExtensionsPanel({ rpc, compact? })` and settings tabs `general | extensions | data`.

- [ ] **Step 1: Write failing panel tests.** Cover Relay status copy, install/uninstall calls and failures, shared-extension loading/empty/list states, and the shared-Chromium label.
- [ ] **Step 2: Run `bun test packages/desktop-app/test/browser-extensions-panel.test.tsx`; expect missing-component failure.**
- [ ] **Step 3: Implement the panel with guarded loading and action state, then place it plus the toolbar-visibility control under Settings → Extensions and the import/clearing controls under Settings → Data.** Use `Segmented`; retain existing engine, Agent, glow, and runtime rows under General. Allow the existing settings-section event to open the Data/Extensions view through the preference model.
- [ ] **Step 4: Run the new panel test and existing browser/settings contract tests; expect PASS.**

### Task 4: Managed-browser toolbar popup

**Files:**
- Modify: `packages/desktop-app/src/components/ManagedBrowserPane.tsx`
- Modify: `packages/desktop-app/src/styles/gui-settings.css`
- Modify: `packages/desktop-app/test/managed-browser-pane-menu.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 public components/preferences.

- [ ] **Step 1: Add failing menu tests for the pinned extensions button, popup dismissal, import/Relay content on a blank tab, and hidden-button preference.** Add RPC stubs required by the new children.
- [ ] **Step 2: Run the focused pane test; expect missing button/content failure.**
- [ ] **Step 3: Add a puzzle/extensions trigger beside More actions using `useFloatingMenu`, render compact import/extensions components, and honor toolbar/full-URL preferences without touching webview state.** Style a width-capped, internally scrollable popup with token-based radii and container-aware behavior.
- [ ] **Step 4: Re-run the pane and preference tests; expect PASS.**

### Task 5: Bilingual copy, living docs, and delivery verification

**Files:**
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1: Add concise bilingual UI copy and update the owning GUI contracts.** Document the settings views, popup, shared-Chromium data destination, supported import types, and unchanged Relay/Agent ownership. Add one unreleased changelog entry with its complete `- EN:` child.
- [ ] **Step 2: Run focused tests, `bun run --cwd=packages/client-core check`, `bun run --cwd=packages/desktop-app check`, changelog/i18n checks, and named translation-pair checks; expect PASS or record precise pre-existing/environment failures.**
- [ ] **Step 3: Build and exercise real Electron.** Verify popup open/outside/Escape dismissal, settings tabs, toolbar visibility, full-URL display, import/Relay outcomes with controlled RPC fixtures, and unchanged tab/Agent behavior. Inspect narrow and standard widths; do not claim real password import or real-Chrome integration without a live probe.
- [ ] **Step 4: Review `git status`, remove only task-created scratch artifacts, and report changed files, behavior, commands/results, and unverified native behavior.**
