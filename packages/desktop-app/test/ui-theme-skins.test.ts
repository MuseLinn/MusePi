import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import {
	getScrollbarSkins,
	saveImportedSkin,
	setContributedScrollbarSkins,
	validateImportedSkin,
} from "../src/plugins/ui-theme/skins";

const BASE = {
	id: "custom",
	displayName: "Custom",
	base: "gummy" as const,
	size: 12,
	pacGlyph: null,
};

describe("imported scrollbar skin validation", () => {
	test("refuses colour values that can fetch or execute", () => {
		const skin = validateImportedSkin({
			...BASE,
			colors: {
				accent: "url(https://example.invalid/track.png)",
				track: "image-set('x')",
				eaten: "expression(alert(1))",
			},
		});
		expect(skin).not.toBeNull();
		expect(skin!.colors.accent).not.toContain("url(");
		expect(skin!.colors.track).not.toContain("image");
		expect(skin!.colors.eaten).not.toContain("expression");
	});

	test("keeps normal colour syntax and clamps the rail size", () => {
		const skin = validateImportedSkin({
			...BASE,
			size: 99,
			colors: {
				accent: "oklch(0.7 0.2 30)",
				track: "color-mix(in oklab, var(--fg) 20%, transparent)",
				eaten: "#7a7462",
			},
		});
		expect(skin).not.toBeNull();
		expect(skin!.colors.accent).toBe("oklch(0.7 0.2 30)");
		expect(skin!.colors.track).toContain("color-mix");
		expect(skin!.size).toBe(24);
	});

	test("only accepts a data-URL glyph", () => {
		expect(validateImportedSkin({ ...BASE, pacGlyph: "https://example.invalid/a.svg" })!.pacGlyph).toBeNull();
		expect(validateImportedSkin({ ...BASE, pacGlyph: "data:image/svg+xml;base64,AA==" })!.pacGlyph).toBe(
			"data:image/svg+xml;base64,AA==",
		);
	});
});

describe("contributed scrollbar skins", () => {
	afterEach(() => {
		setContributedScrollbarSkins([]);
		localStorage.clear();
	});

	test("a contributed id overrides the built-in with the same id", () => {
		setContributedScrollbarSkins([
			{
				id: "builtin-snake",
				displayName: "Theme Snake",
				base: "gummy",
				colors: { accent: "var(--color-accent)", track: "transparent", eaten: "transparent" },
				size: 14,
				pacGlyph: null,
			},
		]);
		const skins = getScrollbarSkins();
		expect(skins.filter(skin => skin.id === "builtin-snake")).toHaveLength(1);
		expect(skins[0]!.displayName).toBe("Theme Snake");
		expect(skins[0]!.size).toBe(14);
		// The rest of the built-in catalog is still reachable.
		expect(skins.some(skin => skin.id === "builtin-pacman")).toBe(true);
	});

	test("contributed skins rank above imported ones", () => {
		saveImportedSkin({
			id: "shared",
			displayName: "Imported",
			base: "gummy",
			colors: { accent: "#111111", track: "transparent", eaten: "transparent" },
			size: 10,
			pacGlyph: null,
		});
		setContributedScrollbarSkins([
			{
				id: "shared",
				displayName: "Contributed",
				base: "gummy",
				colors: { accent: "#222222", track: "transparent", eaten: "transparent" },
				size: 12,
				pacGlyph: null,
			},
		]);
		const shared = getScrollbarSkins().filter(skin => skin.id === "shared");
		expect(shared).toHaveLength(1);
		expect(shared[0]!.displayName).toBe("Contributed");
	});
});
