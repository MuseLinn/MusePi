import { describe, expect, it } from "bun:test";
import { t } from "../i18n/index.js";
import { compactAge, formatWhen, relTime } from "./format";

describe("formatWhen", () => {
	// A session row whose updatedAt never arrived used to fall through every
	// comparison and render "NaN 天前" in the session sheet.
	it("renders nothing for a missing or non-numeric timestamp", () => {
		expect(formatWhen(Number.NaN)).toBe("");
		expect(formatWhen(Number.POSITIVE_INFINITY)).toBe("");
		expect(formatWhen(undefined as unknown as number)).toBe("");
	});
});

describe("compactAge", () => {
	const now = 1_800_000_000_000;
	const age = (ms: number): string => compactAge(now - ms, now);

	it("renders nothing for a missing timestamp", () => {
		expect(compactAge(Number.NaN, now)).toBe("");
	});

	it("holds one unit until the next one starts", () => {
		expect(age(0)).toBe(t("sessions.now"));
		expect(age(59_000)).toBe(t("sessions.now"));
		expect(age(60_000)).toBe("1m");
		expect(age(59 * 60_000)).toBe("59m");
		expect(age(60 * 60_000)).toBe("1h");
		expect(age(23 * 3_600_000)).toBe("23h");
		expect(age(24 * 3_600_000)).toBe("1d");
		expect(age(6 * 86_400_000)).toBe("6d");
		expect(age(7 * 86_400_000)).toBe("1w");
		expect(age(13 * 86_400_000)).toBe("1w");
		expect(age(14 * 86_400_000)).toBe("2w");
		expect(age(30 * 86_400_000)).toBe("1mo");
		expect(age(364 * 86_400_000)).toBe("12mo");
		expect(age(365 * 86_400_000)).toBe("1y");
	});

	it("clamps clock skew instead of counting negative age", () => {
		expect(compactAge(now + 5_000, now)).toBe(t("sessions.now"));
	});
});

describe("relTime", () => {
	it("renders nothing for a missing or non-numeric timestamp", () => {
		expect(relTime(Number.NaN)).toBe("");
		expect(relTime(undefined as unknown as number)).toBe("");
	});
});
