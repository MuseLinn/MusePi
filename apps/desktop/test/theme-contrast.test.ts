import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import chroma from "chroma-js";

const TOKENS = path.resolve(import.meta.dir, "../../../packages/client-core/src/styles/tokens.css");
const css = fs.readFileSync(TOKENS, "utf8");

type Triple = readonly [number, number, number];
type Palette = Record<"bg" | "bg-raised" | "bg-inset" | "bg-overlay" | "fg" | "fg-muted" | "fg-faint", Triple>;

const KEYS: Record<string, keyof Palette> = {
	bg: "bg",
	"bg-raised": "bg-raised",
	"bg-inset": "bg-inset",
	"bg-overlay": "bg-overlay",
	fg: "fg",
	"fg-muted": "fg-muted",
	"fg-faint": "fg-faint",
};

function parseBlock(body: string): Partial<Palette> {
	const out: Partial<Palette> = {};
	const re =
		/--(bg|bg-raised|bg-inset|bg-overlay|fg|fg-muted|fg-faint):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g;
	for (const m of body.matchAll(re)) {
		const key = KEYS[m[1]!];
		if (key) out[key] = [Number(m[2]), Number(m[3]), Number(m[4])];
	}
	return out;
}

function defaults(): Palette {
	return {
		bg: [0.145, 0.007, 60],
		"bg-raised": [0.19, 0.01, 60],
		"bg-inset": [0.115, 0.006, 60],
		"bg-overlay": [0.228, 0.011, 60],
		fg: [0.93, 0.008, 60],
		"fg-muted": [0.72, 0.01, 60],
		"fg-faint": [0.66, 0.01, 60],
	};
}

/** The default dark preset has no `[data-ui-theme]` block — it IS `:root`. */
function rootPalette(): Palette {
	const open = css.indexOf(":root {");
	const close = css.indexOf("}", open);
	return { ...defaults(), ...parseBlock(css.slice(open, close)) };
}

/** All dark preset blocks from tokens.css, keyed by preset id. */
function darkPresets(): Map<string, Palette> {
	const out = new Map<string, Palette>();
	out.set("default", rootPalette());
	const re = /\[data-theme="dark"\]\[data-ui-theme="([a-z]+)"\]\s*\{([^}]*)\}/g;
	for (const m of css.matchAll(re)) {
		out.set(m[1]!, { ...rootPalette(), ...parseBlock(m[2]!) });
	}
	return out;
}

const color = (t: Triple) => chroma.oklch(t[0], t[1], t[2]);
const surfaces = (p: Palette) => [p.bg, p["bg-raised"], p["bg-inset"], p["bg-overlay"]] as const;

/** Signature chroma + hue per text token, from the design's solved table. */
const SIGNATURES: Record<string, Record<"fg" | "fg-muted" | "fg-faint", readonly [number, number]>> = {
	default: { fg: [0.018, 88], "fg-muted": [0.017, 86], "fg-faint": [0.013, 86] },
	midnight: { fg: [0.014, 265], "fg-muted": [0.014, 265], "fg-faint": [0.013, 265] },
	graphite: { fg: [0.006, 90], "fg-muted": [0.008, 90], "fg-faint": [0.008, 90] },
	openchamber: { fg: [0.0158, 90.3], "fg-muted": [0.0154, 88.7], "fg-faint": [0.0091, 80.7] },
	catppuccin: { fg: [0.0426, 272.3], "fg-muted": [0.0315, 272.9], "fg-faint": [0.0307, 278.1] },
	nord: { fg: [0.0104, 261.8], "fg-muted": [0.0195, 264.4], "fg-faint": [0.0207, 267.6] },
	tokyonight: { fg: [0.0611, 274.8], "fg-muted": [0.0529, 274.8], "fg-faint": [0.0366, 276.7] },
	anthro: { fg: [0.0041, 91.4], "fg-muted": [0.0071, 106.6], "fg-faint": [0.0062, 106.6] },
	aura: { fg: [0.0029, 308.4], "fg-muted": [0.0097, 17.4], "fg-faint": [0.0082, 340.7] },
	ayu: { fg: [0.0093, 258.3], "fg-muted": [0.0148, 251.6], "fg-faint": [0.0142, 252.2] },
	dracula: { fg: [0.0079, 106.5], "fg-muted": [0.0455, 281.9], "fg-faint": [0.0334, 280.4] },
	gruvbox: { fg: [0.0566, 89.2], "fg-muted": [0.0287, 76.6], "fg-faint": [0.0149, 75.2] },
	kanagawa: { fg: [0.0391, 99.1], "fg-muted": [0.0088, 106.6], "fg-faint": [0.0016, 286.3] },
	monokai: { fg: [0.0079, 106.5], "fg-muted": [0.0044, 106.5], "fg-faint": [0.008, 115.9] },
	solarized: { fg: [0.0159, 196.8], "fg-muted": [0.0063, 211], "fg-faint": [0.0225, 213.7] },
	vesper: { fg: [0.0033, 17.2], "fg-muted": [0, 89.9], "fg-faint": [0, 89.9] },
};

describe("dark theme text contrast", () => {
	test("every dark preset clears WCAG AA on all four surfaces", () => {
		const presets = darkPresets();
		expect(presets.size).toBeGreaterThanOrEqual(15);
		for (const [id, p] of presets) {
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
		for (const [id, p] of darkPresets()) {
			const row = SIGNATURES[id];
			expect(row, `${id}: missing signature in test table`).toBeDefined();
			if (!row) continue;
			for (const key of ["fg", "fg-muted", "fg-faint"] as const) {
				expect(p[key][1], `${id}: ${key} chroma`).toBeCloseTo(row[key][0], 4);
				expect(p[key][2], `${id}: ${key} hue`).toBeCloseTo(row[key][1], 1);
			}
		}
	});

	test("default dark keeps the warm-neutral surface and cream text", () => {
		const p = rootPalette();
		const expected: Palette = {
			bg: [0.21, 0.0036, 104],
			"bg-raised": [0.245, 0.004, 95],
			"bg-inset": [0.185, 0.0035, 104],
			"bg-overlay": [0.275, 0.005, 95],
			fg: [0.935, 0.018, 88],
			"fg-muted": [0.795, 0.017, 86],
			"fg-faint": [0.705, 0.013, 86],
		};
		for (const key of Object.keys(expected) as (keyof Palette)[]) {
			for (let i = 0; i < 3; i++) {
				expect(p[key][i], `default.${key}[${i}]`).toBeCloseTo(expected[key][i], 4);
			}
		}
	});
});
