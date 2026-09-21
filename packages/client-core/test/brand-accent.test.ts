import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Brand-accent contract: gold, everywhere, with no stragglers.
 *
 * The 0.4.31 rebrand moved the default accent from emerald `#34d399` to the
 * π brand gold `#d9a441` across the GUI tokens, TUI theme, HTML export
 * palette, stats dashboard and lightbox. Two green stragglers survived it
 * because they were *literals*, not references, so the sweep's greps for
 * shared values walked straight past them:
 *
 *   1. `.gui-obo-accent-swatch[data-accent="brand"]` in gui-misc.css held
 *      `oklch(0.773 0.1538 163)` = emerald #34d399 — the onboarding accent
 *      picker's brand swatch rendered GREEN next to a gold-filled CTA.
 *   2. `theme.ts`'s `DEFAULT_CUSTOM_ACCENT`, which is what the custom-accent
 *      card paints before the user picks anything.
 *
 * A pixel-level assertion is not reachable from bun (no CSS engine), so this
 * locks the two things that actually broke: the swatch literal's VALUE, and
 * the structural rule that keeps `--accent` out of a `data-accent`-scoped
 * element (see below — that is the second, subtler bug the same rule caught).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/** #d9a441 in OKLCH, and the emerald it must NOT be. */
const GOLD_HEX = "#d9a441";
const EMERALD_HEX = "#34d399";
const EMERALD_OKLCH = "oklch(0.773 0.1538 163)";

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Strip `/* … *\/` and `// …` so rationale comments that NAME the old value
 *  (every fix here documents what it replaced) don't trip the assertions. */
const stripComments = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map(l => l.replace(/(^|\s)\/\/.*$/, ""))
		.join("\n");

describe("brand gold is the accent in every palette that hardcodes it", () => {
	test("the onboarding accent swatch paints gold, not emerald", () => {
		const css = read("packages/desktop-app/src/styles/gui-misc.css");
		const brand = /\.gui-obo-accent-swatch\[data-accent="brand"\]\s*\{[^}]*\}/.exec(css);
		expect(brand, "brand swatch rule disappeared").not.toBeNull();
		const body = brand![0];
		expect(body.toLowerCase()).toContain(GOLD_HEX);
		// The exact regression: the pre-rebrand emerald literal, as OKLCH.
		expect(body).not.toContain(EMERALD_OKLCH);
		expect(body.toLowerCase()).not.toContain(EMERALD_HEX);
	});

	test("the default custom accent is the brand gold", () => {
		const ts = read("packages/client-core/src/lib/theme.ts");
		const decl = /const DEFAULT_CUSTOM_ACCENT\s*=\s*"([^"]+)"/.exec(ts);
		expect(decl, "DEFAULT_CUSTOM_ACCENT disappeared").not.toBeNull();
		expect(decl![1]!.toLowerCase()).toBe(GOLD_HEX);
	});

	test("the GUI token block still round-trips to #d9a441", () => {
		// tokens.css documents that these oklch numbers ARE #d9a441 and warns
		// that retuning them by eye re-splits logo-vs-accent. Pin the literal.
		const css = read("packages/client-core/src/styles/tokens.css");
		expect(css).toContain("--accent: oklch(0.7507 0.1295 79.85)");
		expect(css).toContain("--brand-mark-gradient: linear-gradient(135deg, #d9a441 0%, #b8862f 50%, #966400 100%)");
	});

	test("the pet window's standalone accent token is gold, not emerald", () => {
		// Third instance of the same miss: pet-window.css is loaded ONLY by
		// the floating pet window and never loads tokens.css, so it carries
		// its own literal — which stayed the pre-rebrand emerald and painted
		// the working dot / send button / dock glow green.
		const css = stripComments(read("packages/desktop-app/src/styles/pet-window.css"));
		expect(css).toContain("--color-accent: oklch(0.7507 0.1295 79.85)");
		expect(css).not.toContain(EMERALD_OKLCH);
		// On-accent ink must exist and be the dark one — `#fff` on gold is 1.9:1.
		expect(css).toContain("--color-accent-fg: oklch(0.26 0.06 80)");
	});

	test("no source palette still hardcodes the pre-rebrand emerald as an accent", () => {
		// Green is legitimate elsewhere (semantic success, the pet mascot,
		// color tags) — this only forbids it where it is bound to an
		// *accent* token, which is exactly the straggler shape.
		const suspects = [
			"packages/desktop-app/src/styles/pet-window.css",
			"packages/desktop-app/src/styles/gui-misc.css",
			"packages/client-core/src/styles/tokens.css",
			"packages/stats/src/client/styles.css",
			"packages/coding-agent/src/export/html/web-palette.ts",
		];
		for (const rel of suspects) {
			const src = stripComments(read(rel));
			for (const line of src.split("\n")) {
				if (!/accent/i.test(line)) continue;
				expect(line.toLowerCase(), `${rel}: accent bound to emerald -> ${line.trim()}`).not.toContain(EMERALD_HEX);
				expect(line, `${rel}: accent bound to emerald oklch -> ${line.trim()}`).not.toContain(EMERALD_OKLCH);
			}
		}
	});
});

describe("accent swatches never self-influence through `--accent`", () => {
	/**
	 * The subtler half of the same bug. `--accent` is `data-accent`-scoped in
	 * tokens.css, so an element that carries `data-accent="ocean"` and also
	 * *reads* `var(--accent)` resolves the OCEAN block sitting on itself — the
	 * swatch for preset X painted preset X's own color and every non-active
	 * swatch painted the active preset's color. Neutral `currentColor` (the
	 * card's own text color) is the only paint that cannot self-influence.
	 */
	test("the base swatch rule uses currentColor, not var(--accent)", () => {
		const css = read("packages/desktop-app/src/styles/gui-misc.css");
		const base = /\.gui-obo-accent-swatch\s*\{[^}]*\}/.exec(css);
		expect(base, "base swatch rule disappeared").not.toBeNull();
		expect(base![0]).toContain("background: currentColor");
		// Strip the comment block before checking — the rationale above the
		// rule legitimately names `--accent`.
		const body = base![0].replace(/\/\*[\s\S]*?\*\//g, "");
		expect(body).not.toContain("var(--accent)");
	});

	test("every preset swatch keyed by data-accent is a literal, never var(--accent)", () => {
		const css = read("packages/desktop-app/src/styles/gui-misc.css");
		const rules = css.match(/\.gui-obo-accent-swatch\[data-accent="[^"]+"\]\s*\{[^}]*\}/g) ?? [];
		expect(rules.length).toBeGreaterThanOrEqual(4); // mono / ocean / jade / brand
		for (const rule of rules) {
			expect(rule, `self-influencing swatch: ${rule}`).not.toContain("var(--accent)");
		}
	});
});
