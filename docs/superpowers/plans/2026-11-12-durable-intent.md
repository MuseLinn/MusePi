# Durable Tool Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record and flush a recoverable tool-start intent before any tool with possible side effects begins executing, while allowing explicitly read-only tools to skip the barrier.

**Architecture:** Add an awaited `beforeToolExecution` hook after `tool_execution_start` and before `tool.execute`. AgentSession persists the assistant and tool-start entry, fans the event out once, flushes the SDK transcript and the daemon journal, then lets execution continue. Unknown tools require the barrier by default; only `requiresDurableIntent:false` opts out.

**Tech Stack:** TypeScript, Bun test, AgentLoop/AgentSession, SessionManager and AppendJournal. Durability target is process-crash recovery through existing write/flush semantics, not power-loss safety; no `fsync` is added.

**Spec:** User-approved durable-intent order and the verified producer/consumer chain in the 2026-11-12 conversation.

## Global Constraints

- No commits, branches, pushes, PRs, releases, unrelated UI edits, or new dependencies.
- Do not use `beforeToolCall`: it also covers calls later blocked or skipped and would falsely mark them as started.
- The early start event is persisted and broadcast exactly once. The later stream event must not duplicate it.
- The assistant entry precedes the tool-start marker even in a brand-new session.
- Barrier failure is fail-closed: the tool does not execute and its error is visible.
- No tool schema or prompt change is needed because the declaration controls host persistence, not model behavior.
- Update both extension docs, session docs, capability seams, and the bilingual changelog.

## Review Focus

- A synchronous side effect occurs only after subscriber fan-out and journal flush (Task 1).
- A first-session assistant precedes the tool-start marker and no duplicate start is emitted (Task 1).
- A flush rejection prevents `execute` and becomes a tool error (Task 1).
- Read-only tools do not pay the barrier, including through wrapper proxies (Task 2).
- Daemon create and reactivate paths both flush the adopted live journal (Task 2).

---

### Task 1: Awaited Intent Barrier

**Files:**
- Modify: `packages/agent/src/types.ts`, `packages/agent/src/agent.ts`, `packages/agent/src/agent-loop.ts`
- Modify: `packages/coding-agent/src/session/agent-session-types.ts`, `packages/coding-agent/src/session/agent-session.ts`
- Test: `packages/coding-agent/test/session-exit-diagnostics.test.ts`

**Interfaces:**
- Produces: `AgentLoopConfig.beforeToolExecution(context: BeforeToolCallContext, signal?) => Promise<void> | void`, forwarded by `AgentOptions`.
- Produces: `AgentSessionConfig.flushDurableToolIntent?: (event: Extract<AgentEvent, { type: "tool_execution_start" }>) => Promise<void>`.
- Produces: `AgentTool.requiresDurableIntent?: boolean`, defaulting to true.

- [ ] **Step 1: Write the failing end-to-end tests**

Drive `AgentSession.prompt` with a scripted tool call. Assert subscriber start precedes real `AppendJournal.flush`, which precedes synchronous `execute`; the start appears once and the assistant precedes its marker. Assert `requiresDurableIntent:false` skips flush and a flush rejection prevents execution with an error result.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/coding-agent/test/session-exit-diagnostics.test.ts -t "durable intent"`
Expected: the barrier callback is absent and execution has no preceding flush.

- [ ] **Step 3: Implement the hook and early-event dedupe**

Forward the hook through AgentLoop. In AgentSession, synchronously mark the intent as emitted, persist the assistant and start entry, emit once, flush SessionManager and the configured journal callback, then execute. Skip the later duplicate persistence/fan-out while retaining the rest of event handling.

- [ ] **Step 4: Verify GREEN**

Run the Task 1 command and the full `session-exit-diagnostics` file.
Expected: all pass, including existing interrupted-tool and shutdown tests.

### Task 2: Read-Only Declarations and Daemon Journal Wiring

**Files:**
- Modify read-only tool declarations under `packages/coding-agent/src/tools`, `packages/coding-agent/src/lsp`, `packages/coding-agent/src/web`, and `packages/coding-agent/src/bundled-plugins` as needed.
- Modify: `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/daemon/session-host.ts`
- Docs: `docs/extensions-dev.md`, `docs/extensions-dev.zh-CN.md`, `docs/session.md`, `docs/session.zh-CN.md`, `docs/capability-seams.md`
- Changelog: `packages/coding-agent/CHANGELOG.musepi.md`

**Interfaces:**
- Consumes: Task 1 hook and `requiresDurableIntent:false` through existing `applyToolProxy` forwarding.
- Produces: create/reactivate pass a callback that awaits the adopted `live.journal.flush()`.

- [ ] **Step 1: Add the failing wrapper/read-only case**

Prove a proxied tool with `requiresDurableIntent:false` skips the barrier while a default-declared tool still requires it. Cover both daemon creation and reactivation with the adopted journal callback.

- [ ] **Step 2: Verify RED**

Run the durable-intent tests and relevant daemon session tests.
Expected: missing declarations or wiring cause failure.

- [ ] **Step 3: Mark only demonstrably read-only built-ins and connect both daemon paths**

Use `requiresDurableIntent:false` for read, grep/glob, AST search, LSP queries, image inspection, connector catalog, web search, recall/knowledge, ask, think, and yield. Leave unknown, mutating, command, browser, task, memory-write, and dispatch tools at the default barrier.

- [ ] **Step 4: Verify GREEN and document the contract**

Run durable-intent, agent-loop, session-exit, host, and package type checks. Document the opt-out rule, exact-once start, process-crash boundary, and absence of a power-loss/`fsync` guarantee; update the changelog.

### Final Verification

- Run all affected tests and `rtk bun --cwd=packages/agent run check:types` plus `rtk bun --cwd=packages/coding-agent run check:types`.
- Run `rtk bun run check:docs`, `rtk bun run check:changelog-i18n`, and translation pairing for every edited pair.
- Inspect `git status`; only planned recovery files and ignored test artifacts may differ.
