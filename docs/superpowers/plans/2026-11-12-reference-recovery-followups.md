# Reference-Driven Recovery Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate short-read journal corruption, close host-plugin lifecycle gaps, and skip durable intent only for demonstrably read-only LSP actions.

**Architecture:** Read journal windows to completion or EOF before decoding. Serialize all host ensure/reload/reset work on one lifecycle queue, reject service conflicts at publication, await asynchronous teardown, retain restart requests until acknowledged, and fail rollback loss into restart-required. Reuse `LSP_READONLY_ACTIONS` for an argument-level durable-intent predicate.

**Tech Stack:** TypeScript, Bun test, Node `FileHandle.read`, existing Cordis host runtime, TLA+ counterexamples.

**Spec:** The user-approved follow-up scope in the 2026-11-12 conversation; `oh-my-pi` short-read slicing and dsh fiber disposal / `loader.exit()` semantics at `D:/Projects/Agents/references/{oh-my-pi,dsh}`.

## Global Constraints

- Continue in the isolated recovery worktree; preserve `956f2963b` and all main-checkout concurrent work.
- Commit each task independently after its focused tests pass. Do not merge, push, or create PRs.
- No new dependencies and no subagents without explicit authorization.
- Tests use isolated temporary agent/config/session directories.
- Preserve default durable intent for unknown, mutating, and mixed-action tools.
- Update owning docs, both locales, capability seams, TLA+ claims, and bilingual CHANGELOG for behavior changes.

## Review Focus

- Short reads and EOF mid-window must never expose uninitialized bytes or truncate a valid tail silently.
- Reset while disposal is pending must not allow a second mount or overlapping old/new effects.
- Duplicate service publication must preserve the original provider and clean the rejected mount.
- Replacement plus rollback failure must become visible restart-required, not a healthy old instance.
- Read-only LSP actions skip flush; rename, rename_file, apply, reload, raw request, and unknown actions retain it.

---

### Task 1: Exact Journal Reads

**Files:**
- Modify: `packages/coding-agent/src/daemon/journal.ts`
- Test: `packages/coding-agent/test/daemon/journal.test.ts`
- Plan: `docs/superpowers/plans/2026-11-12-reference-recovery-followups.md`

**Interfaces:**
- Consumes: `fs.promises.FileHandle.read(buffer, offset, length, position)`.
- Produces: a local read helper returning actual bytes read; every tail/window decode uses that count.

- [ ] **Step 1: Write the failing short-read test**

Add `reads complete records through short filesystem reads`: cap every real read at 7 bytes and poison unread buffer space. Assert both `readTailSeq` and `recordsAfter(0)` return all three valid records with no parse failure.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test test/daemon/journal.test.ts -t "short filesystem reads"`
Expected: failure from truncated/garbled reads rather than three records.

- [ ] **Step 3: Implement bounded exact reads**

Loop until the requested window is full or EOF, then decode only the actual byte count. Use it for `readTailSeq`, both `#tailWindow` reads, and `#lastCompleteLineEnd`.

- [ ] **Step 4: Verify GREEN and commit**

Run the full journal file, then commit source, test, and this plan with `fix(daemon): honor short journal reads`.

### Task 2: Host Lifecycle Ownership and Failure Visibility

**Files:**
- Modify: `host-runtime.ts`, `host-services.ts`, `cordis-primitives.ts`, `hmr/service.ts`, `extensibility/extensions/types.ts`
- Modify: `spec/HostPluginLifecycle.tla`, its configs, `spec/README.md`
- Test: `host-plugin-apply-once.test.ts`, `hmr-service.test.ts`, `cordis-primitives.test.ts`
- Docs/changelog as required.

**Interfaces:**
- One lifecycle queue serializes ensure, reload, and reset.
- `provideHostService` rejects a duplicate name without replacing the incumbent.
- `HmrService.restartRequirements` lists requests; `acknowledgeRestart(requirement)` removes one; `restartRequired` remains the oldest for compatibility.
- Rollback failure sets diagnostics and requests host restart.

- [ ] **Step 1: Add failing lifecycle tests**

Cover reset/ensure overlap with a gated cleanup, async service-stop waiting, duplicate publication with cleanup, rollback failure requiring restart, and restart queue acknowledgement/disposal.

- [ ] **Step 2: Verify RED**

Run the three focused test files; each new behavior must fail for the intended missing guarantee.

- [ ] **Step 3: Implement lifecycle ownership and failure reporting**

Serialize the three lifecycle entry points, clean rejected mounts, await service stop, retain/acknowledge restart requests, and report rollback failure instead of claiming a healthy old instance. Update the host TLA model to distinguish acknowledged failure from silent rollback loss.

- [ ] **Step 4: Verify GREEN, document, and commit**

Run focused lifecycle and host-loading suites, TLA and docs checks, then commit with `fix(plugins): serialize host lifecycle and restart failures`.

### Task 3: Argument-Level LSP Intent Exemption

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Modify: `packages/coding-agent/src/lsp/tool.ts`
- Test: `packages/coding-agent/test/session-exit-diagnostics.test.ts`
- Docs/changelog as required.

**Interfaces:**
- `AgentTool.requiresDurableIntent?: boolean | ((args: unknown) => boolean)`, default true.
- `LspTool` returns false only for `LSP_READONLY_ACTIONS`, with lowercase normalization and fail-closed unknown actions.

- [ ] **Step 1: Add failing read-only and mutating LSP dispatch tests**

Drive real `LspTool` through AgentSession and the extension wrapper: hover/status skips flush; rename_file and unknown actions flush before execute.

- [ ] **Step 2: Verify RED**

Run the durable-intent tests; read-only LSP currently pays the barrier.

- [ ] **Step 3: Implement and verify the predicate**

Evaluate the declaration against final transformed args, then run durable-intent and agent-loop suites. Update extension/session docs and CHANGELOG, and commit with `perf(agent): skip durable barriers for read-only LSP`.

### Final Verification

- `rtk bun run check:ts` and `rtk bun run test:tla`.
- Focused journal, lifecycle, durable-intent, and native file-lock tests.
- `MUSEPI_TEST_CONCURRENCY=4 rtk bun --cwd=packages/coding-agent run test`.
- Review all commits and `git status`; remove only test-created residue. No integration, merge, or push.
