import { describe, expect, test } from "bun:test";
import { deriveCustomAccent } from "../src/lib/theme.js";

/**
 * Contract for the custom-accent derivation (设计板「色彩管线」):
 *
 * The previous sRGB derivation produced accent-fg contrasts as low as 2.2:1
 * for the brand gold itself and 1.2:1 for pale accents — both unreadable.
 * The OKLCH derivation (chroma-js) must keep every tested accent's
 * foreground at or above WCAG AA for normal text (4.5:1), keep hover moving
 * away from the resting state along the lightness axis, and keep muted/bd
 * as alpha variants of the accent.
 */
const ACCENTS = [
	["brand gold", "#d9a441"],
	["hot magenta", "#ff0080"],
	["pale sand", "#f0e6d2"],
	["dark blood", "#7a1f1f"],
	["navy near-black", "#16162e"],
	["hot pink", "#ff69b4"],
	["pure white", "#ffffff"],
	["pure black", "#000000"],
] as const;

const W = (hex: string): number => {
	const n = parseInt(hex.slice(1), 16);
	const ch = (v: number): number => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};

const contrast = (a: string, b: string): number => {
	const [l1, l2] = [W(a), W(b)].sort((x, y) => y - x);
	return (l1 + 0.05) / (l2 + 0.05);
};

describe("deriveCustomAccent", () => {
	for (const scheme of ["dark", "light"] as const) {
		test(`[${scheme}] accent-fg stays ≥ 4.5:1 against the accent for every tested accent`, () => {
			for (const [label, hex] of ACCENTS) {
				const tokens = deriveCustomAccent(hex, scheme);
				const fg = (tokens["--accent-fg"] ?? "").trim();
				const ratio = contrast(fg, hex);
				expect(`${label}: ${ratio.toFixed(2)}`).toBe(`${label}: ${Math.max(4.5, ratio).toFixed(2)}`);
			}
		});
	}

	test("[dark] hover steps away from the resting state along the lightness axis", () => {
		for (const [, hex] of ACCENTS.slice(0, 5)) {
			const tokens = deriveCustomAccent(hex, "dark");
			const hoverL = chromaL(tokens["--accent-hover"] ?? "#000000");
			const accentL = chromaL(hex);
			if (accentL > 0.85) {
				// Near-white accents step back toward mid-tones (mono-preset parity).
				expect(hoverL).toBeLessThan(accentL);
				expect(hoverL).toBeGreaterThan(0.5);
			} else {
				expect(hoverL).toBeGreaterThan(accentL);
			}
		}
	});

	test("[light] hover is darker than the accent (steps away from the light bg)", () => {
		for (const [, hex] of ACCENTS.slice(0, 5)) {
			const tokens = deriveCustomAccent(hex, "light");
			const hoverL = chromaL(tokens["--accent-hover"] ?? "#ffffff");
			const accentL = chromaL(hex);
			expect(hoverL).toBeLessThan(accentL);
		}
	});

	test("near-white accents step hover back toward mid-tones (mono-preset parity)", () => {
		// mono dark encodes this: accent L 0.92 → hover L 0.84 (steps DOWN).
		const tokens = deriveCustomAccent("#ffffff", "dark");
		const hoverL = chromaL(tokens["--accent-hover"] ?? "#ffffff");
		expect(hoverL).toBeLessThan(0.95);
		expect(hoverL).toBeGreaterThan(0.5);
	});

	test("muted/bd stay as alpha variants of the accent", () => {
		const tokens = deriveCustomAccent("#d9a441", "dark");
		expect(tokens["--accent-muted"]).toMatch(/^#d9a4412e$/i); // 18% ≈ 0x2e
		expect(tokens["--accent-bd"]).toMatch(/^#d9a44159$/i); // 35% ≈ 0x59
	});
});

/** OKLab L via the same conversion chroma uses — no extra dependency here. */
function chromaL(hex: string): number {
	const n = parseInt(hex.slice(1), 16);
	const r = lin(((n >> 16) & 255) / 255);
	const g = lin(((n >> 8) & 255) / 255);
	const b = lin((n & 255) / 255);
	const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
	const l2 = Math.cbrt(l);
	const m2 = Math.cbrt(m);
	const s2 = Math.cbrt(s);
	return 0.2104542553 * l2 + 0.793617785 * m2 - 0.0040720468 * s2;
}

function lin(v: number): number {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
