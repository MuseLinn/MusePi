# Cordis Plugin Management and Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix desktop updater platform/checksum failures and make built-in component, profile/bundle, and Agent preset management report and mutate the correct state.

**Architecture:** Keep the existing Electron updater, `BundleService`, DSH patch composer, and ordinary plugin lock paths. Add platform-aware manifest selection and final-artifact feed hashing, then expose profile-owned bundle selection without changing ordinary plugin or Agent preset ownership.

**Tech Stack:** Bun, TypeScript, React, Electron, `node:crypto`, `bun:test`, electron-builder release YAML.

**Spec:** `docs/superpowers/specs/2026-10-29-cordis-plugin-management-design.md`

## Global Constraints

- Preserve all unrelated worktree changes, especially the in-progress stable/beta updater and speech work. Do not commit or push.
- Use RED → GREEN for each behavior change. Tests use temporary homes and never touch the production profile, session store, or daemon directory.
- Keep Computer Use opt-in. Do not turn Agent presets into profile selectors or rewrite the DSH Loader/HMR stack.
- Reuse existing RPC events and cache invalidation. No new dependencies and no `tsc`; package checks use their own scripts and `bun check` conventions.
- Update both locales of user-facing copy and paired living docs, plus `CHANGELOG.musepi.md` under `[Unreleased]`.

## Review Focus

- A legacy manifest with only a macOS `url` must never send Windows to that dmg; pin in Task 1.
- A wrapped exe whose bytes differ from the builder feed must publish its actual hash and size; a missing exe must fail release; pin in Task 2.
- Enabling a non-bundle package through the new bundle RPC must fail without writing; pin in Task 4.
- Disabling the last selected bundle must preserve an explicit empty list and unrelated manifest fields; pin in Task 3.
- A selected bundle deleted from disk must remain visible as missing and be deselectable; pin in Task 4.
- Parent plugin disablement must not erase the component denylist choice or display the component as running; pin in Task 5.

---

### Task 1: Platform-Aware Manual Download URLs

**Files:**
- Modify: `packages/desktop-app/electron/update-logic.cjs`
- Modify: `packages/desktop-app/electron/updater.cjs`
- Modify: `.github/workflows/gui-release.yml`
- Test: `packages/desktop-app/test/update-logic.test.ts`

**Interfaces:**
- Produces: `releaseDownloadUrl(manifest, platform, arch, releasesPage): string`, reading `manifest.downloads["<platform>-<arch>"]`; legacy `manifest.url` is valid only for `darwin/arm64`, otherwise use `releasesPage`.
- Produces manifest field `downloads: Record<string,string>` for `darwin-arm64`, `win32-x64`, `win32-arm64`, `linux-x64`, and `linux-arm64`.

- [ ] **Step 1: Write failing platform-selection tests**

Add cases proving win32/x64 selects `MusePi-0.6.4-setup.exe`, win32/arm64 selects `MusePi-0.6.4-arm64-setup.exe`, and a legacy manifest containing only an arm64 dmg returns that URL on darwin/arm64 but the releases page on win32/x64.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/desktop-app/test/update-logic.test.ts`
Expected: FAIL because `releaseDownloadUrl` is not exported.

- [ ] **Step 3: Implement selection and manifest parsing**

Add the pure helper in `update-logic.cjs`. In `updater.cjs`, validate `downloads` as a string map and return the helper’s result from `checkForUpdates`; keep `notes` and legacy `url` compatibility. Change the release workflow to emit `downloads` while retaining the legacy macOS `url`.

- [ ] **Step 4: Verify**

Run: `bun test packages/desktop-app/test/update-logic.test.ts`
Expected: PASS.

### Task 2: Hash Final Windows Installers During Release Merge

**Files:**
- Modify: `scripts/gui-release-channel.ts`
- Test: `scripts/gui-release-channel.test.ts`

**Interfaces:**
- Consumes: existing `mergeWindowsFeeds(distDir, channel)`.
- Produces: `syncWindowsFeedAssets(feed, distDir): Promise<UpdateFeed>`; every `files[]` entry gets SHA-512/base64 and byte size from its final exe, and top-level `path/sha512` is synchronized from the x64 asset.

- [ ] **Step 1: Write failing final-artifact tests**

Create stale x64/arm64 feeds and real temporary exe files. Assert merge replaces old hashes/sizes with `createHash("sha512").update(actualBytes).digest("base64")` and the actual lengths. Add a missing-asset case that rejects rather than uploading stale metadata.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test scripts/gui-release-channel.test.ts`
Expected: FAIL because stale feed values survive and missing assets are not checked.

- [ ] **Step 3: Implement final-artifact synchronization**

Use `node:crypto` and `node:fs/promises`; read the binary with `fs.readFile`. Synchronize both per-arch feeds before merging, and fail on any absent file.

- [ ] **Step 4: Verify**

Run: `bun test scripts/gui-release-channel.test.ts scripts/ci-release-publish.test.ts scripts/release.test.ts`
Expected: PASS without regressing the existing channel work.

### Task 3: Pure Profile Reads and Atomic Bundle-List Writes

**Files:**
- Modify: `packages/coding-agent/src/extensibility/plugins/profile/profile-composition.ts`
- Modify: `packages/coding-agent/src/daemon/services/bundle-service.ts`
- Test: `packages/coding-agent/src/extensibility/plugins/profile/profile-composition.test.ts`
- Test: `packages/coding-agent/src/daemon/services/bundle-service.test.ts`

**Interfaces:**
- Produces: `writeProfileBundles(name, bundles, home): Promise<ProfileComposition>`, preserving unrelated manifest fields and updating the already-used namespace (`dsh` preferred, `musepi` alias otherwise).
- Produces: `listInstalledBundles(profileDir, home): Promise<BundlePackageView[]>`, where a view is `{ name, version, path: string|null, selected, readable, description? }`.
- `BundleCompositionView.availableBundles: readonly BundlePackageView[]` is added to every composition response.

- [ ] **Step 1: Write failing read/write tests**

Prove `composition()` creates no files for a missing profile. Prove writes preserve `dependencies` and custom fields, support an empty list, prefer an existing `musepi` alias only when `dsh` is absent, and leave no temporary file. Prove selected-but-deleted bundles remain in the catalog with `path:null` and `readable:false`.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/coding-agent/src/extensibility/plugins/profile/profile-composition.test.ts packages/coding-agent/src/daemon/services/bundle-service.test.ts`
Expected: FAIL because files are created on read and the new write/catalog APIs do not exist.

- [ ] **Step 3: Implement profile helpers and remove read side effects**

Delete the example-writing call from `BundleService`; leave existing user files untouched. Implement an exclusive temp-file write plus rename, and scan only top-level package and scoped-package manifests in the two existing plugin anchors. Include missing selected bundles in the catalog.

- [ ] **Step 4: Verify**

Run the same two test files.
Expected: PASS.

### Task 4: Bundle Enablement Through the Profile

**Files:**
- Modify: `packages/coding-agent/src/daemon/services/bundle-service.ts`
- Modify: `packages/coding-agent/src/daemon/server.ts`
- Modify: `packages/desktop-app/src/components/BundleView.tsx`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Test: `packages/coding-agent/src/daemon/services/bundle-service.test.ts`
- Test: `packages/desktop-app/test/bundle-view.test.tsx`

**Interfaces:**
- Consumes: Task 3 catalog and `writeProfileBundles`.
- Produces: RPC `bundles.setEnabled { name, enabled } → { ok, enabled?, bundles?, error? }`; enabling requires an installed readable `dsh.bundle.patch`, disabling also works for a missing selected bundle.
- `BundleView` calls this RPC for catalog rows and `bundles.rows.setEnabled` only for composed plugin rows.

- [ ] **Step 1: Write failing service and UI tests**

Service: enabling appends once, disabling removes all occurrences, a non-bundle enable writes nothing, and refresh/recompose runs after a real write. UI: a zero-row composition with an installed bundle renders its selector; clicking sends `bundles.setEnabled`; a missing selected bundle remains visible and can be disabled.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/coding-agent/src/daemon/services/bundle-service.test.ts packages/desktop-app/test/bundle-view.test.tsx`
Expected: FAIL because the RPC and bundle selectors do not exist.

- [ ] **Step 3: Implement serialized selection writes and UI**

Serialize service mutations to prevent lost read-modify-write updates. Invalidate/recompute/refresh after selection changes, register the server route, and render bundle state before layer/row details. Add bilingual copy for installed, selected, missing, and unavailable bundle states.

- [ ] **Step 4: Verify**

Run the same two test commands plus `bun test packages/coding-agent/test/daemon/route-coverage.test.ts` if that route test exists; otherwise run the repository’s route-coverage owner discovered during implementation.
Expected: PASS.

### Task 5: Component Effective State and Preset Boundary

**Files:**
- Modify: `packages/desktop-app/src/components/PluginDetailDialog.tsx`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/settings.ts`
- Modify: `packages/client-core/src/i18n/en-US/settings.ts`
- Test: `packages/desktop-app/test/plugin-detail-dialog.test.tsx`

**Interfaces:**
- Keeps `PluginComponentDesc.enabled` as the component’s own blacklist configuration.
- UI effective state is `item.state === "active" && !item.loadError && component.enabled`; parent-disabled components retain configuration but render off with disabled controls.

- [ ] **Step 1: Write failing component-state tests**

Render an inactive `computer:computer` parent with `components:[{ id:"computer", enabled:true, canToggle:true }]`; assert the switch is off/disabled and the text says the selection is retained while the parent is off. Render the active parent and assert the independent switch remains usable.

- [ ] **Step 2: Run the tests and confirm the intended failure**

Run: `bun test packages/desktop-app/test/plugin-detail-dialog.test.tsx`
Expected: FAIL because the current child is green and enabled while its parent is disabled.

- [ ] **Step 3: Implement effective-state rendering and copy**

Compute state per row without mutating component data or the denylist. Explain the two gates in bilingual component copy, and update the preset description to say Agent presets are session-scoped compositions, distinct from application profile/bundle assembly.

- [ ] **Step 4: Verify**

Run: `bun test packages/desktop-app/test/plugin-detail-dialog.test.tsx packages/desktop-app/test/bundle-view.test.tsx`
Expected: PASS.

### Task 6: Documentation and End-to-End Verification

**Files:**
- Modify: `docs/extensions-dev.md`
- Modify: `docs/extensions-dev.zh-CN.md`
- Modify: `docs/gui-design.md`
- Modify: `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md`
- Modify: `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1: Update owning docs**

Document the three ownership models, component configuration versus effective state, platform download map, and final-artifact feed hashing. Replace the stale statement that MusePi has no DSH patch layer. Add concise Unreleased fixes with complete English children.

- [ ] **Step 2: Run focused package and release checks**

Run: `bun --cwd=packages/desktop-app run check`
Run: `bun --cwd=packages/coding-agent run check` (or the package’s documented check script if named differently)
Run: `bun test packages/desktop-app/test/update-logic.test.ts packages/desktop-app/test/bundle-view.test.tsx packages/desktop-app/test/plugin-detail-dialog.test.tsx packages/coding-agent/src/extensibility/plugins/profile/profile-composition.test.ts packages/coding-agent/src/daemon/services/bundle-service.test.ts scripts/gui-release-channel.test.ts`
Expected: all PASS; classify any pre-existing failure with a baseline rerun instead of hiding it.

- [ ] **Step 3: Run documentation/changelog checks and inspect the final tree**

Run: `bun run verify-translation-pairing extensions-dev gui-design gui-implementation`
Run: `bun run check:changelog-i18n`
Run: `bun scripts/check-changelog-voice.ts`
Run: `git status --short` and `git diff --check`
Expected: no formatting errors, no test artifacts, and no production profile modifications.
