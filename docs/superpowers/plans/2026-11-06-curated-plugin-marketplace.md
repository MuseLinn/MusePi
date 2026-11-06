# Curated Plugin Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship curated discovery, version-pinned Modern Web execution, cancellation, and full install/upgrade acceptance.

**Architecture:** Merge embedded curated metadata only in production-enabled managers, while keeping custom/test registries unchanged. Reuse existing install/update flows and the generated Cordis adapter.

**Tech Stack:** Bun, TypeScript, MarketplaceManager, ExtensionAPI, upstream npx CLI.

**Spec:** `docs/superpowers/specs/2026-11-06-curated-plugin-marketplace-design.md`

## Global Constraints

- Defaults never auto-install plugins or modify source directories.
- Runtime CLI version equals installed package version; never `@latest`.
- Test stores remain isolated and default-free unless explicitly enabled.
- Preserve unrelated worktree changes and do not commit.

## Review Focus

- Default catalog reads must not require network: Task 1 test.
- Caller abort and output overflow must both kill the child: Task 1 tests.
- Duplicate built-in add/remove behavior must remain explicit: Task 1 tests.
- Upgrade must preserve disabled state and regenerate the adapted version: Task 2 test.
- Real-model skill selection is not asserted without a real-model run: final report.

---

### Task 1: Curated metadata and pinned cancellable execution

**Files:**
- Create: `packages/coding-agent/src/extensibility/plugins/marketplace/default-marketplaces.ts`
- Modify: `packages/coding-agent/src/extensibility/plugins/marketplace/manager.ts`
- Modify: `packages/coding-agent/src/extensibility/plugins/compat/modern-web-guidance-adapter.ts`
- Modify: `packages/coding-agent/src/extensibility/plugins/**/production factories`
- Test: `packages/coding-agent/test/third-party-cordis.test.ts`
- Create: `packages/coding-agent/test/default-marketplaces.test.ts`

**Interfaces:**
- `includeDefaultMarketplaces?: boolean` on `MarketplaceManagerOptions`.
- Modern Web process command uses `modern-web-guidance@<package version>` and accepts `AbortSignal`.

- [ ] **Step 1: Write failing tests**
  Assert both curated plugins list without network, duplicates cannot be added, defaults cannot be removed, custom registries remain default-free, Modern Web uses its package version, and caller abort kills the child.

- [ ] **Step 2: Run tests to verify RED**
  Run both test files; expect missing default and `@latest`/abort failures.

- [ ] **Step 3: Implement defaults and execution contract**
  Merge embedded catalogs only for opted-in managers, enable at production factories, and pin/cancel the adapter process.

- [ ] **Step 4: Run tests to verify GREEN**
  Rerun both files and related manager tests; expect PASS.

### Task 2: Install/update acceptance

**Files:**
- Test: `packages/coding-agent/test/third-party-cordis.test.ts`

**Interfaces:**
- Existing `MarketplaceManager.installPlugin`, `checkForUpdates`, `setPluginEnabled`, and `upgradePlugin`.

- [ ] **Step 1: Write the full-chain failing test**
  Install a local Modern Web marketplace, assert Cordis entry and pinned version, simulate a newer catalog/package, disable the plugin, upgrade, and assert disabled state plus regenerated pinned version.

- [ ] **Step 2: Run test to verify RED**
  Run the focused test and confirm the new acceptance path fails where behavior is missing.

- [ ] **Step 3: Complete required behavior**
  Make the smallest changes needed to satisfy the acceptance contract without altering unrelated scope behavior.

- [ ] **Step 4: Run acceptance and real upstream smoke**
  Run focused tests and the actual Superpowers/Modern Web mount/search smoke; expect PASS.

### Task 3: Documentation and delivery

**Files:**
- Modify: `docs/extensions-dev.md` and `docs/extensions-dev.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1: Document final behavior**
  Record curated defaults, version pinning, abort semantics, non-auto-install, and explicit adaptation boundary.

- [ ] **Step 2: Run final checks**
  Run focused suites, `bun run --cwd=packages/coding-agent check`, docs/changelog checks, and actual upstream smoke. Report unrelated existing failures separately.

- [ ] **Step 3: Inspect final tree**
  Run `git status --short` and `git diff --check`; clean only task-created temporary output.
