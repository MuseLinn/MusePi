import { describe, expect, it } from "bun:test";
import {
	BUILTIN_ORB_ID,
	BUILTIN_PETDEX,
	BUILTIN_SVG_ID,
	DEFAULT_PET_ID,
	isPetError,
	moodOfState,
	orbStateFor,
	PET_STATES,
	petForId,
} from "./pet";

describe("default companion", () => {
	it("resolves to the brand orb", () => {
		expect(DEFAULT_PET_ID).toBe(BUILTIN_ORB_ID);
		expect(petForId(DEFAULT_PET_ID)).toEqual({ kind: "builtin", id: BUILTIN_ORB_ID });
	});

	it("falls back to the brand orb for an unknown id", () => {
		expect(petForId("no-such-pet")).toEqual({ kind: "builtin", id: BUILTIN_ORB_ID });
	});

	it("keeps every spritesheet preset selectable", () => {
		const ids = BUILTIN_PETDEX.map(p => p.id);
		expect(ids).toContain("musepi");
		expect(ids.length).toBeGreaterThanOrEqual(10);
		const sheet = petForId("musepi");
		expect(sheet.kind).toBe("petdex");
		expect(sheet.kind === "petdex" && sheet.pkg.spritesheet).toBe("./pets/musepi.webp");
	});

	it("keeps the note-bot selectable", () => {
		expect(petForId(BUILTIN_SVG_ID)).toEqual({ kind: "builtin", id: BUILTIN_SVG_ID });
	});
});

describe("orbStateFor", () => {
	it("maps the busy states onto the matching orb animations", () => {
		expect(orbStateFor("idle", "rest")).toBe("listening");
		expect(orbStateFor("working", "working")).toBe("working");
		expect(orbStateFor("thinking", "analyzing")).toBe("solving");
		expect(orbStateFor("searching", "analyzing")).toBe("searching");
		expect(orbStateFor("writing", "working")).toBe("composing");
		expect(orbStateFor("notifying", "waiting")).toBe("waiting");
	});

	it("covers every pet state", () => {
		for (const state of PET_STATES) {
			expect(orbStateFor(state, "rest")).toMatch(
				/^(working|searching|solving|listening|composing|shaping|waiting)$/,
			);
		}
	});

	it("falls back to the legacy mood when no state is carried", () => {
		expect(orbStateFor(null, "rest")).toBe("listening");
		expect(orbStateFor(undefined, "error")).toBe("waiting");
		expect(orbStateFor(null, "working")).toBe("working");
	});
});

describe("isPetError", () => {
	it("flags the failure and confusion states plus the error mood", () => {
		expect(isPetError("alerting", "working")).toBe(true);
		expect(isPetError("confused", "rest")).toBe(true);
		expect(isPetError(null, "error")).toBe(true);
		expect(isPetError("working", "working")).toBe(false);
		expect(isPetError(null, "rest")).toBe(false);
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
