# Dark Theme Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every dark theme preset reach WCAG AA text contrast (≥ 4.5:1) on all four surfaces, and replace the default dark palette with candidate F (Anthropic-deepened warm surfaces + Gruvbox cream text), leaving light themes untouched.

**Architecture:** All color values live in `packages/client-core/src/styles/tokens.css` — the only file allowed to hold raw colors. The fix is pure CSS token edits plus an offline contrast regression test that parses that CSS with `chroma-js` (already a dependency of `apps/desktop`). No runtime JS, no component changes.

**Tech Stack:** CSS custom properties with OKLCH, Bun tests (`bun:test`), `chroma-js` ^3.2.0 for WCAG contrast, `biome` for formatting.

**Spec:** `docs/superpowers/specs/2026-11-18-dark-theme-palette-design.md`

## Global Constraints

- `tokens.css` is the ONLY file allowed to contain raw color values (AGENTS.md, confirmed by file header).
- Light theme tokens MUST NOT change — user explicitly likes current light theme.
- Brand gold `#d9a441` = `oklch(0.7507 0.1295 79.85)` MUST NOT change (shared by logo gradient, TUI theme, HTML export).
- Use `bun check`, never `tsc` or `npx tsc`. Package `package.json` scripts are the command source of truth.
- Commit subjects when a commit is explicitly requested: Conventional Commits, user-visible summary ≤ 72 chars. (No commit requested here — do not commit.)
- Comment provenance: do NOT name upstream projects in new source comments (`scripts/check-comment-provenance.ts` gates this).
- Changelog: title states user-visible change in user vocabulary, not engineering decision record (`scripts/check-changelog-voice.ts`). Paired EN translation inline under the Chinese bullet.
- User-facing changes update owning docs, both locales of paired docs, and `CHANGELOG.musepi.md` `[Unreleased]`.
- Never edit `packages/catalog/src/models.json` — not relevant here, listed for completeness.

## Review Focus

1. **Accent contrast collapse** — accent is theme-derived at runtime; changing surfaces must not drop `--accent-fg` on accent fills below 4.5:1. Pinned by Task 1 test (asserts accent/background and accent-fg/accent ≥ 4.5:1 for the new default).
2. **Light theme regression** — an over-broad edit could leak dark values into light blocks. Pinned by Task 2 test (asserts light default token values unchanged) + Task 4 full test run.
3. **Preset hue identity loss** — solver must preserve each preset's hue/chroma, only change L. Pinned by Task 1 test (asserts hue/chroma of every preset text token matches the spec table).
4. **`solarized` fg inversion** — current `fg` L=0.6979 is darker than `muted` L=0.70 (existing typo). Pinned by Task 1 test (asserts `fg > muted > faint` monotonic for every dark preset).
5. **Terminal palette drift** — out of scope, but a reader may expect the xterm palette to follow. Pinned by Task 2 test documenting the intentional divergence + spec "Known Remaining" section.

---

### Task 1: Contrast regression test (failing)

**Files:**
- Create: `apps/desktop/test/theme-contrast.test.ts`

**Interfaces:**
- Consumes: `packages/client-core/src/styles/tokens.css` (parsed as text, parsed with regex).
- Produces: exported-free test module; failure messages name the preset, token, surface and ratio so implementers can fix directly.

- [ ] **Step 1: Create the failing contrast test**

```ts
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import chroma from "chroma-js";

const TOKENS = path.resolve(import.meta.dir, "../../../packages/client-core/src/styles/tokens.css");
const css = fs.readFileSync(TOKENS, "utf8");

type Triple = readonly [number, number, number];
type Palette = Record<"bg" | "bg-raised" | "bg-inset" | "bg-overlay" | "fg" | "fg-muted" | "fg-faint", Triple>;

const KEYS: Record<string, keyof Palette> = {
	bg: "bg", "bg-raised": "bg-raised", "bg-inset": "bg-inset", "bg-overlay": "bg-overlay",
	fg: "fg", "fg-muted": "fg-muted", "fg-faint": "fg-faint",
};

function parseBlock(body: string): Partial<Palette> {
	const out: Partial<Palette> = {};
	const re = /--(bg|bg-raised|bg-inset|bg-overlay|fg|fg-muted|fg-faint):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g;
	for (const m of body.matchAll(re)) {
		const key = KEYS[m[1]!];
		if (key) out[key] = [Number(m[2]), Number(m[3]), Number(m[4])];
	}
	return out;
}

/** All dark preset blocks from tokens.css, keyed by preset id. */
function darkPresets(): Map<string, Palette> {
	const out = new Map<string, Palette>();
	const re = /\[data-theme="dark"\]\[data-ui-theme="([a-z]+)"\]\s*\{([^}]*)\}/g;
	for (const m of css.matchAll(re)) {
		out.set(m[1]!, { ...defaults(), ...parseBlock(m[2]!) });
	}
	return out;
}

function defaults(): Palette {
	return {
		bg: [0.145, 0.007, 60], "bg-raised": [0.19, 0.01, 60],
		"bg-inset": [0.115, 0.006, 60], "bg-overlay": [0.228, 0.011, 60],
		fg: [0.93, 0.008, 60], "fg-muted": [0.72, 0.01, 60], "fg-faint": [0.66, 0.01, 60],
	};
}

const color = (t: Triple) => chroma.oklch(t[0], t[1], t[2]);
const surfaces = (p: Palette) => [p.bg, p["bg-raised"], p["bg-inset"], p["bg-overlay"]] as const;
```

Then add the assertions from the spec:

```ts
describe("dark theme text contrast", () => {
	test("every dark preset clears WCAG AA on all four surfaces", () => {
		for (const [id, p] of darkPresets()) {
			for (const textKey of ["fg", "fg-muted", "fg-faint"] as const) {
				for (const surface of surfaces(p)) {
					const ratio = chroma.contrast(color(p[textKey]), color(surface));
					expect(ratio, `${id}: ${textKey} on ${surface.join("/")}`).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});

	test("text tokens stay strictly ordered fg > muted > faint", () => {
		for (const [id, p] of darkPresets()) {
			expect(p.fg[0], `${id}: fg L`).toBeGreaterThan(p["fg-muted"][0]);
			expect(p["fg-muted"][0], `${id}: muted L`).toBeGreaterThan(p["fg-faint"][0]);
		}
	});

	test("each preset keeps its signature hue and chroma", () => {
		const expected: Record<string, Record<"fg" | "fg-muted" | "fg-faint", readonly [number, number]>> = {
			// fill from spec §Key changes 1 table: chroma, hue per token
		};
		for (const [id, p] of darkPresets()) {
			const row = expected[id];
			if (!row) continue;
			for (const key of ["fg", "fg-muted", "fg-faint"] as const) {
				expect(p[key][1]).toBeCloseTo(row[key][0], 4);
				expect(p[key][2]).toBeCloseTo(row[key][1], 1);
			}
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && bun test test/theme-contrast.test.ts`
Expected: FAIL — several presets show ratios below 4.5 (gruvbox faint/overlay ≈ 2.59, nord ≈ 2.67, etc.).

---

### Task 2: Apply the new dark palettes

**Files:**
- Modify: `packages/client-core/src/styles/tokens.css` (`:root` block at top; 15 dark preset blocks from `[data-theme="dark"][data-ui-theme="midnight"]` through `[data-theme="dark"][data-ui-theme="vesper"]`)

**Interfaces:**
- Consumes: spec §Key changes 1 (preset value table) and §Key changes 3 (candidate F).
- Produces: CSS tokens with new values; Task 1 test now passes.

- [ ] **Step 1: Replace the default dark palette (`:root`) with candidate F**

Set these exact values in the `:root` block (keep the surrounding comments, update the date/history note to say 2026-11-18 and describe the Anthropic-neutral + Gruvbox-cream blend without naming source projects in a provenance sense — refer to "暖中性底 + 奶油暖白" as the design intent):

```css
--bg: oklch(0.210 0.0036 104);
--bg-raised: oklch(0.245 0.0040 95);
--bg-inset: oklch(0.185 0.0035 104);
--bg-overlay: oklch(0.275 0.0050 95);
--fg: oklch(0.935 0.018 88);
--fg-muted: oklch(0.795 0.017 86);
--fg-faint: oklch(0.705 0.013 86);
```

Leave `--accent`, `--accent-fg`, `--brand-mark-gradient`, and every non-color token untouched.

- [ ] **Step 2: Write the solved values into each of the 15 dark preset blocks**

For every `[data-theme="dark"][data-ui-theme="…"]` block, replace `--bg-overlay`, `--fg`, `--fg-muted`, `--fg-faint` only. Use the spec §Key changes 1 table verbatim (column "overlay L (new)" and the three OKLCH triples). Do NOT touch `--bg`, `--bg-raised`, `--bg-inset`, `--border`, or `--border-strong` — those are unchanged per spec.

- [ ] **Step 3: Update the stale readability comment**

Replace the comment above the preset section that currently says dark presets have `--fg-muted: 0.70 / --fg-faint: 0.60` floor with one that states text lightness is derived per-preset from that preset's surface lightness. Do not name upstream projects.

- [ ] **Step 4: Run the contrast test**

Run: `cd apps/desktop && bun test test/theme-contrast.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Run the existing theme contract test**

Run: `cd apps/desktop && bun test test/theme-palette.test.ts`
Expected: PASS — should be unaffected; verifies theme-axis structure intact.

---

### Task 3: Visual verification with real tokens

**Files:**
- Temporary (gitignored): `.agent-tmp/dark-theme-compare.html` — already exists from design phase; no permanent file changes.

**Interfaces:**
- Consumes: token values from Task 2.
- Produces: screenshot evidence in chat (no committed file).

- [ ] **Step 1: Update the comparison page to read final token values**

In `.agent-tmp/dark-theme-compare.html`, update the `THEMES` array's default dark entry to the final `:root` values from Task 2 Step 1. Keep the "现状 · Gruvbox / Anthropic" entries as baseline comparisons.

- [ ] **Step 2: Render and screenshot**

Open the page in the desktop browser, screenshot fullPage at 1560×900 (or wider). Visually confirm:
- Default dark candidate F: text is clearly readable, warm cream hue, not too gray, not too black.
- Gruvbox/Anthropic preset panels: the "faint" text on the overlay surface is now legible (was the worst combination).
- Brand gold accent button retains contrast.

- [ ] **Step 3: Real desktop screenshot**

Launch the desktop app in a throwaway profile with dark theme selected. Navigate to settings → appearance, then the main chat view. Capture screenshots and confirm no regressions in the composed UI (shadows, glass, focus rings). If the desktop app cannot be launched in this environment, report this as an unverified item — do not claim visual verification.

---

### Task 4: Documentation and changelog

**Files:**
- Modify: `docs/gui-design.md` (add dark-theme contrast contract note near the "Three orthogonal axes" paragraph ~line 123)
- Modify: `docs/gui-design.zh-CN.md` (same location ~line 117, Chinese)
- Modify: `packages/coding-agent/CHANGELOG.musepi.md` (top of `[Unreleased]`)

**Interfaces:**
- Consumes: spec §Verification and the measured table.
- Produces: docs and changelog consistent with shipped behavior.

- [ ] **Step 1: Add the contrast contract to both design docs**

In each file, add a short bullet (one paragraph, not a full table) stating:
- dark preset text brightness is derived from each preset's own surface lightness, not a shared floor;
- the regression test path `apps/desktop/test/theme-contrast.test.ts` pins ≥ 4.5:1 across four surfaces;
- default dark now uses a warm-neutral deep surface with cream text; light theme unchanged.

- [ ] **Step 2: Add the changelog entry**

Insert at the top of `[Unreleased]`:

```md
- **深色主题的次级文字不再糊成一片**：深色模式下每个配色主题的正文、次级文字和弱化文字，现在都按该主题自己的底色深浅单独取值，时间、描述、代码块注释在浮层菜单里也保持清晰。默认深色换成更深的暖灰底配奶油白文字，浅色主题保持原样。
  EN: Secondary text in dark themes no longer dissolves into the background. Body, secondary and faint text are now tuned against each theme's own surface brightness, so timestamps, descriptions and code comments stay legible even on floating menus. The default dark theme uses a deeper warm-neutral surface with cream text; light themes are unchanged.
```

Verify the title passes `check-changelog-voice.ts` (it states a user-visible change, no provenance verbs).

- [ ] **Step 3: Run doc checks**

Run: `bun run check:docs && bun scripts/check-changelog-voice.ts`
Expected: both PASS.

---

### Task 5: Full verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: all changes from Tasks 1–4.

- [ ] **Step 1: Focused tests**

Run: `cd apps/desktop && bun test test/theme-contrast.test.ts test/theme-palette.test.ts test/ui-theme-skins.test.ts test/ui-theme.test.tsx test/terminal-xterm-theme.test.ts`
Expected: all PASS.

- [ ] **Step 2: Repository checks**

Run: `bun run check:ts`
Expected: PASS (includes biome, docs, package boundaries, CSS structure checks).

- [ ] **Step 3: Report**

Summarize in the final message: changed files, new contrast numbers, verification commands and results, and any unverified native/platform behavior. Do not commit (user has not requested a commit).

---

## Self-Review Notes

- **Spec coverage:** Every spec section maps to a task — root cause table → Task 1 (test) + Task 2 (fix); Approaches 1 + 3 → Task 2; candidate F → Task 2 Step 1; regression test → Task 1; docs + changelog → Task 4; verification → Tasks 3 + 5; Known Remaining explicitly excluded (no task).
- **Review Focus:** all 5 items have tests at Task 1 or Task 2; visual item in Task 3.
- **Type consistency:** `Palette` type and `darkPresets()` helper defined in Task 1, used only there; no cross-task interface surfaces beyond CSS values.
- **Proportion:** plan length is comparable to spec; code blocks only where exact test shape or exact token values matter.
