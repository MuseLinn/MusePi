# Browser History and Download Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, bounded history and download records to the managed browser and expose them through the existing browser tool and cards.

**Architecture:** A main-process CJS record store owns persistence and ordering. Managed navigation/download lifecycles write records; loopback HTTP and coding-agent return the same facts without page contents or credentials.

**Tech Stack:** Electron CJS, TypeScript, Bun tests, React 19, static prompts and client-core i18n.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-history-downloads-design.md`

## Global Constraints

- History: newest first, at most 200. Downloads: newest first, at most 100.
- Times are Unix milliseconds, sizes are bytes, and `savePath` is optional evidence, not an existence guarantee.
- Managed-only reads fail explicitly when no Electron authority is configured; no fake headless records.
- Preserve download policy, size guard, tab lifecycle and all existing actions.
- Execute inline without commits.

## Review Focus

- Corrupt or partial persistence must not become a fabricated authoritative record.
- In-place and full navigations must record committed URLs with credential stripping.
- Download progress and final status must update the same record and keep optional paths optional.
- Records must survive controller reconstruction and remain newest first after caps.
- Headless `history`/`downloads` calls must report that the managed profile is required.

---

### Task 1: Persistent record store

**Files:**
- Create: `apps/desktop/electron/managed-browser-records.cjs`
- Create: `apps/desktop/test/managed-browser-records.test.cjs`

**Interfaces:**
- Produces `ManagedBrowserRecordStore` with `recordHistory`, `beginDownload`, `updateDownload`, `history()`, `downloads()`.

- [ ] Write failing tests for persistence, newest-first ordering, caps, malformed data and optional savePath.
- [ ] Implement bounded, validated, atomic record persistence.
- [ ] Run the store tests.

### Task 2: Navigation/download lifecycle and loopback

**Files:**
- Modify: `apps/desktop/electron/managed-browser.cjs`
- Modify: `apps/desktop/test/managed-browser-menu-ipc.test.cjs`
- Create: `apps/desktop/test/managed-browser-records-ipc.test.cjs`

**Interfaces:**
- Controller serves `/musepi/history` and `/musepi/downloads` from the store, while recording actual lifecycle events.

- [ ] Add failing controller tests for committed navigation, progress/final download status and controller reconstruction.
- [ ] Wire the store into navigation/download lifecycles and loopback GET routes.
- [ ] Run managed-browser record and existing IPC tests.

### Task 3: Agent actions and user cards

**Files:**
- Modify: `packages/coding-agent/src/tools/browser/state.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Create: `packages/coding-agent/test/tools/browser-history-downloads.test.ts`
- Modify: `packages/client-core/src/tool-render/tools/browser-structured.tsx`
- Modify: `packages/client-core/test/browser-structured-card.test.tsx`

**Interfaces:**
- Produces `history`/`downloads` details with records matching Task 1 and explicit managed-only failures.

- [ ] Add failing action projection, managed-only error and record-card tests.
- [ ] Implement loopback readers, actions and cards.
- [ ] Run action/card tests and client-core check.

### Task 4: Prompt, docs and final proof

**Files:**
- Modify: `packages/coding-agent/src/prompts/tools/browser.md`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] Add failing prompt assertions for retained records, limits, progress and savePath semantics.
- [ ] Update guidance, examples, bilingual docs and changelog.
- [ ] Run the full related browser suite, generated views, desktop build and scoped self-review.
- [ ] Verify an isolated HTTP read and real browser-tool projection on the final code.
