import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	activePet,
	BUILTIN_PETDEX,
	BUILTIN_SVG_ID,
	DEFAULT_PET_ID,
	DEFAULT_SPRITE_PET_ID,
	modeForPackage,
	moodOfState,
	type PetdexPackage,
	petForId,
	petId,
	petIdForMode,
	setPetId,
	setPetMode,
} from "./pet";

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

function storePackages(...packages: PetdexPackage[]): void {
	storage.setItem(PETDEX_KEY, JSON.stringify(packages));
}

const importedSheet: PetdexPackage = {
	id: "custom-sheet",
	displayName: "Custom sheet",
	spritesheet: "data:image/webp;base64,AA",
	width: 768,
	height: 936,
	importedAt: 1,
};

const importedAtlas: PetdexPackage = {
	...importedSheet,
	id: "custom-atlas",
	displayName: "Custom atlas",
	format: "atlas",
	atlas: { frameWidth: 64, frameHeight: 64, rows: 2, columns: 2 },
	states: { idle: { row: 0, frames: 2, fps: 8 } },
};

const importedSvg: PetdexPackage = {
	...importedSheet,
	id: "custom-svg",
	displayName: "Custom SVG",
	format: "svg",
	rows: [1],
	contentH: 512,
};

describe("default companion", () => {
	it("resolves to the builtin spherical brand pet", () => {
		expect(DEFAULT_PET_ID).toBe(BUILTIN_SVG_ID);
		expect(petForId(DEFAULT_PET_ID)).toEqual({ mode: "vector", kind: "builtin", id: BUILTIN_SVG_ID });
	});

	it("falls back to the sphere for an unknown id", () => {
		expect(petForId("no-such-pet")).toEqual({ mode: "vector", kind: "builtin", id: BUILTIN_SVG_ID });
	});

	it("resolves every spritesheet preset", () => {
		const ids = BUILTIN_PETDEX.map(p => p.id);
		expect(ids).toContain("musepi");
		expect(ids.length).toBeGreaterThanOrEqual(10);
		for (const id of ids) {
			const pet = petForId(id);
			expect(pet.kind).toBe("petdex");
			expect(pet.mode).toBe("sprite");
			expect(pet.kind === "petdex" && pet.pkg.spritesheet).toMatch(/^\.\/pets\/.+\.webp$/);
		}
		const sheet = petForId("musepi");
		expect(sheet.kind === "petdex" && sheet.pkg.spritesheet).toBe("./pets/musepi.webp");
	});

	it("keeps the sphere addressable by its own id", () => {
		expect(petForId(BUILTIN_SVG_ID)).toEqual({ mode: "vector", kind: "builtin", id: BUILTIN_SVG_ID });
	});
});

describe("pet mode derivation", () => {
	it("classifies single-frame SVG packages as vector art", () => {
		storePackages(importedSvg);
		expect(petForId("custom-svg")).toMatchObject({ mode: "vector", kind: "petdex" });
		expect(modeForPackage(importedSvg)).toBe("vector");
	});

	it("classifies grid and atlas packages as sprite frames", () => {
		storePackages(importedSheet, importedAtlas);
		expect(petForId("custom-sheet").mode).toBe("sprite");
		expect(petForId("custom-atlas").mode).toBe("sprite");
		expect(modeForPackage(importedAtlas)).toBe("sprite");
		expect(modeForPackage({})).toBe("sprite");
	});
});

describe("pet selection migration", () => {
	it("keeps an id-only selection and infers its mode", () => {
		storage.setItem(PET_ID_KEY, "boxcat");
		expect(petId()).toBe("boxcat");
		expect(activePet().mode).toBe("sprite");
		expect(petIdForMode("sprite")).toBe("boxcat");
		expect(petIdForMode("vector")).toBe(BUILTIN_SVG_ID);
	});

	it("classifies an id-only SVG package as a vector pick", () => {
		storePackages(importedSvg);
		storage.setItem(PET_ID_KEY, "custom-svg");
		expect(activePet().mode).toBe("vector");
		expect(petIdForMode("vector")).toBe("custom-svg");
	});
});

describe("per-mode selections", () => {
	it("keeps the sprite pick while the vector pick is active", () => {
		setPetId("boxcat");
		setPetId(BUILTIN_SVG_ID);
		expect(petId()).toBe(BUILTIN_SVG_ID);
		expect(petIdForMode("sprite")).toBe("boxcat");
	});

	it("switches modes without clearing either side", () => {
		setPetId("boxcat");
		setPetId(BUILTIN_SVG_ID);

		setPetMode("sprite");
		expect(petId()).toBe("boxcat");
		expect(activePet().mode).toBe("sprite");

		setPetMode("vector");
		expect(petId()).toBe(BUILTIN_SVG_ID);
		expect(petIdForMode("sprite")).toBe("boxcat");
	});

	it("remembers a legacy vector pick before the first mode switch", () => {
		storage.setItem(PET_ID_KEY, BUILTIN_SVG_ID);
		setPetMode("sprite");
		expect(petId()).toBe(DEFAULT_SPRITE_PET_ID);
		setPetMode("vector");
		expect(petId()).toBe(BUILTIN_SVG_ID);
	});

	it("drops a stale cross-mode pick instead of activating it", () => {
		storePackages(importedSvg);
		storage.setItem("musepi-gui-pet-sprite-id", "custom-svg");
		storage.setItem(PET_ID_KEY, BUILTIN_SVG_ID);
		setPetMode("sprite");
		expect(petId()).toBe(DEFAULT_SPRITE_PET_ID);
	});

	it("does not restore a deleted package from its remembered slot", () => {
		storage.setItem("musepi-gui-pet-vector-id", "svg-deleted");
		expect(petIdForMode("vector")).toBe(BUILTIN_SVG_ID);
	});
});

describe("moodOfState", () => {
	it("still collapses the state axis for spritesheets", () => {
		expect(moodOfState("working")).toBe("working");
		expect(moodOfState("alerting")).toBe("error");
		expect(moodOfState("dragging")).toBe("dragging");
		expect(moodOfState(null)).toBe("rest");
	});
});
