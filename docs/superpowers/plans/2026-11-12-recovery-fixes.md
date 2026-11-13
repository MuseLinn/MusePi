# Recovery Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three reproduced recovery defects without changing unrelated UI or weakening existing recovery behavior.

**Architecture:** Validate journal continuity immediately before replay, serialize owner-file transitions with the existing OS-backed file lock, and reload host plugins only when their effective configuration actually changed. Keep write availability, explicit takeover, and HMR restart behavior for genuinely affected non-reloadable plugins.

**Tech Stack:** TypeScript, Bun test, Node filesystem APIs, existing `@musepi/pi-utils/file-lock` and `@musepi/pi-natives` primitives.

**Spec:** User-approved recovery order in the 2026-11-12 conversation and the reproduced API/process probes recorded there.

## Global Constraints

- No commits, branches, pushes, PRs, releases, or unrelated UI edits.
- Tests use isolated temporary directories and never production session or daemon state.
- Preserve later journal appends after an isolated write failure; detect the gap at the recovery boundary instead of changing the append contract.
- Preserve explicit live takeover; use the existing native lock only around owner-file transitions, not for the session lifetime.
- A genuine HMR config change may still require restart; unrelated plugin config changes must not select HMR.
- Update the owning HMR docs in both locales and `CHANGELOG.musepi.md` under `[Unreleased]`.

## Review Focus

- A replay whose first record follows the cursor but skips an intermediate seq must resync before sending any event (Task 1).
- A replay that ends before the assigned tail must resync even when no later record exists (Task 1).
- A heartbeat paused inside its owner-file rewrite must hold the same native lock that takeover uses (Task 2).
- Losing ownership must dispose outside the native critical section so teardown can reacquire the lock (Task 2).
- An unchanged config store must produce no reload or restart, while a real HMR config change retains the existing restart path (Task 3).

---

### Task 1: Journal Replay Continuity

**Files:**
- Modify: `packages/coding-agent/src/daemon/journal.ts`
- Modify: `packages/coding-agent/src/daemon/session-host.ts`
- Modify: `packages/coding-agent/src/daemon/server.ts`
- Test: `packages/coding-agent/test/daemon/journal.test.ts`
- Test: `packages/coding-agent/test/daemon/session-catchup-rpc.test.ts`

**Interfaces:**
- Consumes: existing `catchupPlan(afterSeq, checkpointSeq, tailSeq)` and `AppendJournal.recordsAfter(afterSeq)`.
- Produces: `catchupRecordsPlan(afterSeq, checkpointSeq, tailSeq, records)` returning the same verdict union as `catchupPlan`; both replay consumers call it before emitting events.

- [ ] **Step 1: Write the failing tests**

Add a pure case showing cursor 1, tail 3, records `[1,3]` requires resync; contiguous `[2,3]` passes and an empty replay ending below the tail also requires resync. Add a real `replayCatchup` case with a journal rewritten to `[1,3]`, asserting the resync verdict and zero sent frames.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/coding-agent/test/daemon/journal.test.ts packages/coding-agent/test/daemon/session-catchup-rpc.test.ts`
Expected: the new cases fail because replay currently returns `{ok:true}` and emits seq 3.

- [ ] **Step 3: Implement continuity validation**

Add `catchupRecordsPlan`: apply `catchupPlan`, then require every replayed seq to equal `afterSeq + index + 1` and the final expected seq to equal `tailSeq + 1`. Use it in `replayCatchup` and `changes.ops` before any event is exposed.

- [ ] **Step 4: Verify GREEN**

Run the Task 1 command again, then `rtk bun test packages/coding-agent/test/daemon/live-session-reads.test.ts`.
Expected: all pass, including normal replay and existing resync behavior.

### Task 2: Atomic Owner-File Transitions

**Files:**
- Modify: `packages/coding-agent/src/daemon/session-owner-lock.ts`
- Test: `packages/coding-agent/test/daemon/session-owner-lost.test.ts`
- Test: `packages/utils/test/file-lock.test.ts` (existing native-lock coverage only)

**Interfaces:**
- Consumes: `withFileLock(filePath, fn)` from `@musepi/pi-utils/file-lock` and `tryAcquireFileLock(filePath)` for the regression probe.
- Produces: acquisition, heartbeat, and release perform each owner-file read/compare/write sequence under the same native critical section; `onLost` runs after that section closes.

- [ ] **Step 1: Write the failing test**

Pause an old heartbeat at its temp-file rename with `spyOn(fs, "rename")`. While paused, assert `tryAcquireFileLock(ownerFile)` returns null, then release the rename and verify normal teardown. The current code fails because no native lock is held.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/coding-agent/test/daemon/session-owner-lost.test.ts packages/utils/test/file-lock.test.ts`
Expected: the new contention assertion fails; existing native-lock and onLost tests pass.

- [ ] **Step 3: Serialize owner transitions**

Wrap acquisition attempts, heartbeat read/check/write, and release read/check/unlink in `withFileLock`. Move loss detection bookkeeping and the `onLost` callback outside the critical section; do not await disposal while holding it.

- [ ] **Step 4: Verify GREEN and the original cross-process race**

Run the Task 2 command, then rerun the two-process stale-heartbeat probe.
Expected: all tests pass; the final owner is the new token and `oldHeartbeatOverwroteNewOwner` is false.

### Task 3: Selective Host-Plugin Config Reload

**Files:**
- Modify: `packages/coding-agent/src/extensibility/plugins/runtime/host-runtime.ts`
- Test: `packages/coding-agent/test/bundled-plugin-host-loading.test.ts`
- Docs: `docs/extensions-dev.md`, `docs/extensions-dev.zh-CN.md`, `docs/capability-seams.md`
- Changelog: `packages/coding-agent/CHANGELOG.musepi.md`

**Interfaces:**
- Consumes: `MountContext["readConfig"]`, `MountedPlugin.config`, and `Bun.deepEquals`.
- Produces: config-only batches select records whose newly coerced `values` differ from `mounted.config`; code/manifest selection and explicit full reload remain unchanged.

- [ ] **Step 1: Write the failing test**

After loading shipped host plugins, call `reloadHostPlugins([getPluginConfigPath()])` without changing effective config. Assert no restart request and no replaced plugin. Add a real HMR config change case proving its restart request is retained.

- [ ] **Step 2: Verify RED**

Run from `packages/coding-agent`: `rtk bun test test/bundled-plugin-host-loading.test.ts`
Expected: the unchanged-config case requests HMR restart and reloads `memory-sharpshooter`.

- [ ] **Step 3: Compare effective config per record**

Read config once for the batch, select the union of code-affected and config-changed records with stable entry-path deduplication, and preserve the existing non-reloadable handling only for selected records.

- [ ] **Step 4: Verify GREEN and update owning docs**

Run: `rtk bun test test/bundled-plugin-host-loading.test.ts test/host-plugin-apply-once.test.ts test/hmr-service.test.ts`
Expected: all pass. Update both extension docs, the capability-seam anchor, and one bilingual changelog entry describing the three user-visible recovery fixes.

### Final Verification

- Run all affected test files and package type checks.
- Run `rtk bun run check:ts` from the isolated worktree root.
- Run `rtk bun run check:docs`, `rtk bun run check:changelog-i18n`, and `rtk bun run verify-translation-pairing extensions-dev`.
- Inspect `git status`; retain only the planned source, test, doc, and changelog changes in the isolated worktree.
