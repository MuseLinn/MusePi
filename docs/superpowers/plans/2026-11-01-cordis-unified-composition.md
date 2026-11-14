# Unified Cordis Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make packages/bundles, preset scopes, plugin-owned skills, and the capability-center page use one native Cordis lifecycle.

**Architecture:** Extend the existing package inventory with profile bundle state, load preset rows in session-local service scopes, register skills from their owning plugin, and expose the existing capability page through a desktop Cordis slot. Keep legacy loading and the detailed `bundles.*` APIs without maintaining a second Composition page.

**Tech Stack:** TypeScript, Bun, React 19, MusePi Cordis runtime, desktop JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-11-01-cordis-unified-composition-design.md`

## Global Constraints

- This is not a DSH application-compatibility rewrite; preserve MusePi native services and existing manifest readers.
- Use `bun check`/package scripts, never `tsc`; tests and smoke runs stay isolated from production state.
- Every behavior change starts with a failing contract test. No commits, pushes, PRs, or unrelated formatting fixes.
- Update owning bilingual docs and `packages/coding-agent/CHANGELOG.musepi.md` under `[Unreleased]`.

## Review Focus

- A selected bundle whose files disappear must remain visible as broken, not silently vanish (Task 1 missing-bundle test).
- Two isolated rows providing the same service name must not see each other's object, while rows in the default scope retain mount-order visibility (Task 2 scope test).
- Switching a preset must remove the old preset's tools and run its effects, not only change prompt text (Task 2 hot-switch/disposal test).
- Disabling Android must remove both its tool/UI and its skill; standalone file skills remain independent (Task 3 lifecycle test).
- Disabling the capability-center plugin must leave no static fallback page or duplicate application root (Task 4 slot test).

---

### Task 1: Unified package/bundle management

**Files:**
- Create: `packages/coding-agent/src/extensibility/plugins/profile/plugin-management.ts`
- Create: `packages/coding-agent/src/extensibility/plugins/profile/plugin-management.test.ts`
- Modify: `packages/coding-agent/src/daemon/services/extension-service.ts`
- Create: `apps/desktop/src/lib/plugin-management.ts`
- Modify: `apps/desktop/src/components/UnifiedPluginsView.tsx`
- Modify: `apps/desktop/src/components/CapabilityCenterPage.tsx`
- Modify: `apps/desktop/src/components/ExtensionsCenter.tsx`
- Modify: `apps/desktop/src/app.tsx`
- Delete: `apps/desktop/src/components/BundleView.tsx`
- Modify: `apps/desktop/test/bundle-view.test.tsx`

**Interfaces:**
- Produces: `listPluginManagementPackages(cwd, home): Promise<PluginManagementPackage[]>`; each row has `management: "package" | "bundle"`, `enabled`, and optional `readable`.
- Produces: `setPluginManagementEnabled(rpc, row, enabled): Promise<{ ok: boolean; error?: string }>` selecting `plugins.setEnabled` or `bundles.setEnabled`.

- [ ] **Step 1: Write failing inventory and toggle-routing tests**
  Cover ordinary packages, selected/unselected bundles, a selected missing bundle, and the two RPC methods. The missing bundle must have `management: "bundle"`, `enabled: true`, `readable: false`.
- [ ] **Step 2: Run the tests and verify RED**
  Run `bun test packages/coding-agent/src/extensibility/plugins/profile/plugin-management.test.ts apps/desktop/test/bundle-view.test.tsx`; expect the new management helper to be absent.
- [ ] **Step 3: Implement the shared inventory and UI toggle helper**
  Merge `getAllPlugins()` with `readProfileComposition()`/`listInstalledBundles()`, then route `plugins.packages` through it. Keep the detailed composition RPC unchanged. Update both plugin-list parents to use the shared toggle helper.
- [ ] **Step 4: Remove the Composition tab**
  Remove `BundleView`, its tab state/type, and its tests; preserve Skills, Plugins, and Marketplace. Bundle diagnostics remain available through detail data and `bundles.composition`.
- [ ] **Step 5: Verify GREEN**
  Run the focused inventory and desktop plugin-list tests plus desktop type checking.

### Task 2: Cordis preset contexts and isolation

**Files:**
- Create: `packages/coding-agent/src/extensibility/plugins/preset-runtime.ts`
- Create: `packages/coding-agent/src/extensibility/plugins/preset-runtime.test.ts`
- Modify: `packages/coding-agent/src/extensibility/plugins/runtime/mount.ts`
- Modify: `packages/coding-agent/src/presets/resolve.ts`
- Modify: `packages/coding-agent/src/extensibility/plugins/profile/profile-presets.ts`
- Modify: `packages/coding-agent/src/extensibility/plugins/preset-registry.ts`
- Modify: `packages/coding-agent/src/sdk.ts`
- Modify: `packages/coding-agent/test/preset-registry.test.ts`

**Interfaces:**
- Produces: `CordisPresetRuntime` owning a session root `Context`; `mount(rows)` returns real fibers and their registration records, and `dispose()` unloads every preset fiber.
- `PresetPluginRow` additionally supports `isolate?: Record<string, boolean>` and `inject?: readonly string[]`; grouped children remain rows.
- `Extension` is only the registration record consumed by the existing tool/UI bridge. It is not the plugin identity or disposal owner.

- [ ] **Step 1: Write failing Context/fiber and preset-plan tests**
  Use real Cordis `Context` objects. Assert same-realm provider visibility, isolation between duplicate service names, missing-provider errors, group inheritance, disabled rows, per-row config, and fiber disposal. Add a session regression proving preset rows contribute tools rather than only UI metadata.
- [ ] **Step 2: Run the tests and verify RED**
  Run the new runtime tests and `bun test packages/coding-agent/test/preset-registry.test.ts`; expect missing real Cordis mount and isolation behavior.
- [ ] **Step 3: Implement the Cordis preset runtime**
  Mount every row with `scope.plugin()`. Reuse `mountPlugin` only for import/config/registration adaptation, then publish returned services on the actual Context. Apply each declared `isolate` through `scope.isolate(name)` and collect fibers for disposal.
- [ ] **Step 4: Implement and integrate preset mounting**
  Project `isolate`/`inject`, attach preset fibers to session creation, and expose their registration records to the existing tool bridge. On mode switches, remove old preset tools/prompts and dispose old fibers before mounting the new preset.
- [ ] **Step 5: Verify GREEN**
  Run runtime, preset, mode, and affected SDK tests, then coding-agent `check`.

### Task 3: Plugin-owned skill lifecycle

**Files:**
- Modify: `packages/coding-agent/src/bundled-plugins/android-emulator/index.ts`
- Create: `packages/coding-agent/src/bundled-plugins/android-emulator/skills/android-emulator/SKILL.md`
- Modify: `packages/coding-agent/src/bundled-plugins/android-emulator/registration.test.ts`
- Modify: `packages/coding-agent/src/bundled-skills/index.ts`
- Delete: `packages/coding-agent/src/bundled-skills/android-emulator/`

**Interfaces:**
- Consumes: existing `registerSkill` and active-extension filtering; no second skill installer.

- [ ] **Step 1: Write the failing ownership test**
  Assert applying Android registers `android-emulator` in `extension.skills` and disposal removes the declaration through the existing extension lifecycle.
- [ ] **Step 2: Verify RED, then implement**
  Move the skill resource under the plugin, import its Markdown as text, register it during `apply`, and remove the independent bundled-skill registry entry.
- [ ] **Step 3: Verify GREEN**
  Run Android registration, bundled-skill registry, and extension-skill collection tests.

### Task 4: Cordis-owned capability-center page

**Files:**
- Modify: `packages/collab-proto/src/extension-slots.ts`
- Modify: `apps/desktop/src/lib/slot-host.tsx`
- Create: `apps/desktop/src/plugins/capability-center/package.json`
- Create: `apps/desktop/src/plugins/capability-center/index.ts`
- Create: `apps/desktop/src/plugins/capability-center/page.tsx`
- Modify: `apps/desktop/src/components/CapabilityCenterPage.tsx`
- Modify: `apps/desktop/src/app.tsx`
- Modify: `packages/coding-agent/src/extensibility/extensions-center/builtin-registry.ts`
- Create: `apps/desktop/test/capability-center-plugin.test.tsx`

**Interfaces:**
- Produces: `app.capability` single slot and `CAPABILITY_CENTER_SLOT` host constant.
- The desktop plugin registers its page with `slot: "app.capability"`; props carry `tab`, `onTabChange`, and `onBack` through `SlotComponentProps` or a typed page-specific extension of it.

- [ ] **Step 1: Write failing slot and page-mount tests**
  Assert one registered capability page, no Composition tab, and no static `CapabilityCenterPage` import in `app.tsx` through a host wiring test rather than source-text matching.
- [ ] **Step 2: Verify RED, then implement the slot and desktop plugin**
  Move the page implementation beside the plugin entry, register it as a built-in plugin module, and mount the single slot from the application shell. Keep tab/navigation state in the shell.
- [ ] **Step 3: Verify GREEN**
  Run capability/plugin lifecycle tests and desktop type checking; verify disabling the plugin removes the page rather than revealing a static duplicate.

### Task 5: Documentation and end-to-end verification

**Files:**
- Modify: `docs/extensions-dev.md`, `docs/extensions-dev.zh-CN.md`
- Modify: `docs/plugin-lifecycle.md`, `docs/plugin-lifecycle.zh-CN.md`
- Modify: `docs/gui-design.md`, `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md`, `docs/gui-implementation.zh-CN.md`
- Modify: `docs/capability-seams.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1: Update current-state contracts**
  Document the single package/bundle management granularity, preset scopes, plugin-owned skills, and `app.capability`; remove references to a separate Composition tab.
- [ ] **Step 2: Run focused and package checks**
  Run all new/affected tests, coding-agent `check`, desktop `check:types`, scoped Biome, docs/changelog checks, and translation pairing only for edited pairs.
- [ ] **Step 3: Run isolated desktop smoke**
  Use `bun scripts/dev-smoke.ts -- bun --cwd=apps/desktop run desktop:run --remote-debugging-port=9223`; verify the Cordis capability page, unified Plugins view, no Composition tab, and Android skill/UI lifecycle. Restore GUI preferences and stop the smoke.
- [ ] **Step 4: Report verification boundaries**
  Record any pre-existing failures separately. If no model credentials are available, do not claim real-model preset selection or Agent-driven UI verification.
