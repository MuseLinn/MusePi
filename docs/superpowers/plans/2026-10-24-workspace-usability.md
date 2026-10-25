# Workspace Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn MusePi's Issue/PR, task, capability, board, and settings surfaces into consistent, working desktop workspaces rather than list-only or clipped displays.

**Architecture:** Keep the existing daemon/gh data path and React component stack. Recompose the current details into master-detail layouts, extract one page-header primitive, portal collapsed search through `MenuPopup`, and add only the two comment mutations missing from the daemon.

**Tech Stack:** Bun, React 19, TypeScript, CSS design tokens, `@musepi/client-core` Markdown/i18n, existing `MenuPopup`, bun:test, Electron.

**Spec:** `C:/Users/unive/.kimi-code/sessions/wd_musepi-omp_22c723746868/session_955fda32-d353-47f9-b32a-0a4e95431676/agents/main/plans/polaris-donna-troy-cannonball.md`

## Global Constraints

- Preserve all unrelated uncommitted work; never reset, stash, or commit unless explicitly requested.
- Use existing design tokens, `Markdown`, `MenuPopup`, `DialogFrame`, central utilities, and i18n domains; add no dependency.
- Every new zh-CN key has an en-US sibling; every changelog bullet has one `- EN:` child.
- No `any`, `ReturnType`, inline type imports, source-grep tests, `mock.module()`, or production-session/daemon writes.
- Update `docs/gui-design*` and `docs/gui-implementation*` for behavior changes.

## Review Focus

- gh emits uppercase states: `OPEN` must produce an open icon and a Close action, never Reopen (Task 1).
- Slow detail responses must not replace a newly selected issue/PR (Task 2).
- Empty or whitespace comments must not invoke gh; gh failures must remain visible (Tasks 1–2).
- A calendar day with multiple tasks must expose every task and lead to visible details (Task 4).
- Collapsed settings search must escape the 64px rail without filtering the rail itself and must restore focus on Escape (Task 5).
- Narrow containers must not create horizontal overflow; long titles and Markdown code blocks stay within their own scroll regions (Tasks 2, 3, 5; live verification in Task 7).

---

### Task 1: Comment RPC and state semantics

**Files:**
- Modify: `packages/coding-agent/src/daemon/server.ts`
- Modify: `packages/coding-agent/src/daemon/services/legacy-routes.ts`
- Create: `packages/coding-agent/test/daemon/github-comments.test.ts`
- Modify: `packages/desktop-app/src/components/pr-center.tsx`
- Modify: `packages/desktop-app/test/pr-search.test.ts`

**Interfaces:**
- Produces RPC `github.issueComment { cwd, number, body }` and `github.prComment { cwd, number, body }` → `{ ok: true } | { error: string }`.
- Produces `isOpenState(state: string): boolean` from `pr-center.tsx`.

- [ ] Write daemon handler tests using the existing isolated-daemon/fake-gh facilities: valid calls execute `issue|pr comment <n> --body <body>`, blank bodies return `comment required` without spawning gh, and nonzero gh exits return stderr.
- [ ] Run the new daemon test and confirm it fails because the RPCs do not exist.
- [ ] Implement and register both RPCs beside the existing issue/PR state routes, using host-aware `runGh` and positive-integer validation.
- [ ] Add a desktop regression test asserting `isOpenState("OPEN") === true`, `isOpenState("open") === true`, and `isOpenState("CLOSED") === false`; confirm it fails before exporting/using the helper.
- [ ] Use the helper for Issue list icons and detail close/reopen behavior.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Issue/PR master-detail reading and commenting

**Files:**
- Modify: `packages/desktop-app/src/components/pr-center.tsx`
- Modify: `packages/desktop-app/src/styles/gui-workspace.css`
- Modify: `packages/client-core/src/i18n/zh-CN/general.ts`
- Modify: `packages/client-core/src/i18n/en-US/general.ts`
- Create: `packages/desktop-app/test/pr-center.test.tsx`

**Interfaces:**
- Consumes Task 1 RPCs and `isOpenState`.
- Produces shared `CommentComposer({ busy, onSubmit })` behavior inside the PR center; no external API required.

- [ ] Write component tests with a mocked `RpcClient`: first loaded issue is selected, `github.issueView` supplies rendered detail, a stale earlier response cannot replace the latest selection, and submitting a comment calls the proper RPC then reloads and clears the draft.
- [ ] Run tests and confirm the current inline/plain-text implementation fails the observable contracts.
- [ ] Recompose `PrPane` and `IssuesPane` into independent list/detail scroll columns; auto-select the first visible row, repair invalid selections after filters, and keep current-branch/create forms in the list column.
- [ ] Render bodies and comments through `Markdown`; add structured metadata, zero-comment state, and a shared comment composer for both detail types. Add stale-response protection.
- [ ] Replace the fixed 880px board body with a full-width responsive master-detail grid; use `minmax(0, …)`, independent overflow, and a single-column narrow fallback.
- [ ] Add synchronized i18n strings and run focused tests plus desktop type checking.

### Task 3: Shared first-class page header

**Files:**
- Create: `packages/desktop-app/src/components/WorkspacePageHeader.tsx`
- Modify: `packages/desktop-app/src/components/PrBoardPage.tsx`
- Modify: `packages/desktop-app/src/components/ScheduledTasksPage.tsx`
- Modify: `packages/desktop-app/src/components/BoardPage.tsx`
- Modify: `packages/desktop-app/src/components/CapabilityCenterPage.tsx`
- Modify: `packages/desktop-app/src/styles/gui-workspace.css` (or the existing owning stylesheet after inspection)

**Interfaces:**
- Produces `WorkspacePageHeader({ icon, title, description?, onBack?, backLabel?, meta?, actions?, tabs? }): ReactNode`; `title` accepts `ReactNode` for editable board titles.

- [ ] Add a component contract test proving one `h1`, a consistent back action, and optional tab/action content across representative usages.
- [ ] Implement the shared header and token-based CSS with no new decorative card or font dependency.
- [ ] Migrate all four pages: back at the leading edge, consistent title/description/actions, task/capability tabs in the same header skeleton, board-home back-to-workspace, and active-board back-to-collection.
- [ ] Run the component test and desktop checks.

### Task 4: Task calendar/board selection becomes visible

**Files:**
- Modify: `packages/desktop-app/src/components/ScheduledTasksPage.tsx`
- Modify: `packages/desktop-app/src/components/TaskCenterViews.tsx`
- Create: `packages/desktop-app/test/task-center-views.test.tsx`
- Modify both settings i18n domain files if new copy is needed.

**Interfaces:**
- Produces `openTask(id: string): void` inside `ScheduledTasksPage`, setting selection and `view === "tasks"`.
- `TaskCalendarView` keeps `onSelectTask?(id)` and adds date selection plus a readable per-day task list.

- [ ] Write tests with two tasks on one day: both appear as actionable items, each reports its id, and a board card follows the same selection path.
- [ ] Confirm current calendar behavior fails the multi-task contract.
- [ ] Implement selected-day state/list and the shared `openTask` path; add accessible names to icon-only task actions.
- [ ] Run task-view tests and desktop checks.

### Task 5: Collapsed settings search portal

**Files:**
- Modify: `packages/desktop-app/src/components/SettingsNav.tsx`
- Modify: `packages/desktop-app/src/styles/gui-settings.css`
- Modify: `packages/desktop-app/test/settings-shell.test.tsx`

**Interfaces:**
- Consumes existing `MenuPopup({ open, portal, anchor, onOpenChange })`.
- Preserves controlled `query` / `onQueryChange` and `onSelect` props.

- [ ] Mock `matchMedia("(max-width: 900px)")`; write tests proving opened search is portaled outside the nav, typing does not remove rail rows, result selection closes/clears, and Escape closes and returns focus to the search button.
- [ ] Confirm the current inline popup fails the portal/rail contracts.
- [ ] Replace the collapsed inline popup with anchored `MenuPopup`, filter the rail with an empty query only in collapsed mode, reset transient state at breakpoint changes, and remove obsolete clipped-popup CSS.
- [ ] Run settings tests and desktop checks.

### Task 6: Documentation and release notes

**Files:**
- Modify: `docs/gui-design.md`, `docs/gui-design.zh-CN.md`, pairing yaml
- Modify: `docs/gui-implementation.md`, `docs/gui-implementation.zh-CN.md`, pairing yaml
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] Document the master-detail/header/settings-search contracts and the two comment RPCs in both languages; update pairing metadata with the repository's `--write` workflow.
- [ ] Add concise user-facing Added/Changed/Fixed bullets with exact `- EN:` children under `[Unreleased]`.
- [ ] Run `bun run check:changelog-i18n`, changelog voice, and translation-pairing checks.

### Task 7: Full verification and real GUI acceptance

**Files:** verification outputs only under an isolated temp/smoke directory.

- [ ] Run focused desktop and coding-agent suites, then `bun --cwd=packages/desktop-app run check`, `bun --cwd=packages/client-core run check`, `bun --cwd=packages/coding-agent run check`, and root `bun run check:tools`.
- [ ] Run `bun --cwd=packages/desktop-app run build` and fix failures on the deliverable.
- [ ] Launch through `bun scripts/dev-smoke.ts -- <command>` with isolated agent/daemon dirs and fake gh fixtures; do not write real issues, PRs, comments, sessions, or production daemon state.
- [ ] Exercise first-item preview, selection races, Markdown, comment success/failure, all four headers, multi-task calendar, board selection, and ≤900px settings search. Capture screenshots and keyboard/focus results.
- [ ] Report exact passing commands and any genuinely unverified live path; do not substitute compilation for GUI acceptance.
