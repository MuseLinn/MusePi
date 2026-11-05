import { describe, expect, it } from "bun:test";
import { BUILTIN_PETDEX, BUILTIN_SVG_ID, DEFAULT_PET_ID, moodOfState, petForId } from "./pet";

describe("default companion", () => {
	it("resolves to the builtin spherical brand pet", () => {
		expect(DEFAULT_PET_ID).toBe(BUILTIN_SVG_ID);
		expect(petForId(DEFAULT_PET_ID)).toEqual({ kind: "builtin", id: BUILTIN_SVG_ID });
	});

	it("falls back to the sphere for an unknown id", () => {
		expect(petForId("no-such-pet")).toEqual({ kind: "builtin", id: BUILTIN_SVG_ID });
	});

	it("resolves every spritesheet preset", () => {
		const ids = BUILTIN_PETDEX.map(p => p.id);
		expect(ids).toContain("musepi");
		expect(ids.length).toBeGreaterThanOrEqual(10);
		for (const id of ids) {
			const pet = petForId(id);
			expect(pet.kind).toBe("petdex");
			expect(pet.kind === "petdex" && pet.pkg.spritesheet).toMatch(/^\.\/pets\/.+\.webp$/);
		}
		const sheet = petForId("musepi");
		expect(sheet.kind === "petdex" && sheet.pkg.spritesheet).toBe("./pets/musepi.webp");
	});

	it("keeps the sphere addressable by its own id", () => {
		expect(petForId(BUILTIN_SVG_ID)).toEqual({ kind: "builtin", id: BUILTIN_SVG_ID });
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
