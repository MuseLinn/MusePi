# Shell Minimizer UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native shell minimization measurable, configurable, and inspectable from the desktop UI.

**Architecture:** Extend the current native Bash result into persisted tool details, aggregate numeric savings in a JSONL journal, and expose narrow read-only RPCs. Reuse schema settings, `ToolRenderHost`, and `DialogFrame` for the UI; do not change shell execution.

**Tech Stack:** Bun, TypeScript, Rust-backed `pi-shell` result data, React, existing daemon JSON-RPC, existing desktop/client-core components.

**Spec:** `docs/superpowers/specs/2026-11-06-shell-minimizer-ux-design.md`

## Global Constraints

- Bytes only; never present savings as tokens.
- No command text, cwd, artifact path, or output in the savings journal.
- Preserve unrelated worktree changes; never commit or discard work.
- Use `bun check` through package scripts, never `tsc`.
- Update paired GUI docs and `packages/coding-agent/CHANGELOG.musepi.md` with inline English.
- PTY and client-terminal behavior remain unchanged.

## Review Focus

- Numeric artifact ids reused by different sessions must resolve only in the requested session: Task 2 RPC test.
- Malformed journal rows and non-positive savings must not inflate totals: Task 1 journal tests.
- Missing host capability or artifact id must not produce a dead button: Task 4 renderer test.
- Responses arriving after a preview/settings unmount must not update state: Task 3/4 component tests.
- Output above 8 MiB must be explicitly truncated without exposing its path: Task 2 preview test.

---

### Task 1: Savings journal and Bash metadata

**Files:**
- Create: `packages/coding-agent/src/session/shell-minimizer-stats.ts`
- Create: `packages/coding-agent/test/shell-minimizer-stats.test.ts`
- Modify: `packages/coding-agent/src/exec/bash-executor.ts`
- Modify: `packages/coding-agent/src/tools/bash.ts`
- Test: `packages/coding-agent/test/bash-executor.test.ts`

**Interfaces:**
- Produces: `BashMinimization { filter: string; inputBytes: number; outputBytes: number; artifactId?: string }`.
- Produces: `recordShellMinimization(info, journalPath?)`, `readShellMinimizerStats(journalPath?)` returning totals and `byFilter` rows.

- [ ] **Step 1: Write failing journal tests**
  Append git `1000→250` and cargo `2000→1000` records, one malformed row, and one non-positive row. Assert 2 commands, 3000 input, 1250 output, 1750 saved, `58.333…%`, sorted per-filter totals, and no command/path/output fields in persisted JSON.

- [ ] **Step 2: Run journal and executor tests to verify RED**
  Run `bun test packages/coding-agent/test/shell-minimizer-stats.test.ts packages/coding-agent/test/bash-executor.test.ts`; expect missing module/metadata failures.

- [ ] **Step 3: Implement journal and metadata**
  Record only actual rewrites with positive savings, best-effort. Add `BashResult.minimization`, preserve the raw artifact id, and copy it to `BashToolDetails.minimization`. Keep interactive results unchanged.

- [ ] **Step 4: Add and pass the real native result contract**
  Use an isolated settings directory/TOML filter and spy on journal recording. Assert a long minimized `printf` returns filter, exact byte counts, and the saved artifact id; then run both test files and expect PASS.

### Task 2: Read-only daemon RPCs

**Files:**
- Create: `packages/coding-agent/src/session/artifact-preview.ts`
- Create: `packages/coding-agent/test/daemon/session-artifact-read-rpc.test.ts`
- Create: `packages/coding-agent/test/daemon/settings-shell-minimizer-stats-rpc.test.ts`
- Modify: `packages/coding-agent/src/daemon/server.ts`
- Modify: `packages/coding-agent/src/daemon/services/legacy-routes.ts`

**Interfaces:**
- `session.artifactRead { sessionId, id } → { text, truncated, totalBytes }`.
- `settings.shellMinimizerStats {} → ShellMinimizerStats` from Task 1.

- [ ] **Step 1: Write failing RPC tests**
  Cover full text, bounded preview, invalid/non-numeric ids, missing artifact, unknown session, and two sessions reusing id `1`. Spy on the stats reader and assert the RPC returns its aggregate without touching the production journal.

- [ ] **Step 2: Run tests to verify RED**
  Run the two new daemon test files; expect unknown RPC methods.

- [ ] **Step 3: Implement bounded artifact preview and routes**
  Resolve through `live.agentSession.sessionManager.getArtifactPath(id)`, return no path, and cap at 8 MiB with explicit truncation. Register both legacy routes and the stats read route.

- [ ] **Step 4: Run tests to verify GREEN**
  Run both new files plus `packages/coding-agent/test/daemon/route-coverage*` when present; expect PASS.

### Task 3: Shell statistics and advanced settings UI

**Files:**
- Create: `apps/desktop/src/components/settings-sections/shell-minimizer-stats.tsx`
- Create: `apps/desktop/test/shell-minimizer-settings.test.tsx`
- Modify: `apps/desktop/src/components/settings-sections/shell.tsx`
- Modify: `apps/desktop/src/styles/gui-chat.css`
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/settings.ts`
- Modify: `packages/client-core/src/i18n/en-US/settings.ts`

**Interfaces:**
- Consumes Task 2 `settings.shellMinimizerStats` summary.
- Produces a labelled native progress bar and an accessible Refresh button.

- [ ] **Step 1: Write failing component and schema exposure tests**
  Render `ShellSection` with canned schema/settings/stats. Assert saved bytes, weighted percent, per-filter row, native progress, refresh RPC, advanced keys, and stale-response suppression after unmount.

- [ ] **Step 2: Run component test to verify RED**
  Run `bun test apps/desktop/test/shell-minimizer-settings.test.tsx`; expect missing stats UI/schema failures.

- [ ] **Step 3: Implement settings and stats card**
  Add Bash Advanced UI metadata, bilingual labels/descriptions, and a responsive stats section using existing settings cards and native `<progress>`.

- [ ] **Step 4: Run tests to verify GREEN**
  Run the component test and desktop type check; expect PASS.

### Task 4: Bash card metadata and raw preview

**Files:**
- Create: `apps/desktop/src/components/SessionArtifactPreviewDialog.tsx`
- Create: `apps/desktop/test/session-artifact-preview-dialog.test.tsx`
- Create: `packages/client-core/test/bash-renderer-minimization.test.tsx`
- Modify: `packages/client-core/src/tool-render/types.ts`
- Modify: `packages/client-core/src/tool-render/tools/bash.tsx`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/styles/gui-chrome.css`

**Interfaces:**
- `ToolRenderHost.openArtifact?(id: string): void`.
- Desktop calls Task 2 `session.artifactRead` with the current session id.

- [ ] **Step 1: Write failing renderer and dialog tests**
  Assert per-command percent/filter, no dead button without host/artifact, and host invocation. Dialog tests cover exact RPC params, loaded text, truncation notice, error, close, and no state update after unmount.

- [ ] **Step 2: Run tests to verify RED**
  Run both new test files; expect missing metadata/button/dialog failures.

- [ ] **Step 3: Implement renderer capability and preview dialog**
  Preserve numeric artifact fallback, add optional host action, keep `DialogFrame` always mounted, and use a wide scrollable read-only preview with a visible close button.

- [ ] **Step 4: Run tests to verify GREEN**
  Run both new files and the client-core/desktop type checks; expect PASS.

### Task 5: Living docs, prompt, changelog, and end-to-end verification

**Files:**
- Modify: `packages/coding-agent/src/prompts/tools/bash.md`
- Modify: `docs/tools/bash.md`
- Modify: `docs/bash-tool-runtime.md`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1: Document the final contracts**
  Describe byte statistics, raw-artifact preview, advanced settings, RPC bounds, and unchanged PTY behavior. Explain that `[raw output: artifact://…]` retrieves exact output; do not imply command rewriting.

- [ ] **Step 2: Run focused and package checks**
  Run all new/affected tests, `bun run --cwd=packages/coding-agent check`, `bun run --cwd=packages/client-core check`, `bun run --cwd=apps/desktop check`, docs/i18n checks, and regenerate tool views if required. Record any pre-existing failures separately.

- [ ] **Step 3: Exercise the real desktop scenario**
  Use isolated development storage. Run a command that actually minimizes, verify its details and journal record, open raw output from the card, verify the 8 MiB/error behavior, and refresh Settings → Shell to see the new totals. Verify keyboard close/focus return.

- [ ] **Step 4: Inspect the final tree**
  Run `git status --short`, remove only generated files created by this work that are not deliverables, and confirm unrelated edits remain untouched.
