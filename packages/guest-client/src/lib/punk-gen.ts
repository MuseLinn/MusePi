/**
 * Pixel-punk avatar generator — ported from sweeterio/pixelpunks
 * (24×24 palette-indexed pixel art, deterministic per seed).
 *
 * The upstream Python combines a base model (`man`) with sticker layers
 * (cigarette) on a transparent canvas. This module ports the matrices to TS
 * and extends the variation space so a seed — agent id, member id, git user
 * name — maps to ONE stable avatar: 6 skin tones × 6 hair colours × 4
 * hairstyles (man / long / mohawk / bald) × 4 hats (none / cap / top hat /
 * headphones) × 4 eyewear (none / round / square / shades) × optional
 * moustache / blush / smile / cigarette.
 * Output is a crispEdges SVG data URI: zero deps, renders at any size.
 *
 * Determinism: FNV-1a hash of the seed picks each dimension, so the same
 * identity always renders the same face (swarm member ↔ user ↔ agent).
 */

/** 24×24 row-major palette-index matrix; 0 = transparent. */
type Grid = readonly (readonly number[])[];
interface Layer {
	/** Palette: index 0 is transparent; 1..n are hex colors (no '#'). */
	colors: readonly string[];
	grid: Grid;
}

/** Compact row helper: `.` = transparent, `1..9` = palette index 1..9. */
function R(...rows: string[]): number[][] {
	return rows.map(r => {
		const out = new Array<number>(24).fill(0);
		for (let i = 0; i < Math.min(r.length, 24); i++) {
			const c = r[i] as string;
			if (c !== ".") out[i] = Number(c);
		}
		return out;
	});
}

/** Upstream `man` model: 1 = hair, 2 = skin, 3 = brows, 4 = eyes. */
const MAN: Layer = {
	colors: ["", "000000", "e0c29e", "585858", "fdfdfd"],
	grid: R(
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		".......1111111..........",
		".......122222221........",
		"......12222222221.......",
		"......12222222221.......",
		"......12222222221.......",
		"......12222222221.......",
		"......122233222331......",
		".....122214222141.......",
		".....122222222221.......",
		"......12222211221.......",
		"......12222222221.......",
		"......12222222221.......",
		"......12222111221.......",
		"......12222222221.......",
		"......1222222221........",
		"......122211111.........",
		"......12221.............",
		"......12221.............",
		"......12221.............",
	),
};

const CIGARETTE: Layer = {
	colors: ["", "000000", "dddddd", "c6c6c6", "e25b26"],
	grid: R(
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"...................2....",
		"...................2....",
		"...................2....",
		"...................2....",
		"...................2....",
		"...................2....",
		"........................",
		".............111111.....",
		".............13333341...",
		"..............111111....",
	),
};

const CAP: Layer = {
	colors: ["", "1f2a44", "e8e8e8"],
	grid: R(
		"111111111111111111111111",
		"111111111111111111111111",
		"111111111111111111111111",
		"111111111111111111111111",
		"111111111111111111111111",
		".2222222222222222222222.",
	),
};

const LONG: Layer = {
	colors: ["", "000000"],
	grid: R(
		"......111111111111......",
		"......111111111111......",
		".......111111111111.....",
		".......111111111111.....",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111..111111111111..111",
		"..111................111",
	),
};

/** Mohawk: a tall central strip; the man's side hair reads as sideburns. */
const MOHAWK: Layer = {
	colors: ["", "000000"],
	grid: R(
		"..........1111..........",
		"..........1111..........",
		"..........1111..........",
		"..........1111..........",
		".........111111.........",
		".........111111.........",
		".........111111.........",
		".........111111.........",
		"..........1111..........",
	),
};

/** Bald: paint the man's crown with the skin tone. */
const BALD: Layer = {
	colors: ["", "e0c29e"],
	grid: R(
		"......11111111111111....",
		"......11111111111111....",
		".......111111111111.....",
		".......111111111111.....",
	),
};

/** Top hat: tall crown + brim. */
const TOPHAT: Layer = {
	colors: ["", "1f2a44"],
	grid: R(
		".......1111111111.......",
		".......1111111111.......",
		".......1111111111.......",
		".......1111111111.......",
		".......1111111111.......",
		".....11111111111111.....",
	),
};

/** Headphones: headband across the crown + ear cups at the sides. */
const HEADPHONES: Layer = {
	colors: ["", "3a3f4b"],
	grid: R(
		".....11111111111111.....",
		".....11111111111111.....",
		"...111.................111...",
		"...111.................111...",
		"...111.................111...",
		"...111.................111...",
		"...111.................111...",
	),
};

/** Round glasses (rows 11-12). */
const GLASSES: Layer = {
	colors: ["", "111111"],
	grid: R(
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		"........................",
		".......1........1.......",
		".......1........1.......",
		"........................",
	),
};

const SQUARE: Layer = {
	colors: ["", "111111"],
	grid: R(
		".......111111111111.....",
		".......1..........1.....",
		".......1..........1.....",
		".......111111111111.....",
	),
};

/** Shades: full dark band with a nose bridge gap. */
const SHADES: Layer = {
	colors: ["", "1a1a1a"],
	grid: R(".......111111111111.....", ".......1111..1111.......", ".......111111111111....."),
};

/** Moustache above the mouth. */
const MUSTACHE: Layer = {
	colors: ["", "3b2a1a"],
	grid: R(".........111111.........", ".........111111........."),
};

/** Blush dots at the cheeks. */
const BLUSH: Layer = {
	colors: ["", "e88b8b"],
	grid: R("......11............11..", "......11............11.."),
};

/** Open-mouth smile replacing the man's closed mouth line. */
const SMILE: Layer = {
	colors: ["", "201a14"],
	grid: R(".........111111.........", "..........1111.........."),
};

/** Skin palettes (replaces man index 2). */
const SKINS: readonly string[] = ["e0c29e", "8d5524", "c68642", "f8d9c0", "6b3a2a", "f1c27d"];
/** Hair palettes (replaces man index 1). */
const HAIRS: readonly string[] = ["000000", "3b2314", "bd442f", "c9b037", "5b3a1e", "8c7853"];

const SIZE = 24;

/** FNV-1a 32-bit — stable across runs, no collisions for short seeds. */
export function hashSeed(seed: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Merge `layer` onto `out` (out palette/indices grow; layer wins on overlap). */
function mergeLayer(out: { colors: string[]; grid: number[][] }, layer: Layer): void {
	const indexOf: number[] = [0];
	for (let c = 1; c < layer.colors.length; c++) {
		const color = layer.colors[c] as string;
		const existing = out.colors.indexOf(color);
		if (existing >= 0) indexOf[c] = existing;
		else {
			indexOf[c] = out.colors.length;
			out.colors.push(color);
		}
	}
	for (let y = 0; y < SIZE; y++) {
		const src = layer.grid[y];
		if (!src) continue; // sparse sticker (caps/glasses only cover part)
		const dst = out.grid[y] as number[];
		for (let x = 0; x < SIZE; x++) {
			const v = src[x] as number;
			if (v > 0) dst[x] = indexOf[v] as number;
		}
	}
}

/** Compose the 24×24 grid for a seed (skin/hair/hat/glasses/face bits). */
export function punkGrid(seed: string): { colors: string[]; grid: number[][] } {
	const h = hashSeed(seed);
	const skin = SKINS[h % SKINS.length] as string;
	const hairColor = HAIRS[(h >>> 4) % HAIRS.length] as string;
	// 0 man, 1 long, 2 mohawk, 3 bald
	const hairstyle = (h >>> 8) % 4;
	// 0 none, 1 cap, 2 top hat, 3 headphones
	const hat = (h >>> 12) % 4;
	const capLight = ((h >>> 14) & 1) === 1;
	// 0 none, 1 round, 2 square, 3 shades (none is 2/5 — keep faces clean
	// often but accessory faces common enough for visible variety)
	const eyewear = (h >>> 16) % 5;
	const mustache = (h >>> 20) % 3 === 0;
	const blush = (h >>> 22) % 3 === 0;
	const smoke = (h >>> 24) % 3 === 0;
	const smile = (h >>> 26) % 3 === 0;

	const out = { colors: ["", skin, hairColor, "585858", "fdfdfd"], grid: [] as number[][] };
	// Base face, remapped from MAN (hair/skin indices swapped in place:
	// out palette has index 1 = skin, 2 = hair).
	for (const row of MAN.grid) {
		out.grid.push(row.map(v => (v === 1 ? 2 : v === 2 ? 1 : v)));
	}

	// Hairstyle overlays the crown (index 1 = hair colour).
	if (hairstyle === 1) mergeLayer(out, LONG);
	else if (hairstyle === 2) mergeLayer(out, MOHAWK);
	else if (hairstyle === 3) mergeLayer(out, BALD);

	// Hats sit above the hair.
	if (hat === 1) {
		const cap = capLight ? { ...CAP, colors: ["", "7a2e2e", "f0d9a0"] } : CAP;
		mergeLayer(out, cap);
	} else if (hat === 2) mergeLayer(out, TOPHAT);
	else if (hat === 3) mergeLayer(out, HEADPHONES);

	// Eyewear over the eyes.
	if (eyewear === 1) mergeLayer(out, GLASSES);
	else if (eyewear === 2) mergeLayer(out, SQUARE);
	else if (eyewear === 3) mergeLayer(out, SHADES);

	// Facial details.
	if (mustache) mergeLayer(out, MUSTACHE);
	if (blush) mergeLayer(out, BLUSH);
	if (smile) mergeLayer(out, SMILE);
	if (smoke) mergeLayer(out, CIGARETTE);
	return out;
}

/** Render the composed grid as a crispEdges SVG data URI. */
export function punkAvatarUri(seed: string): string {
	const { colors, grid } = punkGrid(seed);
	// Row-scan: merge horizontal runs of one color into a single rect.
	const rects: string[] = [];
	for (let y = 0; y < SIZE; y++) {
		const row = grid[y] as readonly number[];
		let x = 0;
		while (x < SIZE) {
			const v = row[x] as number;
			if (v === 0) {
				x++;
				continue;
			}
			let x2 = x + 1;
			while (x2 < SIZE && (row[x2] as number) === v) x2++;
			const fill = colors[v] as string;
			rects.push(`<rect x="${x}" y="${y}" width="${x2 - x}" height="1" fill="#${fill}"/>`);
			x = x2;
		}
	}
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
