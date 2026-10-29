# MusePi Profile and Preset Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Computer Use by default, use MusePi-owned profile naming, and let bundle-declared Agent presets resolve as real session presets.

**Architecture:** Support only `musepi.profile.bundles`; DSH profile fields are ignored. Add a pure profile-preset projection that feeds existing mode listing and SDK resolution, preserving file > profile > extension precedence.

**Tech Stack:** Bun, TypeScript, React, existing DSH patch composer and mode resolver, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-29-musepi-profile-preset-unification-design.md`

## Global Constraints

- Preserve all unrelated worktree changes. No commits, pushes, new dependencies, or production-profile writes in tests.
- Use RED → GREEN for every behavior change and keep existing DSH compatibility.
- Computer Use default enablement changes registration only, not approval or OS permission requirements.
- Update owning bilingual docs and `[Unreleased]` changelog entries.

## Review Focus

- Both namespace fields present: only MusePi is read; DSH-only is no-manifest; pin in Task 1.
- A file preset and profile preset sharing an id: file must win; pin in Task 3.
- Nested disabled plugin rows and persona flags must map to existing mode semantics; pin in Task 2.
- Existing rev6 chat files must upgrade only when byte-equivalent to the built-in snapshot; pin in Task 4.

---

### Task 1: Computer Use Default and MusePi Namespace

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/coding-agent/src/extensibility/plugins/profile/profile-composition.ts`
- Modify: `packages/coding-agent/src/daemon/services/bundle-service.ts`
- Modify: `packages/coding-agent/examples/plugin-magic-keyword/index.ts`
- Modify: `packages/client-core/src/i18n/{zh-CN,en-US}/tools.ts`
- Test: `packages/coding-agent/test/sdk-computer-tool-toggle.test.ts`
- Test: `packages/coding-agent/src/extensibility/plugins/profile/profile-composition.test.ts`
- Test: `packages/coding-agent/src/daemon/services/bundle-service.test.ts`
- Test: `packages/desktop-app/test/bundle-view.test.tsx`

**Interfaces:**
- `computer.enabled` defaults to true.
- Profile reads and writes support only `musepi.profile.bundles`; DSH is ignored.

- [ ] **Step 1: Change tests to require the new behavior**

Assert Computer Use is present by default and can be disabled/re-enabled. Assert new writes produce only the MusePi namespace, DSH-only declarations are ignored, and UI copy/tests name `musepi.profile.bundles`.

- [ ] **Step 2: Run and confirm RED**

Run: `bun test packages/coding-agent/test/sdk-computer-tool-toggle.test.ts packages/coding-agent/src/extensibility/plugins/profile/profile-composition.test.ts packages/coding-agent/src/daemon/services/bundle-service.test.ts packages/desktop-app/test/bundle-view.test.tsx`
Expected: FAIL on the old false default and DSH-first behavior.

- [ ] **Step 3: Implement**

Change the schema default, read precedence, writer, example generator, error/copy text, and example comment without deleting users' old DSH field.

- [ ] **Step 4: Verify**

Run the same command. Expected: PASS.

### Task 2: Project Agent Presets From a Profile

**Files:**
- Create: `packages/coding-agent/src/extensibility/plugins/profile/profile-presets.ts`
- Test: `packages/coding-agent/src/extensibility/plugins/profile/profile-presets.test.ts`

**Interfaces:**
- Produces: `collectProfilePresetDefinitions(cwd, home, profileName?): Promise<ModeDefinition[]>`.
- Agent preset rows accept `@deepseek-ai/dsh-agent-preset` and `@musepi/agent-preset`; map `config.id/plugins`, persona `prefix/complete/includeRuntimeContext`, and nested `disabled` to existing mode fields.

- [ ] **Step 1: Write failing projection tests**

Use a real bundle fixture containing an Agent preset with persona, a nested disabled row, and an enabled row. Assert id, prompt, promptComplete, runtimeContext, and plugin enablement in the returned definition. Add a no-profile case returning `[]`.

- [ ] **Step 2: Run and confirm RED**

Run: `bun test packages/coding-agent/src/extensibility/plugins/profile/profile-presets.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure projection**

Reuse `readProfileComposition` and `applyDshProfile`; do not load plugin code or create profile files.

- [ ] **Step 4: Verify**

Run the same test. Expected: PASS.

### Task 3: Resolve Profile Presets in Listing and SDK

**Files:**
- Modify: `packages/coding-agent/src/daemon/server.ts`
- Modify: `packages/coding-agent/src/sdk.ts`
- Modify: `packages/coding-agent/src/daemon/services/extension-service.ts`
- Test: `packages/coding-agent/test/profile-preset-resolution.test.ts`

**Interfaces:**
- Consumes: Task 2 `collectProfilePresetDefinitions`.
- Precedence is file > profile > extension for list and `createModeResolver` lookup.

- [ ] **Step 1: Write failing resolution tests**

Create a profile preset and an id-colliding file preset; assert profile output appears in `modes.list` and SDK resolution picks file on collision. Add a profile-only id and assert prompt/plugins resolve through the real SDK path.

- [ ] **Step 2: Run and confirm RED**

Run: `bun test packages/coding-agent/test/profile-preset-resolution.test.ts`
Expected: FAIL because profile presets are invisible.

- [ ] **Step 3: Wire the projection into list and resolver**

Merge profile definitions between file and extension in `modes.list`, include them in preset enablement projection, and inject the same lookup into initial and hot SDK mode resolution.

- [ ] **Step 4: Verify**

Run the new test plus existing mode tests. Expected: PASS.

### Task 4: Complete Built-In Presets and Docs

**Files:**
- Modify: `packages/coding-agent/src/presets/resolve.ts`
- Modify: `packages/coding-agent/test/presets/chat-narrowing.test.ts`
- Modify: `docs/{settings,settings.zh-CN,computer-use,computer-use.zh-CN,extensions-dev,extensions-dev.zh-CN,gui-design,gui-design.zh-CN,gui-implementation,gui-implementation.zh-CN}.md`
- Modify: `docs/tools/computer.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] **Step 1: Write failing preset coverage tests**

Require every `BUILTIN_TOOLS` entry except the deliberate chat keep-set (`bash`, `ask`) to be named in chat's denylist, requiring `knowledge`. Require revision 7 and a literal rev6 snapshot. Update Computer Use docs to default true.

- [ ] **Step 2: Run and confirm RED**

Run: `bun test packages/coding-agent/test/presets/chat-narrowing.test.ts packages/coding-agent/test/presets-mode-design.test.ts`
Expected: FAIL because `knowledge` is missing and revision is 6.

- [ ] **Step 3: Implement and document**

Add `knowledge`, revision 7, and a literal rev6 snapshot. Document the default and the unified declaration model/precedence, then add Unreleased entries with English children.

- [ ] **Step 4: Verify**

Run focused tests, package checks for `coding-agent`, `desktop-app`, and `client-core`, docs/changelog checks, and the desktop production build. Expected: all PASS.
