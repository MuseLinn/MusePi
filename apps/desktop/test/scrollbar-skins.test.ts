import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
	applyScrollbarSkin,
	BUILTIN_SCROLLBAR_SKINS,
	DEFAULT_SCROLLBAR_SKIN_ID,
	getScrollbarSkin,
	saveImportedSkin,
	setContributedScrollbarSkins,
} from "../src/plugins/ui-theme/skins";

/**
 * The scrollbar is native: `base.css` paints the engine-drawn bar and
 * `skins.css` only supplies recipes. These assertions pin the CSS split (the
 * two rendering paths must stay mutually exclusive, and no global hide may come
 * back) plus the DOM side of applying a skin.
 */

const REPO = path.resolve(import.meta.dir, "../../..");
const BASE_CSS = readFileSync(path.join(REPO, "packages/client-core/src/styles/base.css"), "utf8");
const SKIN_CSS = readFileSync(path.resolve(import.meta.dir, "../src/plugins/ui-theme/skins.css"), "utf8");

/** Comments are stripped before scanning so prose cannot satisfy a rule. */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, " ");

/** The brace-balanced block that starts at `start`. */
function blockAt(css: string, start: number): string {
	const open = css.indexOf("{", start);
	if (open < 0) return "";
	let depth = 0;
	for (let i = open; i < css.length; i += 1) {
		if (css[i] === "{") depth += 1;
		else if (css[i] === "}") {
			depth -= 1;
			if (depth === 0) return css.slice(start, i + 1);
		}
	}
	return css.slice(start);
}

const BASE = withoutComments(BASE_CSS);
const SKINS = withoutComments(SKIN_CSS);
const GATE = "@supports not selector(::-webkit-scrollbar)";
const gateStart = BASE.indexOf(GATE);
const gate = gateStart < 0 ? "" : blockAt(BASE, gateStart);
const gateEnd = gateStart + gate.length;
/** The gate's own selector mentions the pseudo-element; only its body is off-limits. */
const gateConditionEnd = gateStart < 0 ? -1 : gateStart + gate.indexOf("{");

const offsets = (css: string, pattern: RegExp): number[] => [...css.matchAll(pattern)].map(match => match.index ?? 0);

describe("native scrollbar stylesheet contract", () => {
	test("declares both rendering paths and gates the standard properties", () => {
		expect(gateStart).toBeGreaterThanOrEqual(0);
		// A non-`auto` scrollbar-width/-color makes Chromium drop every
		// ::-webkit-scrollbar rule for the element, hover thumb included.
		for (const property of ["scrollbar-width", "scrollbar-color"]) {
			const found = offsets(BASE, new RegExp(String.raw`(^|[;{\s])${property}\s*:`, "g"));
			expect(found.length, property).toBeGreaterThan(0);
			for (const offset of found) {
				expect(offset > gateStart && offset < gateEnd, `${property} outside ${GATE}`).toBe(true);
			}
		}
	});

	test("keeps the WebKit rules outside the gate", () => {
		const found = offsets(BASE, /::-webkit-scrollbar\b/g);
		expect(found.length).toBeGreaterThan(0);
		for (const offset of found) {
			// The gate's own condition names the pseudo-element; its body must not.
			if (offset > gateStart && offset < gateConditionEnd) continue;
			expect(offset > gateStart && offset < gateEnd, "::-webkit-scrollbar inside the gate").toBe(false);
		}
	});

	test("never hides the native bar globally", () => {
		// The old overlay model required `* { scrollbar-width: none !important }`;
		// a single global hide would silently disable every recipe below.
		expect(BASE).not.toMatch(/scrollbar-width\s*:\s*none\s*!important/);
		expect(BASE).not.toMatch(/\*\s*::-webkit-scrollbar\s*\{[^}]*display\s*:\s*none/);
	});

	test("routes the thumb through the rebindable tint", () => {
		expect(BASE).toContain("background-color: var(--mp-scrollbar-tint)");
		expect(BASE).toContain("background-color: var(--mp-scrollbar-tint-hover)");
	});
});

describe("skin recipes", () => {
	const decorated = BUILTIN_SCROLLBAR_SKINS.filter(skin => skin.id !== DEFAULT_SCROLLBAR_SKIN_ID);

	test("every built-in skin other than the base has a recipe block", () => {
		expect(decorated.length).toBeGreaterThan(0);
		for (const skin of decorated) {
			expect(SKIN_CSS, skin.id).toContain(`html[data-scrollbar-skin="${skin.id}"]`);
		}
	});

	test("every skin variable a recipe defines is consumed by base.css", () => {
		const defined = new Set([...SKINS.matchAll(/(--mp-scrollbar-skin-[\w-]+)\s*:/g)].map(match => match[1]!));
		expect(defined.size).toBeGreaterThan(0);
		for (const name of defined) expect(BASE, name).toContain(name);
	});

	test("a decorated skin sets a width the base can resolve", () => {
		for (const skin of decorated) {
			const start = SKINS.indexOf(`html[data-scrollbar-skin="${skin.id}"]`);
			expect(start, skin.id).toBeGreaterThanOrEqual(0);
			const palette = blockAt(SKINS, start);
			expect(palette, skin.id).toContain("--mp-scrollbar-skin-width");
		}
	});
});

describe("applying a skin", () => {
	const root = document.documentElement;

	afterEach(() => {
		localStorage.clear();
		setContributedScrollbarSkins([]);
		root.removeAttribute("data-scrollbar-skin");
		root.removeAttribute("style");
	});

	test("a built-in skin only selects its recipe attribute", () => {
		applyScrollbarSkin("builtin-snake");
		expect(root.dataset.scrollbarSkin).toBe("builtin-snake");
		expect(root.style.getPropertyValue("--mp-scrollbar-skin-width")).toBe("");
	});

	test("an imported skin writes its palette and width inline", () => {
		saveImportedSkin({
			id: "custom",
			displayName: "Custom",
			base: "gummy",
			colors: { accent: "oklch(0.7 0.2 30)", track: "transparent", eaten: "transparent" },
			size: 10,
			pacGlyph: null,
		});
		applyScrollbarSkin("custom");
		expect(root.dataset.scrollbarSkin).toBe("custom");
		expect(root.style.getPropertyValue("--mp-scrollbar-skin-bg-l1")).toBe("oklch(0.7 0.2 30)");
		expect(root.style.getPropertyValue("--mp-scrollbar-skin-width")).toBe("10px");
	});

	test("switching back to a built-in clears the imported palette", () => {
		saveImportedSkin({
			id: "custom",
			displayName: "Custom",
			base: "gummy",
			colors: { accent: "#123456", track: "transparent", eaten: "transparent" },
			size: 10,
			pacGlyph: null,
		});
		applyScrollbarSkin("custom");
		applyScrollbarSkin("classic");
		expect(root.dataset.scrollbarSkin).toBe("classic");
		expect(root.style.getPropertyValue("--mp-scrollbar-skin-bg-l1")).toBe("");
		expect(root.style.getPropertyValue("--mp-scrollbar-skin-width")).toBe("");
	});

	test("the retired pac-man id falls back to the classic capsule", () => {
		expect(getScrollbarSkin("builtin-pacman").id).toBe("classic");
		applyScrollbarSkin("builtin-pacman");
		expect(root.dataset.scrollbarSkin).toBe("classic");
	});

	test("an imported width is clamped to the native range", () => {
		saveImportedSkin({
			id: "wide",
			displayName: "Wide",
			base: "gummy",
			colors: { accent: "#123456", track: "transparent", eaten: "transparent" },
			size: 24,
			pacGlyph: null,
		});
		applyScrollbarSkin("wide");
		expect(root.style.getPropertyValue("--mp-scrollbar-skin-width")).toBe("16px");
	});
});
