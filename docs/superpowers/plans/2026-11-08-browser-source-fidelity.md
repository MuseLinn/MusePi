# Browser Source Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing turn Sources card correctly classify structured reads and actual visits without inventing pages from screenshots or clicks.

**Architecture:** Extend the transcript's existing `collectTurnSources` aggregation. Structured `pageText`, top-level action/url, and legacy operation records remain the only evidence; `TurnSourcesCard` and host capabilities stay unchanged.

**Tech Stack:** TypeScript, React 19, Bun tests, existing client-core i18n and generated tool views.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-source-fidelity-design.md`

## Global Constraints

- Only successful `open`/`goto` creates a passed page; only successful `read`/legacy `observe` creates a read page.
- Other operations may enrich known pages but cannot create sources. Failed/running calls contribute nothing.
- Preserve first-seen order, repeated-open counts, existing UI, and no-new-data-pipeline design.
- No new dependencies or Git commits.

## Review Focus

- Structured `read` uses `pageText.url/title` even though its operation is `evaluate`.
- Screenshot/click/status-only calls produce no page.
- Repeated open plus read of one URL stays one read page, not one read plus one passed page.

---

### Task 1: Correct the source aggregation

**Files:**
- Modify: `packages/client-core/src/components/transcript/turn-sources.ts`
- Modify: `packages/client-core/test/turn-surfaces.test.ts`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

**Interfaces:**
- Keeps `collectTurnSources(blocks, resultOf): TurnSources` and all existing card types unchanged.

- [ ] **Step 1:** Add failing tests: a structured read and an open produce one read/one passed page; a repeated open plus read of one URL produces one read page with `opens: 2`; screenshot/click/status-only results produce no page.
- [ ] **Step 2:** Run `bun test packages/client-core/test/turn-surfaces.test.ts`; expect classification failures.
- [ ] **Step 3:** Implement minimal aggregation changes using top-level `action`, `url`, `pageText`, and existing operations. Keep legacy `observe`/`goto` compatibility and first-seen ordering.
- [ ] **Step 4:** Re-run turn-surface/card tests, the full related browser suite, client-core check, generated tool views, translation pairing and changelog checks.
- [ ] **Step 5:** Update bilingual owning docs and Unreleased changelog with the exact read/visit semantics and remaining non-goal of full protocol parity.
