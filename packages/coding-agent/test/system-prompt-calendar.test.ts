import { describe, expect, it } from "bun:test";
import { resolvePromptCalendar } from "../src/system-prompt";

/**
 * Regression: the project prompt built `date` and `weekday` from two separate
 * `new Date()` calls. A build that ran across local midnight could pair
 * yesterday's date with tomorrow's weekday, making the model's time anchor
 * internally inconsistent.
 *
 * Contract: both values come from one instant, so every instant lands on one
 * side of the boundary for both fields.
 */
describe("system prompt calendar", () => {
	it("keeps date and weekday consistent just before local midnight", () => {
		const parts = resolvePromptCalendar(new Date(2026, 0, 1, 23, 59, 59, 999));
		expect(parts).toEqual({
			date: "2026-01-01",
			dateTime: "2026-01-01",
			weekday: "Thursday",
		});
	});

	it("keeps date and weekday consistent just after local midnight", () => {
		const parts = resolvePromptCalendar(new Date(2026, 0, 2, 0, 0, 0, 1));
		expect(parts).toEqual({
			date: "2026-01-02",
			dateTime: "2026-01-02",
			weekday: "Friday",
		});
	});
});
