# Host Replacement Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the old host-plugin instance when a replacement fails, without replaying its `apply` or losing its provider registrations.

**Architecture:** Mount the replacement before disposing the old instance. Centralize provider replacement with `commit`/`dispose`: an abandoned replacement restores the incumbent; a committed replacement unloads the successor on dispose. Host service disposers are invoked only immediately before publishing the new instance and can be restored without re-running `apply`.

**Tech Stack:** TypeScript, Bun test, existing Cordis mount and provider registry, TLA+ safe and unsafe lifecycle models.

**Spec:** The user's requirement to remove the restart-only compromise and preserve the old instance; dsh disposal ordering and oh-my-pi provider identity guards.

## Global Constraints

- A failed replacement never re-runs the old `apply` and never silently discards its provider.
- Successful replacement disposes the old instance without unregistering the successor.
- No merge or push; commit after focused tests, then run full validation.
- Do not claim rollback of arbitrary external plugin side effects.

## Review Focus

- Failed replacement applies once and keeps the incumbent provider and service objects.
- Successful replacement registers exactly one successor provider.
- Partial service publication is reclaimed before the incumbent is restored.
- The TLA+ safe model preserves on failure; the unsafe model produces a visible rollback loss.

## Task: Preserve replacement candidates until commit

**Files:**
- Modify `packages/coding-agent/src/memory-backend/providers.ts` and its test.
- Modify `packages/coding-agent/src/extensibility/plugins/runtime/host-runtime.ts` and lifecycle tests.
- Modify `spec/HostPluginLifecycle*`, `spec/README.md`, owning docs and CHANGELOG.

**Interfaces:**
- `replaceMemoryBackendProvider(provider): { commit, dispose }`.
- `mountHostEntry(..., replacements, beforePublish)` stages provider replacement and delays host-service publication until the candidate is ready.

- [ ] **Step 1: RED** — require failed replacement not to replay old `apply`, not to request restart, and to retain provider/service objects.
- [ ] **Step 2: Implement** — provider replacement objects, staged host mount, registration restoration without reapply, and success commit.
- [ ] **Step 3: GREEN** — host suites, provider replacement tests, package type checks, and TLA+ safe/unsafe cases.
- [ ] **Step 4: Commit** — `fix(plugins): preserve host plugins on failed replacement`.
- [ ] **Step 5: Final verification** — `check:ts`, focused recovery suites, and 4-way coding-agent-heavy full suite.
