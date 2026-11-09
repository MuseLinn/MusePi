# Browser Visual and Device Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add original-image visual crops, continuous drag paths, and validated device profiles/responsive configuration to the existing browser tool.

**Architecture:** Extend the existing visual snapshot registry and snapshot-action compiler. Crop saved capture bytes locally, compile pointer paths into the current run scope, and apply device settings with Puppeteer viewport semantics while preserving existing backends and actions.

**Tech Stack:** TypeScript, Bun.Image, Puppeteer, React 19, Bun tests, static prompts and client-core i18n.

**Spec:** `docs/superpowers/specs/2026-11-08-browser-visual-device-design.md`

## Global Constraints

- Crop coordinates are returned screenshot pixels; a crop returns `sourceSnapshotId` and no new clickable snapshot.
- Paths contain 2–500 points and release pointer/modifier state after success or failure.
- Display scale is metadata for the preview, not CSS viewport size or page zoom.
- Preserve all existing actions, dialogs, release semantics and snapshot TTL/ownership checks.
- Execute inline in the current workspace; do not create commits.

## Review Focus

- Out-of-bounds or fractional crop regions must fail clearly rather than reading unrelated pixels.
- A path with too few/many points or invalid duration/modifiers must not press the mouse button.
- Responsive requires dimensions; presets reject explicit dimensions; fixed requires scale and fit rejects it.
- Full-resolution saved captures must scale the requested region from returned-image pixels into file pixels.
- Disabling device mode must clear viewport/mobile/touch overrides rather than inventing a mobile default.

---

### Task 1: Original-image visual crop

**Files:**
- Create: `packages/coding-agent/src/tools/browser/visual-crop.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Create: `packages/coding-agent/test/tools/browser-visual-crop.test.ts`
- Modify: `packages/client-core/src/tool-render/tools/browser-structured.tsx`
- Modify: `packages/client-core/test/browser-snapshot-card.test.tsx`

**Interfaces:**
- Produces `cropVisualSnapshot(snapshot, region)` and `BrowserVisualCrop { sourceSnapshotId, region, image, capturedAt }`; `visualCrop` details feed the renderer.

- [ ] Write failing tests for crop pixel fidelity, source id/capture time, bounds, and the card's source/region display.
- [ ] Implement region validation, full-resolution scaling, PNG output and `visual_crop` details/content.
- [ ] Run crop and snapshot-card tests plus coding-agent/client-core type checks.

### Task 2: Continuous drag paths

**Files:**
- Modify: `packages/coding-agent/src/tools/browser/snapshot-actions.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Modify: `packages/coding-agent/test/tools/browser-snapshot-actions.test.ts`

**Interfaces:**
- Consumes visual snapshots from Task 1's existing registry.
- Produces `drag_path` with `points`, optional `button`, `durationMs`, and `modifiers`, returning the existing `actionReceipt`.

- [ ] Add failing schema/compiler tests for 2–500 points, mapped coordinates, duration/modifiers/button, and invalid paths.
- [ ] Implement continuous pointer movement with bounded interpolation and finally-release behavior.
- [ ] Run snapshot-action and schema tests plus coding-agent type check.

### Task 3: Device catalog and configuration

**Files:**
- Create: `packages/coding-agent/src/tools/browser/devices.ts`
- Modify: `packages/coding-agent/src/tools/browser.ts`
- Create: `packages/coding-agent/test/tools/browser-devices.test.ts`
- Modify: `packages/client-core/src/tool-render/tools/browser-structured.tsx`
- Modify: `packages/client-core/test/browser-snapshot-card.test.tsx`

**Interfaces:**
- Produces `BROWSER_DEVICE_PROFILES`, `deviceActionCode(input)`, `deviceProfiles` and `deviceConfiguration` details for the cards.

- [ ] Add failing tests for the catalog, preset orientation/scale rules, responsive mobile/touch, invalid combinations, disable behavior, and device cards.
- [ ] Implement validated configuration and `device_profiles`/`set_device` actions using `page.setViewport`, including `null` on disable.
- [ ] Run device/card tests and package type checks.

### Task 4: Prompt, docs and end-to-end proof

**Files:**
- Modify: `packages/coding-agent/src/prompts/tools/browser.md`
- Modify: `packages/client-core/src/i18n/en-US/tools.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/tools.ts`
- Modify: `docs/gui-design.md` and `docs/gui-design.zh-CN.md`
- Modify: `docs/gui-implementation.md` and `docs/gui-implementation.zh-CN.md`
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`

- [ ] Add failing prompt assertions for crop source pixels, path usage, and device re-observation.
- [ ] Restore prompt examples/guidance and update bilingual cards/docs/changelog.
- [ ] Run the full related browser suite, generated tool views, translation/docs/changelog checks and desktop build.
- [ ] On an isolated real page, verify crop pixels, a curved canvas stroke, responsive mobile/touch, desktop preset and disable. Perform scoped self-review without a subagent.
