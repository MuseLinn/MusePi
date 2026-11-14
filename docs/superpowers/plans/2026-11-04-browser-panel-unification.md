# Browser and Right-Panel Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the right panel the single managed-browser tab interface while fixing panel labels/tooltips and completing browser menu and device-toolbar behavior.

**Architecture:** `managed-browser-host` remains the runtime/persistence authority and pure projection helpers define its one-to-one mapping to panel tabs. React wires those operations without remounting webviews; the browser menu uses existing host/IPC seams where possible.

**Tech Stack:** TypeScript, React 19, Electron 43, Bun test, Biome, existing client-core controls.

**Spec:** `docs/superpowers/specs/2026-11-04-browser-panel-unification-design.md`

## Global Constraints

- No commits, pushes, or unrelated edits.
- Every production behavior starts with a failing focused test and a recorded RED run.
- Preserve stable webview mounting, host tab ids, Agent activity ids, and split-panel behavior.
- Do not create a second browser persistence owner or an unconditional projection render loop.
- Add zh-CN and en-US copy together; update paired GUI/extension docs and `[Unreleased]`.
- Use `bun check`/package scripts, never `tsc`; prefix shell commands with `rtk`.

## Review Focus

- Restored invalid `settings.browser` and stale browser panel targets must not create dead tabs (Task 1).
- Host-originated creation/closure and panel budget eviction must reconcile without loops or guest leaks (Tasks 1, 3).
- Blank pages must still allow global history/download/settings actions but not page/device actions (Task 4).
- Dynamic tooltip text must survive hover/click/leave and keyboard focus (Task 2).
- Favicon failure, Agent activity on background tabs, split columns, duplication, and close-neighbor selection must remain coherent (Tasks 3, 5).

---

### Task 1: Browser/panel state contracts

**Files:**
- Create: `apps/desktop/src/lib/browser-panel-tabs.ts`
- Modify: `apps/desktop/src/lib/panel-tabs.ts`
- Test: `apps/desktop/test/browser-panel-tabs.test.ts`, `apps/desktop/test/panel-tabs.test.ts`

**Interfaces:**
- Consumes: `ManagedTab`, `PanelTab`, `PanelTabState`, `PanelTabDescriptor`.
- Produces: `browserPanelDescriptor(tab: ManagedTab, fallbackLabel: string): PanelTabDescriptor`, `reconcileBrowserPanelTabs(state: PanelTabState, tabs: readonly ManagedTab[], fallbackLabel: string): PanelTabState`, `browserTarget(panelTab: PanelTab): string | null`.

- [ ] Write failing tests for descriptors using `surface: "browser"`, `target/dedupeKey: managedTab.id`, localized blank labels, favicon-independent title updates, and idempotent reconciliation.
- [ ] Add failing cases for host-created/deleted tabs, panel-deleted guests, stale restored browser targets, active-tab preservation, split columns, and the invalid `settings.browser` migration.
- [ ] Run the two test files and record the expected failures.
- [ ] Implement pure reconciliation with reference-stable no-op returns and filter browser tabs from panel restoration because host restoration recreates them.
- [ ] Re-run the focused tests and record PASS.

### Task 2: Dynamic tooltips and surface-tab visuals

**Files:**
- Modify: `apps/desktop/src/lib/tooltips.ts`, `apps/desktop/src/lib/panel-maximize.ts`
- Modify: `apps/desktop/src/components/surface-tabs.tsx`, `apps/desktop/src/styles/gui-chat.css`
- Test: `apps/desktop/test/tooltips.test.ts`, `apps/desktop/test/context-panel-maximize.test.tsx`, `apps/desktop/test/surface-tabs.test.tsx`

**Interfaces:**
- Produces: `SurfaceTab.icon?: ReactNode`, `SurfaceTab.agentActive?: boolean`; decorative visuals use `alt=""`/`aria-hidden`.

- [ ] Add a failing hover → external `title` update → leave test and maximize/restore title/aria coverage.
- [ ] Add failing tab-strip tests for built-in icons, favicon fallback, and Agent-active accessible labeling.
- [ ] Run and record RED, then prevent stale tooltip snapshots from overwriting newer titles and keep one maximize label owner.
- [ ] Render optional tab icons/Agent badges without changing tab keyboard or close behavior.
- [ ] Re-run tests and record PASS.

### Task 3: ContextPanel/ChatView browser projection

**Files:**
- Modify: `apps/desktop/src/components/ContextPanel.tsx`, `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/lib/surfaces/registry.ts`, `apps/desktop/src/lib/slot-host.tsx`, `apps/desktop/src/plugins/browser-ui/page.tsx`
- Test: `apps/desktop/test/context-panel-add-menu.test.tsx`, `apps/desktop/test/panel-tab-selector.test.ts`, `apps/desktop/test/extension-react-host.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–2 projection and tab visuals; existing `createTab/selectTab/closeTab`, `subscribeHost/getHostState`.
- Produces: browser add/open/activate/close/duplicate/reveal operations that always resolve a managed tab id.

- [ ] Write failing add-menu and integration tests proving browser content and localized labels, no `settings.browser`, and browser activation by managed id.
- [ ] Add failing cases for host-to-panel title/favicon/Agent updates, panel close/duplicate, background Agent reveal, split columns, and no-op render stability.
- [ ] Record RED, then subscribe to host state and wire projection plus all browser entry points and close guards.
- [ ] Give every built-in panel tab its registry icon; browser tabs use favicon/browser fallback and Agent activity from `busyTabIds`/`activity`.
- [ ] Re-run focused tests and record PASS.

### Task 4: Browser menu and blank-page action model

**Files:**
- Create: `apps/desktop/src/lib/browser-menu-model.ts`
- Modify: `apps/desktop/src/components/ManagedBrowserPane.tsx`, `apps/desktop/src/lib/managed-browser-host.ts`
- Modify: `apps/desktop/electron/managed-browser.cjs`, `apps/desktop/electron/preload.cjs`, `apps/desktop/src/env.d.ts`, `apps/desktop/src/app.tsx`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`, `packages/client-core/src/i18n/en-US/tools.ts`
- Test: `apps/desktop/test/browser-menu-model.test.ts`, focused managed-browser IPC/host tests

**Interfaces:**
- Produces: a pure menu availability model with `hasPage` derived from a nonblank active managed tab; page actions are find, print, zoom, device toolbar, focus, screenshot, copy/open/refresh; global actions are downloads, history, clear data, settings.

- [ ] Write failing availability tests for no tab, `about:blank`, HTTP, and unsupported URL schemes.
- [ ] Add failing host/IPC tests for clear-data routing and each newly introduced print/screenshot/download bridge.
- [ ] Record RED, then implement find-in-page, print, zoom reset, device-toolbar toggle, always-focus toggle, screenshot, downloads, history, clear-data, and browser-settings actions using existing controls and native Electron APIs.
- [ ] Remove the internal browser tab strip and its dead state/styles only after Task 3 supplies panel operations; keep new-tab creation routed through that projection.
- [ ] Re-run focused tests and record PASS; separately identify native dialogs requiring real Electron verification.

### Task 5: Device-toolbar interaction and disabled semantics

**Files:**
- Modify: `apps/desktop/src/components/browser-device-toolbar.tsx`, `apps/desktop/src/styles/gui-browser-toolbar.css`
- Modify: `packages/client-core/src/components/shell/Segmented.tsx`, shared control styles only if required
- Test: `apps/desktop/test/browser-device-toolbar.test.tsx`, existing segmented-control tests

**Interfaces:**
- Produces: `BrowserDeviceToolbar.disabled?: boolean` and `Segmented.disabled?: boolean`; disabled controls expose native disabled/ARIA state and cannot activate by pointer or keyboard.

- [ ] Add failing tests for blank-page presets, dimensions, scale, backgrounds, collapse/reveal, and keyboard interaction.
- [ ] Record RED, then implement disabled semantics and container-aware alignment/wrapping using shared tokens and visible focus states.
- [ ] Re-run focused tests and record PASS.

### Task 6: Documentation and delivery verification

**Files:**
- Modify: `docs/gui-design.md`, `docs/gui-design.zh-CN.md`, `docs/gui-implementation.md`, `docs/gui-implementation.zh-CN.md`
- Modify: `docs/extensions-dev.md`, `docs/extensions-dev.zh-CN.md` if the slot contract changes
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] Update the single-tab projection, menu/blank-page, device-toolbar, tooltip, and Agent-badge contracts in both locales and changelog.
- [ ] Run `bun check` and the focused desktop/client-core test suites; classify any unrelated failure with a baseline rerun.
- [ ] Build the desktop app and exercise the original Electron scenarios end-to-end, including real Agent activity and native print/screenshot/download behavior where available.
- [ ] Inspect `git status`, remove only generated files created by verification that are not deliverables, and report exact results and platform limitations.
