# Managed Browser Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real unpacked-extension management to the managed browser without exposing external Relay or shared-Chromium data in its toolbar.

**Architecture:** Main validates and persists extension directories and calls Electron's managed-session APIs. Renderer consumes typed IPC and restores the Extensions popup only for actual managed-session content.

**Tech Stack:** Electron 43, Node CJS, React 19, TypeScript, Bun tests, existing floating menu and i18n.

**Spec:** `docs/superpowers/specs/2026-11-08-managed-browser-extensions-design.md`

## Global Constraints

- Only absolute unpacked directories with valid `manifest.json`; explicit user selection and permission review are mandatory.
- Persist only id/name/version/path/permissions, load on every boot, and use actual session inventory for display.
- No Relay, shared-Chromium inventory, external-profile import, CRX support, or full-Chrome-API claims in the managed popup.
- Do not change webview/tab/Agent lifecycle or add dependencies; no Git commits.

## Review Focus

- Invalid or unreadable manifests must fail visibly without creating installed rows (Task 1).
- Duplicate installs must not create duplicate persistent records (Task 1).
- Startup load failures must not prevent browser startup or masquerade as loaded extensions (Task 1).
- Removal unloads but never deletes the source directory (Task 1).
- The popup must never show Relay/shared-Chromium content and must expose native loading errors (Task 2).

---

### Task 1: Managed-session extension records and IPC

**Files:**
- Create: `apps/desktop/electron/managed-browser-extensions.cjs`
- Create: `apps/desktop/test/managed-browser-extensions.test.cjs`
- Modify: `apps/desktop/electron/managed-browser.cjs`
- Modify: `apps/desktop/test/managed-browser-menu-ipc.test.cjs`

**Interfaces:**
- Produces: `readExtensionManifest(dir)`, `readExtensionRecords(file)`, `writeExtensionRecords(file, records)`, `loadPersistedExtensions(session, file)`, `listManagedExtensions(session, file)`.
- Produces IPC: `managed-browser:extensions-list`, `managed-browser:extensions-install`, `managed-browser:extensions-remove`.

- [ ] **Step 1: Write failing CJS tests.** Cover missing/malformed manifests, valid permissions, duplicate records, load failures, list/remove, and persistence using a temporary extension directory and mocked managed session.
- [ ] **Step 2: Run the tests; expect missing-module/IPC failure.**
- [ ] **Step 3: Implement manifest/record helpers and controller methods.** `start()` loads recorded directories best-effort; list/install/remove use the same partition, with native error text and no source-directory deletion.
- [ ] **Step 4: Re-run new and existing managed-browser IPC tests; expect PASS.**

### Task 2: Typed bridge and managed Extensions popup

**Files:**
- Modify: `apps/desktop/electron/preload.cjs`
- Modify: `apps/desktop/src/env.d.ts`
- Create: `apps/desktop/src/components/managed-browser-extensions.tsx`
- Create: `apps/desktop/test/managed-browser-extensions.test.tsx`
- Modify: `apps/desktop/src/components/ManagedBrowserPane.tsx`
- Modify: `apps/desktop/test/managed-browser-pane-menu.test.tsx`
- Modify: `apps/desktop/src/styles/gui-settings.css`

**Interfaces:**
- Consumes: Task 1 IPC and actual loaded-extension records.

- [ ] **Step 1: Write failing renderer tests for real empty/loaded/error states, permission-confirmed install, removal, and absence of Relay/shared-Chromium content.** Update the managed-pane test to require a real Extensions button and popup, without reintroducing external content.
- [ ] **Step 2: Run the tests; expect missing API/component failure.**
- [ ] **Step 3: Add typed IPC wrappers and the popup, then restore only the managed Extensions button.** Install requires a second explicit confirmation showing manifest permissions; remove uses the id and refreshes the actual list. Reuse `useFloatingMenu` and responsive styles.
- [ ] **Step 4: Re-run renderer and pane tests plus desktop type checks; expect PASS.**

### Task 3: Documentation and end-to-end verification

**Files:**
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1: Add bilingual extension-management copy and document the managed/external boundary, manifest/permission requirements, and restart persistence.** Add one Unreleased changelog entry with complete English translation.
- [ ] **Step 2: Run focused tests, both package checks, root `check:tools`, translation-pairing, changelog checks, and desktop build; record any unrelated concurrent failure separately.**
- [ ] **Step 3: In isolated Electron userData, install a tiny unpacked extension, verify the real loaded row, restart to verify persistence, and remove it without deleting source files.** Do not claim Chrome API compatibility or touch production browser data.
- [ ] **Step 4: Review `git status`, remove only task-created scratch, and report changed files, behavior, verification, and any remaining native/platform limitations.**
