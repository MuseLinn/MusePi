# Brand Icon Style Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global preference that switches all UI brand icons between theme-following Mono (default) and the icon set's brand-coloured variants, with a fallback to Mono where a brand has no colour variant.

**Architecture:** A shared `brand-icon-style` module owns the `musepi-gui-brand-icons` localStorage key and a change event; a React hook subscribes for live updates. Both the import-source picker and the model provider icon map hold `{ mono, color? }` pairs instead of a single component, so rendering picks the variant by preference and falls back when colour is absent. No daemon/RPC/session code changes.

**Tech Stack:** React 19, `@lobehub/icons` 6.16, TypeScript, bun test, localStorage.

**Spec:** `docs/superpowers/specs/2026-11-18-brand-icon-style-toggle-design.md`

## Global Constraints

- Default preference is `mono`; never change the default.
- Preference key is exactly `musepi-gui-brand-icons`, values `mono` | `color`.
- Change event name is exactly `musepi-gui-brand-icons-changed`.
- Every brand pair must have a `mono` component; `color` is optional and absent brands must render Mono, never an empty icon.
- All icons come from `@lobehub/icons`; no CSS filters or hand-coded brand colours.
- Use `bunx biome check`, never `tsc`; package `check` scripts are the command source of truth.
- User-facing copy must be added to both `en-US` and `zh-CN` i18n.
- Do not commit unless asked.

## Review Focus

- A brand lacking `.Color` must still render with Mono in `color` mode — pinned by a unit test asserting the resolved component is the Mono one.
- `WorkBuddy` has no top-level named export in 6.16 — pinned by using its deep import in both tasks and a render check.
- Switching preference must update already-mounted icons — pinned by a hook test that dispatches the change event and observes a re-render.
- The import picker's compile-time "every source has a mark" check must survive the map becoming pairs — pinned by running `tsgo` after both map rewrites.
- Default/missing/corrupt localStorage value must resolve to `mono` — pinned by a unit test with absent and junk values.

---

### Task 1: Shared preference module + hook

**Files:**
- Create: `apps/desktop/src/lib/brand-icon-style.ts`
- Test: `apps/desktop/src/lib/brand-icon-style.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type BrandIconStyle = "mono" | "color"`
  - `readBrandIconStyle(): BrandIconStyle`
  - `writeBrandIconStyle(style: BrandIconStyle): void`
  - `subscribeBrandIconStyle(listener: () => void): () => void`
  - `useBrandIconStyle(): BrandIconStyle`

- [ ] **Step 1: Write failing test for default and corrupt values**

```ts
import { describe, expect, it, beforeEach } from "bun:test";
import { readBrandIconStyle } from "./brand-icon-style";

beforeEach(() => localStorage.clear());

describe("brand icon style", () => {
  it("defaults to mono when unset", () => {
    expect(readBrandIconStyle()).toBe("mono");
  });

  it("falls back to mono on a junk stored value", () => {
    localStorage.setItem("musepi-gui-brand-icons", "rainbow");
    expect(readBrandIconStyle()).toBe("mono");
  });

  it("reads a stored colour preference", () => {
    localStorage.setItem("musepi-gui-brand-icons", "color");
    expect(readBrandIconStyle()).toBe("color");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/lib/brand-icon-style.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Implement `readBrandIconStyle`, `writeBrandIconStyle` (writes localStorage then dispatches `musepi-gui-brand-icons-changed` on `window`), `subscribeBrandIconStyle` (adds/removes that event listener, returns disposer), and `useBrandIconStyle` (React `useSyncExternalStore` with `subscribeBrandIconStyle` and `readBrandIconStyle`). Keep the pure reader safe when `window` is absent (SSR/test): return `mono`.

- [ ] **Step 4: Add a live-update test**

Append a test asserting that after `subscribeBrandIconStyle(listener)`, calling `writeBrandIconStyle("color")` dispatches exactly one event and invokes the listener; disposing stops further calls.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/desktop && bun test src/lib/brand-icon-style.test.ts`
Expected: PASS.

- [ ] **Step 6: Check the new file**

Run: `cd apps/desktop && bunx biome check src/lib/brand-icon-style.ts src/lib/brand-icon-style.test.ts`
Expected: no fixes, no errors.

---

### Task 2: Model provider icons follow the preference

**Files:**
- Modify: `apps/desktop/src/components/model-brand-icon.tsx:1-218`

**Interfaces:**
- Consumes: `useBrandIconStyle`, `readBrandIconStyle`, `BrandIconStyle` from `../lib/brand-icon-style` (Task 1).
- Produces: `ModelBrandIcon` keeps its existing signature `{ provider, modelId, size? }` and behaviour; internally it now resolves a `{ mono, color? }` pair.

- [ ] **Step 1: Add a failing render test**

Create `apps/desktop/src/components/model-brand-icon.test.tsx`. Assert that with no stored preference, `renderToStaticMarkup(<ModelBrandIcon provider="claude" modelId="claude-x" />)` contains `fill="currentColor"`; with `localStorage.setItem("musepi-gui-brand-icons", "color")`, the markup for the same call no longer contains `fill="currentColor"` and has a non-empty brand path.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/components/model-brand-icon.test.tsx`
Expected: FAIL — colour mode still renders Mono.

- [ ] **Step 3: Convert the mapping to pairs**

Change `type BrandComponent` to `interface BrandPair { mono: BrandComponent; color?: BrandComponent }` and `brand(component)` to `pair(component)` returning `{ mono: component as BrandComponent, color: (component as { Color?: unknown }).Color ? brand((component as {Color: unknown}).Color) : undefined }`. Keep every provider id and model-id fallback rule byte-identical; only the map's value type and `brand()` calls change. The 60 default deep imports stay as-is (each default component is Mono and carries `.Color` on the compound object where available).

- [ ] **Step 4: Render by preference**

In `ModelBrandIcon`, call `useBrandIconStyle()`; resolve `const p = brandFor(provider, modelId)`; choose `style === "color" ? (p.color ?? p.mono) : p.mono`. Keep the `oc-icons` fallback unchanged.

- [ ] **Step 5: Verify colour-absent fallback**

Add a test for `provider="opencode"` (confirmed no `.Color` in 6.16): in `color` mode the markup is still Mono. This pins the Review Focus fallback case.

- [ ] **Step 6: Run tests and checks**

Run: `cd apps/desktop && bun test src/components/model-brand-icon.test.tsx && bunx biome check src/components/model-brand-icon.tsx src/components/model-brand-icon.test.tsx`
Expected: PASS, no fixes.

---

### Task 3: Import picker icons follow the preference

**Files:**
- Modify: `apps/desktop/src/components/ImportSessionsSetup.tsx:1-105`

**Interfaces:**
- Consumes: `useBrandIconStyle` from `../lib/brand-icon-style`; `FOREIGN_SESSION_SOURCE_IDS` (existing import).
- Produces: `SourceGlyph({ source, size })` keeps its signature; `SOURCE_BRANDS` becomes pairs.

- [ ] **Step 1: Convert `SOURCE_BRANDS` to pairs and use the hook**

Keep one import per brand (default deep import, including `WorkBuddy`). For each entry build `{ mono: Brand, color: (Brand as { Color?: unknown }).Color ? brand(...) : undefined }`. Update the compile-time coverage check to check `keyof typeof SOURCE_BRANDS` exactly as today. In `SourceGlyph`, call `useBrandIconStyle()` and pick `pair.color ?? pair.mono`.

- [ ] **Step 2: Verify both modes render 10 marks**

Create `apps/desktop/src/components/import-source-glyph.test.tsx`. In each preference mode, render all 10 ids through a tiny wrapper that renders `<SourceGlyph>`; assert 10 SVG elements and no empty render. In `color` mode assert at least one brand carries a non-`currentColor` fill (WorkBuddy/CodeBuddy/Claude/Kimi have `.Color`); in `mono` mode assert all are `currentColor`.

- [ ] **Step 3: Run tests and checks**

Run: `cd apps/desktop && bun test src/components/import-source-glyph.test.tsx && bunx biome check src/components/ImportSessionsSetup.tsx src/components/import-source-glyph.test.tsx`
Expected: PASS, no fixes.

---

### Task 4: Appearance setting toggle + i18n

**Files:**
- Modify: `apps/desktop/src/components/settings-sections/appearance.tsx:120-140,538-575`
- Modify: `apps/desktop/src/components/SettingsView.tsx:277,513-527`
- Modify: `packages/client-core/src/i18n/en-US/settings.ts`
- Modify: `packages/client-core/src/i18n/zh-CN/settings.ts`

**Interfaces:**
- Consumes: `readBrandIconStyle`, `writeBrandIconStyle`, `useBrandIconStyle` from `../../lib/brand-icon-style`.
- Produces: `AppearanceSection` accepts a new optional prop `{ brandIconStyle: BrandIconStyle; onToggleBrandIconStyle: () => void }`.

- [ ] **Step 1: Add failing i18n keys**

Add `"settings.brandIconsColor": "Brand-coloured icons"` (en-US) and `"settings.brandIconsColor": "品牌图标使用彩色"` (zh-CN). Add a description key too: `"settings.brandIconsColorHint"` with copy explaining Mono follows the theme and Color uses each brand's colour.

- [ ] **Step 2: Run type check to verify it fails**

Run: `cd apps/desktop && bunx tsgo -p tsconfig.json --noEmit 2>&1 | grep -i brandIconsColor`
Expected: reports the new keys as unused/unknown until the component uses them.

- [ ] **Step 3: Wire state in SettingsView**

Mirror the `showAvatars` pattern: add `const [brandIconStyle, setBrandIconStyle] = useState(readBrandIconStyle)` and pass `brandIconStyle` plus an `onToggleBrandIconStyle` that calls `writeBrandIconStyle(next)` with `next = brandIconStyle === "mono" ? "color" : "mono"`.

- [ ] **Step 4: Add the toggle in AppearanceSection**

Add a `gui-settings-row` next to the avatars toggle: label/description from the new i18n keys and a `gui-toggle` with `aria-checked={brandIconStyle === "color"}`. The toggle calls the new callback.

- [ ] **Step 5: Verify live update across mounted icons**

Create `apps/desktop/src/components/brand-icon-toggle.test.tsx` that mounts a `ModelBrandIcon` and a `SourceGlyph` together, fires the toggle callback, and asserts both switch variant without remount. This pins the live-update Review Focus case.

- [ ] **Step 6: Run checks**

Run: `cd apps/desktop && bun test src/components/brand-icon-toggle.test.tsx && bunx biome check src/components/settings-sections/appearance.tsx src/components/SettingsView.tsx`
Expected: PASS, no fixes.

---

### Task 5: Final verification and docs

**Files:**
- Modify: `packages/coding-agent/CHANGELOG.musepi.md`
- Modify: `docs/gui-implementation.md`
- Modify: `docs/gui-implementation.zh-CN.md`

**Interfaces:**
- Consumes: completed behaviour from Tasks 1-4.

- [ ] **Step 1: Run all brand-related tests**

Run: `cd apps/desktop && bun test src/lib/brand-icon-style.test.ts src/components/model-brand-icon.test.tsx src/components/import-source-glyph.test.tsx src/components/brand-icon-toggle.test.tsx`

- [ ] **Step 2: Verify full type and boundary checks**

Run: `cd apps/desktop && bun run check:types`
Run: `cd packages/coding-agent && bun run check:types`
Expected: PASS. Ignore the known pre-existing errors in `ChatView.tsx` / `TurnMapCanvas.tsx` / `settings-sections/mcp.tsx` recorded in the spec.

- [ ] **Step 3: Document the preference**

Add one bilingual CHANGELOG entry under `[Unreleased]` describing the toggle, the default, and the fallback. Add one line to both `gui-implementation` docs next to the existing brand-icon sentence, naming the key, the two modes, the fallback, and that it affects both import and model icons.

- [ ] **Step 4: Confirm no temp files**

Run: `git status --short` and verify only intended files are changed/added. Remove any `.tmp-*` artefacts created during verification.
