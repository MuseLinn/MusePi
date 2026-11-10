import { describe, expect, it } from "bun:test";
import { formatWhen, relTime } from "./format";

describe("formatWhen", () => {
	// A session row whose updatedAt never arrived used to fall through every
	// comparison and render "NaN 天前" in the session sheet.
	it("renders nothing for a missing or non-numeric timestamp", () => {
		expect(formatWhen(Number.NaN)).toBe("");
		expect(formatWhen(Number.POSITIVE_INFINITY)).toBe("");
		expect(formatWhen(undefined as unknown as number)).toBe("");
	});
});

describe("relTime", () => {
	it("renders nothing for a missing or non-numeric timestamp", () => {
		expect(relTime(Number.NaN)).toBe("");
		expect(relTime(undefined as unknown as number)).toBe("");
	});
});
