# Third-party Cordis Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount Superpowers and Modern Web Guidance as upgradeable Cordis plugins with real lifecycle and capabilities.

**Architecture:** Adapt cached package manifests during MarketplaceManager installation, preserving the upstream Superpowers Pi entry and generating a Modern Web Guidance adapter. Reuse existing version checks, runtime links, and Cordis mount/dispose.

**Tech Stack:** Bun, TypeScript, ExtensionAPI, MarketplaceManager, mountPlugin, upstream `npx modern-web-guidance` CLI.

**Spec:** `docs/superpowers/specs/2026-11-06-third-party-cordis-plugins-design.md`

## Global Constraints

- Never modify upstream managed/source directories; only installer-owned cache is adapted.
- Preserve Superpowers `pi` behavior and enabled state across upgrades.
- Tests and smoke runs never write the production plugin store.
- Use `bun check` through package scripts and preserve unrelated worktree changes.

## Review Focus

- Repeated adaptation must not duplicate fields/files: Task 1 idempotence test.
- Missing skill/CLI or a nonzero process exit must produce explicit errors: Task 2 tests.
- Windows must invoke `npx.cmd`; other platforms invoke `npx`: Task 2 process test.
- Disabling an adapted plugin must remove its skill/tool through Cordis: Task 2 lifecycle test.
- Superpowers bootstrap must reappear after compaction: Task 1 mount test.

---

### Task 1: Cache manifest adaptation and Superpowers mount proof

**Files:**
- Create: `packages/coding-agent/src/extensibility/plugins/compat/third-party-cordis.ts`
- Create: `packages/coding-agent/test/third-party-cordis.test.ts`
- Modify: `packages/coding-agent/src/extensibility/plugins/marketplace/manager.ts`

**Interfaces:**
- `adaptThirdPartyCordisPlugin(cachePath: string): Promise<void>` runs after `cachePlugin` and before runtime registration.

- [ ] **Step 1: Write failing adaptation/mount tests**
  Build temporary Superpowers and Modern Web Guidance roots. Assert the adapter writes `musepi` declarations only in cache, is idempotent, and leaves source unchanged. Mount Superpowers through real `mountPlugin` and assert bootstrap is returned on initial context and after compaction.

- [ ] **Step 2: Run tests to verify RED**
  Run `bun test packages/coding-agent/test/third-party-cordis.test.ts`; expect missing adapter failures.

- [ ] **Step 3: Implement cache adaptation**
  Write only cache-local manifest fields and generated Modern Web adapter entry; call the adapter from MarketplaceManager.

- [ ] **Step 4: Run tests to verify GREEN**
  Rerun the focused test and existing MarketplaceManager tests; expect PASS.

### Task 2: Modern Web skill/tool and Cordis lifecycle

**Files:**
- Create: `packages/coding-agent/src/extensibility/plugins/compat/modern-web-guidance-adapter.ts`
- Test: `packages/coding-agent/test/third-party-cordis.test.ts`

**Interfaces:**
- `modern_web_guidance { operation: "search" | "retrieve" | "list", query?: string, skillVersion?: string }`.
- Adapter reads `skills/modern-web-guidance/SKILL.md` and registers it with `ExtensionAPI.registerSkill`.

- [ ] **Step 1: Write failing capability tests**
  Mount the adapted Modern Web plugin. Assert its skill is listed, tool output is returned, operation validation rejects bad input, nonzero exits fail, output is bounded, and Windows uses `npx.cmd`. Disable/dispose and assert resources are removed.

- [ ] **Step 2: Run tests to verify RED**
  Run the focused test; expect missing tool/skill failures.

- [ ] **Step 3: Implement adapter and process runner**
  Register the skill/tool, use packaged CLI when available and upstream npx otherwise, enforce a 60s deadline and bounded output without a shell.

- [ ] **Step 4: Run tests to verify GREEN**
  Rerun the focused test and related extension runner tests; expect PASS.

### Task 3: Documentation and delivery verification

**Files:**
- Modify: `docs/extensions-dev.md` and `docs/extensions-dev.zh-CN.md`
- Modify: `docs/capability-seams.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1: Document the adapter and lifecycle**
  Record the two cache-adapted packages, installation/update behavior, tool operations, platform CLI selection, and lack of source-directory mutation.

- [ ] **Step 2: Run final checks**
  Run focused tests, related marketplace/extension tests, `bun run --cwd=packages/coding-agent check`, docs/changelog checks, and a real `npx modern-web-guidance` search with a short query.

- [ ] **Step 3: Inspect the final tree**
  Run `git status --short` and `git diff --check`, remove only task-created temporary output, and report unrelated existing failures separately.
