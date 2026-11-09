# Browser Navigation and Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit navigation/history/load actions and observable page-condition waiting to the existing browser tool.

**Architecture:** Generate navigation and wait code for the current run scope. Read the configured search engine, use actual page state for results, and return lastObserved evidence on both match and timeout.

**Tech Stack:** TypeScript, Puppeteer, Bun tests, React 19, static prompts and client-core i18n.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-navigation-wait-design.md`

## Global Constraints

- Search mapping stays google/bing/duckduckgo/baidu with Google fallback.
- Wait timeout defaults to 10000 ms and is capped at 30000; stableForMs is 0–5000.
- Timeout returns an error with lastObserved, never an empty success.
- Preserve all existing actions and the current run lifecycle; no commits.

## Review Focus

- Empty query/URL and invalid condition/state combinations must fail before navigation or polling.
- Hidden/absent conditions must succeed only when no rendered match exists.
- stableForMs must reset when the condition becomes false.
- Already-satisfied load states must return immediately.
- Timeout must include the last actual observation.

---

### Task 1: Navigation and load actions

**Files:**
- Create: `packages/coding-agent/src/tools/browser/navigation.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Create: `packages/coding-agent/test/tools/browser-navigation.test.ts`
- Modify: `packages/client-core/src/tool-render/tools/browser-structured.tsx`
- Modify: `packages/client-core/test/browser-structured-card.test.tsx`

**Interfaces:**
- Produces `navigationActionCode(params, engine)` and `navigation` details for the card.

- [ ] Add failing schema/helper/action/card tests for search mapping, history actions, stop/reload/load and required inputs.
- [ ] Implement navigation helpers, actions and navigation card.
- [ ] Run navigation/card tests and client-core check.

### Task 2: Observable page-condition waiting

**Files:**
- Create: `packages/coding-agent/src/tools/browser/wait.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Create: `packages/coding-agent/test/tools/browser-wait.test.ts`
- Modify: `packages/client-core/src/tool-render/tools/browser-structured.tsx`
- Modify: `packages/client-core/test/browser-structured-card.test.tsx`

**Interfaces:**
- Produces `pageWaitCode(condition, timeoutMs, stableForMs)` and `waitResult { outcome, condition, lastObserved, timeoutMs }`.

- [ ] Add failing tests for all condition kinds, stability reset, matched/timeout results and wait card evidence.
- [ ] Implement bounded polling, observation projection and wait card.
- [ ] Run wait/card tests and client-core check.

### Task 3: Prompt, docs and real-page proof

**Files:**
- Modify: `packages/coding-agent/src/prompts/tools/browser.md`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] Add failing prompt assertions for search, lifecycle actions, wait conditions and timeout evidence.
- [ ] Update examples, guidance, bilingual docs and changelog.
- [ ] Run the full related browser suite, generated views and desktop build.
- [ ] On an isolated real page, verify back/forward, reload/stop, load state, element/text/URL matching, stability and timeout evidence; perform scoped self-review.
