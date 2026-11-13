import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	activeCompanionArt,
	artFormatForPackage,
	BUILTIN_SPRITE_PRESETS,
	BUILTIN_VECTOR_ART_ID,
	companionArtForId,
	companionArtFromPush,
	companionArtId,
	companionArtIdForFormat,
	DEFAULT_COMPANION_ART_ID,
	DEFAULT_SPRITE_ART_ID,
	type SpritePackage,
	setCompanionArtFormat,
	setCompanionArtId,
	spriteMoodOfState,
} from "./companion";

const PETDEX_KEY = "musepi-gui-petdex";
const PET_ID_KEY = "musepi-gui-pet-id";

/** localStorage stand-in: pet selection is the only persistence this module
 *  reads, and bun test has no DOM storage. */
class MemoryStorage {
	#items = new Map<string, string>();

	getItem(key: string): string | null {
		return this.#items.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#items.set(key, value);
	}

	removeItem(key: string): void {
		this.#items.delete(key);
	}
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let storage: MemoryStorage;

beforeEach(() => {
	storage = new MemoryStorage();
	Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
});

afterEach(() => {
	if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

function storePackages(...packages: SpritePackage[]): void {
	storage.setItem(PETDEX_KEY, JSON.stringify(packages));
}

const importedSheet: SpritePackage = {
	id: "custom-sheet",
	displayName: "Custom sheet",
	spritesheet: "data:image/webp;base64,AA",
	width: 768,
	height: 936,
	importedAt: 1,
};

const importedAtlas: SpritePackage = {
	...importedSheet,
	id: "custom-atlas",
	displayName: "Custom atlas",
	format: "atlas",
	atlas: { frameWidth: 64, frameHeight: 64, rows: 2, columns: 2 },
	states: { idle: { row: 0, frames: 2, fps: 8 } },
};

const importedSvg: SpritePackage = {
	...importedSheet,
	id: "custom-svg",
	displayName: "Custom SVG",
	format: "svg",
	rows: [1],
	contentH: 512,
};

describe("default companion", () => {
	it("resolves to the builtin spherical brand pet", () => {
		expect(DEFAULT_COMPANION_ART_ID).toBe(BUILTIN_VECTOR_ART_ID);
		expect(companionArtForId(DEFAULT_COMPANION_ART_ID)).toEqual({
			mode: "vector",
			kind: "builtin",
			id: BUILTIN_VECTOR_ART_ID,
		});
	});

	it("falls back to the sphere for an unknown id", () => {
		expect(companionArtForId("no-such-pet")).toEqual({ mode: "vector", kind: "builtin", id: BUILTIN_VECTOR_ART_ID });
	});

	it("resolves every spritesheet preset", () => {
		const ids = BUILTIN_SPRITE_PRESETS.map(p => p.id);
		expect(ids).toContain("musepi");
		expect(ids.length).toBeGreaterThanOrEqual(10);
		for (const id of ids) {
			const pet = companionArtForId(id);
			expect(pet.kind).toBe("petdex");
			expect(pet.mode).toBe("sprite");
			expect(pet.kind === "petdex" && pet.pkg.spritesheet).toMatch(/^\.\/pets\/.+\.webp$/);
		}
		const sheet = companionArtForId("musepi");
		expect(sheet.kind === "petdex" && sheet.pkg.spritesheet).toBe("./pets/musepi.webp");
	});

	it("keeps the sphere addressable by its own id", () => {
		expect(companionArtForId(BUILTIN_VECTOR_ART_ID)).toEqual({
			mode: "vector",
			kind: "builtin",
			id: BUILTIN_VECTOR_ART_ID,
		});
	});
});

describe("pet mode derivation", () => {
	it("classifies single-frame SVG packages as vector art", () => {
		storePackages(importedSvg);
		expect(companionArtForId("custom-svg")).toMatchObject({ mode: "vector", kind: "petdex" });
		expect(artFormatForPackage(importedSvg)).toBe("vector");
	});

	it("classifies grid and atlas packages as sprite frames", () => {
		storePackages(importedSheet, importedAtlas);
		expect(companionArtForId("custom-sheet").mode).toBe("sprite");
		expect(companionArtForId("custom-atlas").mode).toBe("sprite");
		expect(artFormatForPackage(importedAtlas)).toBe("sprite");
		expect(artFormatForPackage({})).toBe("sprite");
	});
});

describe("pushed pet descriptor", () => {
	it("restores the mode a partial push omits", () => {
		expect(companionArtFromPush({ kind: "builtin", id: BUILTIN_VECTOR_ART_ID })).toEqual({
			mode: "vector",
			kind: "builtin",
			id: BUILTIN_VECTOR_ART_ID,
		});
		expect(companionArtFromPush({ kind: "petdex", pkg: importedAtlas })).toEqual({
			mode: "sprite",
			kind: "petdex",
			pkg: importedAtlas,
		});
		expect(companionArtFromPush({ kind: "petdex", pkg: importedSvg })).toMatchObject({
			mode: "vector",
			kind: "petdex",
		});
	});

	it("drops a push that cannot describe art", () => {
		expect(companionArtFromPush(null)).toBeNull();
		expect(companionArtFromPush({ kind: "builtin" })).toBeNull();
		expect(companionArtFromPush({ kind: "petdex" })).toBeNull();
		expect(companionArtFromPush({ kind: "petdex", pkg: { id: "no-art" } })).toBeNull();
	});
});

describe("pet selection migration", () => {
	it("keeps an id-only selection and infers its mode", () => {
		storage.setItem(PET_ID_KEY, "boxcat");
		expect(companionArtId()).toBe("boxcat");
		expect(activeCompanionArt().mode).toBe("sprite");
		expect(companionArtIdForFormat("sprite")).toBe("boxcat");
		expect(companionArtIdForFormat("vector")).toBe(BUILTIN_VECTOR_ART_ID);
	});

	it("classifies an id-only SVG package as a vector pick", () => {
		storePackages(importedSvg);
		storage.setItem(PET_ID_KEY, "custom-svg");
		expect(activeCompanionArt().mode).toBe("vector");
		expect(companionArtIdForFormat("vector")).toBe("custom-svg");
	});
});

describe("per-mode selections", () => {
	it("keeps the sprite pick while the vector pick is active", () => {
		setCompanionArtId("boxcat");
		setCompanionArtId(BUILTIN_VECTOR_ART_ID);
		expect(companionArtId()).toBe(BUILTIN_VECTOR_ART_ID);
		expect(companionArtIdForFormat("sprite")).toBe("boxcat");
	});

	it("switches modes without clearing either side", () => {
		setCompanionArtId("boxcat");
		setCompanionArtId(BUILTIN_VECTOR_ART_ID);

		setCompanionArtFormat("sprite");
		expect(companionArtId()).toBe("boxcat");
		expect(activeCompanionArt().mode).toBe("sprite");

		setCompanionArtFormat("vector");
		expect(companionArtId()).toBe(BUILTIN_VECTOR_ART_ID);
		expect(companionArtIdForFormat("sprite")).toBe("boxcat");
	});

	it("remembers a legacy vector pick before the first mode switch", () => {
		storage.setItem(PET_ID_KEY, BUILTIN_VECTOR_ART_ID);
		setCompanionArtFormat("sprite");
		expect(companionArtId()).toBe(DEFAULT_SPRITE_ART_ID);
		setCompanionArtFormat("vector");
		expect(companionArtId()).toBe(BUILTIN_VECTOR_ART_ID);
	});

	it("drops a stale cross-mode pick instead of activating it", () => {
		storePackages(importedSvg);
		storage.setItem("musepi-gui-pet-sprite-id", "custom-svg");
		storage.setItem(PET_ID_KEY, BUILTIN_VECTOR_ART_ID);
		setCompanionArtFormat("sprite");
		expect(companionArtId()).toBe(DEFAULT_SPRITE_ART_ID);
	});

	it("does not restore a deleted package from its remembered slot", () => {
		storage.setItem("musepi-gui-pet-vector-id", "svg-deleted");
		expect(companionArtIdForFormat("vector")).toBe(BUILTIN_VECTOR_ART_ID);
	});
});

describe("spriteMoodOfState", () => {
	it("still collapses the state axis for spritesheets", () => {
		expect(spriteMoodOfState("working")).toBe("working");
		expect(spriteMoodOfState("alerting")).toBe("error");
		expect(spriteMoodOfState("dragging")).toBe("dragging");
		expect(spriteMoodOfState(null)).toBe("rest");
	});
});
