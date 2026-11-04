# Android Emulator Cordis Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit unless the user explicitly requests it.

**Goal:** Add a disableable MusePi Cordis plugin for interactive Android emulator preview and agent-driven mobile debugging.

**Architecture:** A plugin-owned ADB service serves both daemon RPC and one agent tool. A right-panel TSX component polls serially captured PNG frames and sends validated input/debug commands to the same service.

**Tech Stack:** TypeScript, Bun, Cordis, daemon-compiled React TSX, ADB/Android Emulator, Bun tests.

**Spec:** `docs/superpowers/specs/2026-11-01-android-emulator-plugin-design.md`

## Global Constraints

- No new runtime dependency and no shell command strings; use `Bun.spawn` argument arrays.
- Use `bun check` conventions and package scripts; never `tsc`.
- Dispose all plugin-owned polling/processes; never terminate pre-existing devices.
- Update paired user-facing docs and `[Unreleased]`; preserve unrelated worktree edits.
- Isolate tests and desktop smoke with the repository helpers and `scripts/dev-smoke.ts`.

## Review Focus

- Slow/overlapping screenshots: one in-flight capture, newest-frame-only delivery, no timer pileup (Task 1).
- Device switching during RPC: responses carry identity and stale UI work is ignored (Tasks 2 and 3).
- Unsafe coordinates/text/APK paths: reject invalid values and paths outside cwd (Task 1).
- Disposal with subscribers or a plugin-started emulator: stop capture and terminate only owned processes (Task 1).
- Blank app first frame: skill and smoke wait and corroborate with UI tree/logcat (Tasks 4 and 5).

---

### Task 1: ADB process and device service

**Files:**
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/android-service.ts`
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/android-service.test.ts`

**Interfaces:**
- Produces: `parseAdbDevices(output: string): AndroidDevice[]`, `mapPoint(rect, natural, client): Point`.
- Produces: `AndroidDeviceService` with `devices()`, `avds()`, `start(avd)`, `subscribe()`, `unsubscribe()`, `frame(device)`, `tap(device,x,y)`, `swipe(device,from,to,durationMs)`, `key(device,key)`, `text(device,text)`, `install(device,cwd,apkPath)`, `launch(device,component)`, `uiTree(device)`, `logcat(device,options)`, `dispose()`.

- [ ] Write failing tests for offline/unauthorized/device parsing, PNG pass-through, coordinate bounds, path and input validation, single-flight frame capture, subscriber stop, and selective emulator disposal.
- [ ] Run `bun test packages/coding-agent/src/bundled-plugins/android-emulator/android-service.test.ts`; confirm missing-module/behavior failures.
- [ ] Implement the service with an injectable process runner, bounded buffers/timeouts, serial capture, one latest frame, and Cordis-safe idempotent disposal.
- [ ] Re-run the focused test and confirm all cases pass.

### Task 2: Cordis registration, RPC, and agent tool

**Files:**
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/index.ts`
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/tools.ts`
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/package.json`
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/registration.test.ts`

**Interfaces:**
- Consumes: `AndroidDeviceService` from Task 1 and existing `ExtensionAPI` registration methods.
- Produces: RPC namespace `android-emulator`, tool `android_emulator`, slot `panel.tab.android-emulator`.

- [ ] Write failing registration tests using the existing extension test harness: enabled plugin exposes component/RPC/tool; disable disposes them; screenshot returns image content; malformed actions are rejected.
- [ ] Run the registration test and confirm failure before implementation.
- [ ] Implement the manifest, shared service lifetime, RPC handlers, and discriminated agent tool with structured results.
- [ ] Re-run registration and service tests.

### Task 3: Interactive right panel

**Files:**
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/ui/emulator-panel.tsx`
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/ui/emulator-panel.css`

**Interfaces:**
- Consumes: panel props `rpc`, `extensionCall`, `sessionId`, `cwd`, `panelTab`; RPC from Task 2; `mapPoint` behavior from Task 1.
- Produces: operable `panel.tab.android-emulator` UI.

- [ ] Add a focused UI contract test only if an existing panel test harness supports real behavior; otherwise pin pure coordinate/stale-response logic in service tests and verify the actual panel in Task 5.
- [ ] Implement device/AVD selection, start/refresh, live screen, pointer gestures, navigation keys, text, screenshot download, APK/activity, UI-tree and logcat controls.
- [ ] Add bilingual strings, accessible labels, responsive layout, cancellation of obsolete requests, and subscriber cleanup.
- [ ] Run package formatting/type checks and resolve all new diagnostics.

### Task 4: Real skill and capability documentation

**Files:**
- Create: `packages/coding-agent/src/bundled-skills/android-emulator/SKILL.md`
- Modify: `packages/coding-agent/src/bundled-skills/index.ts`
- Modify: `packages/coding-agent/src/extensibility/extensions-center/builtin-registry.ts`
- Modify: `docs/capability-seams.md` and the authoritative seam registry
- Modify: paired extension, plugin lifecycle, GUI design/implementation docs
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] Register the actual bundled skill and extension-center entry; run its existing builtin-registry test.
- [ ] Declare all six seam fields and add the documentation anchor.
- [ ] Document setup, RPC/tool lifecycle, debugging workflow, limitations, and bilingual GUI behavior without duplicating unrelated edits.
- [ ] Add the unreleased changelog entry and run documentation/registry checks.

### Task 5: End-to-end verification

**Files:**
- Modify only files with regressions found by verification.

- [ ] Run all focused plugin/registry tests and `bun --cwd=packages/coding-agent check`.
- [ ] Run relevant desktop checks and the repository-required deliverable checks.
- [ ] Through `bun scripts/dev-smoke.ts -- <command>`, launch the actual client with isolated state against `emulator-5554` / `MusePi-Mobile-Test`.
- [ ] Exercise frame refresh, tap, swipe, Back/Home/Recents, text, screenshot, APK install/activity launch where a test APK is available, UI tree, and logcat; capture evidence of the actual panel.
- [ ] Inspect `git status --short`, remove only generated artifacts created by this verification, and report any platform limitation or pre-existing failure separately.
