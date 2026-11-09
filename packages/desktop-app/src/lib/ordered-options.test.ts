import { describe, expect, it } from "bun:test";
import { sortOrderedOptions } from "./ordered-options";

/**
 * Ordered array settings (schema `ui.ordered`, e.g. providers.webSearchOrder):
 * position in the stored array IS the priority, so the GUI editor displays
 * selected options in stored order before the unselected declared ones.
 */
describe("ordered array settings", () => {
	it("displays selected options in stored order before the unselected declared ones", () => {
		const options = [{ value: "a" }, { value: "b" }, { value: "c" }, { value: "d" }];
		expect(sortOrderedOptions(options, ["c", "a"]).map(option => option.value)).toEqual(["c", "a", "b", "d"]);
	});
});
