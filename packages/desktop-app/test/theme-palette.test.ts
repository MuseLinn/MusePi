import "./happy-dom-shim"; // MUST be first: client-core defines HTMLElement subclasses at evaluation time.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ACCENT_PRESETS, DARK_THEME_PRESETS, LIGHT_THEME_PRESETS } from "@musepi/client-core";

/**
 * Theme/accent coherence contract (2026-11-08).
 *
 * Reported symptom: dark theme = 午夜蓝 + accent = 品牌黄 produced one screen
 * with two palettes. The session-info card and the transcript fades followed
 * the BLUE theme surface, while the sidebar / ChatView / right rail kept the
 * DEFAULT theme's warm-brown `--glass-card-bg` (a literal hue-60 fill).
 * The accent axis was also single/global, so a color theme could not supply
 * its own accent.
 *
 * These assertions pin the structural invariants that fix both halves:
 *  - every ui-theme supplies `--theme-hue` (a theme IS a full palette);
 *  - glass fills/edges and the transcript fade are DERIVED from the active
 *    theme's `--bg-*` / `--fg`, never from a literal palette hue;
 *  - no pre-rebrand blue accent literals survive in shared chrome CSS;
 *  - `data-accent="theme"` exists and is the fresh-install default.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const TOKENS = "packages/client-core/src/styles/tokens.css";
const GLASS = "packages/desktop-app/src/styles/gui-glass.css";
const CHAT = "packages/desktop-app/src/styles/gui-chat.css";
const WIDGETS = "packages/desktop-app/src/styles/gui-widgets.css";
const THEME_TS = "packages/client-core/src/lib/theme.ts";

/** Extract a declaration body from a selector block (single-level braces). */
function rule(css: string, selector: string): string | null {
	const at = css.indexOf(selector);
	if (at < 0) return null;
	const open = css.indexOf("{", at);
	const close = css.indexOf("}", open);
	return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

function declaration(css: string, name: string): string {
	const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
	return match?.[1]?.trim() ?? "";
}

describe("every color theme supplies its own accent", () => {
	test("each registered ui-theme preset has a --theme-hue rule", () => {
		const css = read(TOKENS);
		// Only the hue registry counts: the same selectors also appear in the
		// surface-token blocks above it, which deliberately carry no accent.
		const registry = css.slice(css.indexOf("Theme-native accent hue registry"));
		const ids = new Set([...LIGHT_THEME_PRESETS, ...DARK_THEME_PRESETS].map(p => p.id));
		expect(ids.size).toBeGreaterThanOrEqual(18);
		for (const id of ids) {
			const body = rule(registry, `[data-ui-theme="${id}"]`);
			expect(body, `missing accent hue for theme ${id}`).not.toBeNull();
			expect(body).toContain("--theme-hue:");
		}
	});

	test("the follow-theme accent resolves the whole --accent family from theme vars", () => {
		const css = read(TOKENS);
		const body = rule(css, '[data-accent="theme"]');
		expect(body, 'no [data-accent="theme"] block').not.toBeNull();
		for (const token of ["--accent", "--accent-fg", "--accent-muted", "--accent-hover", "--accent-bd"]) {
			expect(body, `${token} is not theme-derived`).toContain(token);
		}
		expect(declaration(body!, "--accent")).toBe("var(--theme-accent)");
		expect(body).toContain("var(--theme-hue)");
		// The system-light fallback needs its own specificity-matched copy.
		expect(css).toContain(':root:not([data-theme]):not([data-color-scheme])[data-accent="theme"]');
	});

	test("follow-theme is a first-class preset and the fresh-install default", () => {
		expect(ACCENT_PRESETS[0]?.id).toBe("theme");
		expect(ACCENT_PRESETS.map(p => p.id)).toEqual(["theme", "brand", "mono", "ocean", "jade"]);
		const ts = read(THEME_TS);
		expect(ts).toContain('"theme" | "brand" | "mono" | "ocean" | "jade" | "custom"');
		expect(ts).toContain(': "theme";');
		expect(ts).toContain('() => "theme" as AccentPreference');
	});

	test("follow-theme writes clean inline tokens and re-derives on theme flip", () => {
		const ts = read(THEME_TS);
		// Chromium serializes a var()-substituted oklch with empty comment
		// tokens; chroma-js rejects it. Concrete inline values keep JS readers
		// (pet palette, SketchPad, transition veil) parseable.
		expect(ts).toContain("function deriveThemeAccent(");
		expect(ts).toContain('if (accent === "theme")');
		expect(ts).toContain("function normalizeColorToken(");
		expect(ts).toContain("applyUiTheme();");
		const applyUi = rule(ts, "function applyUiTheme(): void {");
		expect(applyUi, "theme flips must re-materialize the inline accent").toContain("applyAccent()");
		const pet = read("packages/desktop-app/src/lib/companion-palette.ts");
		expect(pet.toLowerCase()).toContain("normalize");
		expect(pet).toContain("chroma-js cannot parse those");
	});
});

describe("the liquid-glass ladder follows the active theme, not the default palette", () => {
	test("card fills and edges are derived from --bg-* / --fg", () => {
		const css = read(TOKENS);
		const card = declaration(css, "--glass-card-bg");
		const hairline = declaration(css, "--glass-hairline");
		const hover = declaration(css, "--glass-hover-strong");
		const float = declaration(css, "--glass-float-bg");
		expect(card).toContain("var(--gui-card-surface)");
		expect(card).toContain("color-mix");
		expect(float).toContain("var(--bg-overlay)");
		for (const value of [hairline, hover]) expect(value).toContain("var(--fg)");
		// The regression: a literal hue-60 (default warm) card fill.
		for (const value of [card, float, hairline, hover]) {
			expect(value, `hardcoded default-palette fill: ${value}`).not.toMatch(/oklch\([^)]*\s60\s/);
		}
	});

	test("the transcript fade bands use the card's exact composite surface", () => {
		const css = read(TOKENS);
		expect(declaration(css, "--gui-card-surface-fade")).toContain("var(--gui-card-surface)");
		expect(declaration(css, "--gui-card-surface-fade")).toContain("var(--bg)");
		const chat = read(CHAT);
		const bands = chat.slice(chat.indexOf(".gui-chat-fade {"), chat.indexOf("/* ── Focus mode"));
		expect(bands).toContain("var(--gui-card-surface-fade)");
		expect(bands, "fade still paints the raw theme surface").not.toContain("var(--color-surface)");
	});

	test("the session-info card joins L1 so it shares the same surface", () => {
		const css = read(GLASS);
		const l1 = css.slice(css.indexOf("/* ── L1: cards"), css.indexOf("/* ── L2:"));
		expect(l1).toContain(".gui-session-info");
		expect(l1).toContain("var(--glass-card-bg)");
	});
});

describe("no pre-rebrand blue accent literals survive in shared chrome", () => {
	test("gui-widgets.css cron/calendar controls use the accent token", () => {
		const css = read(WIDGETS);
		expect(css).not.toContain("#7aa2ff");
		expect(css).not.toContain("#8bb3ff");
		expect(css).not.toContain("rgba(122, 162, 255");
		expect(css).toContain("color-mix(in oklab, var(--color-accent) 18%, transparent)");
	});

	test("both locales expose the follow-theme copy", () => {
		for (const locale of ["en-US", "zh-CN"]) {
			const src = read(`packages/client-core/src/i18n/${locale}/settings.ts`);
			expect(src).toContain('"settings.accentTheme":');
			expect(src).toContain('"settings.accentThemeHint":');
		}
	});
});
