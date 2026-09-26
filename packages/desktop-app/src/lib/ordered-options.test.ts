import { describe, expect, it } from "bun:test";
import { moveOrderedOption, sortOrderedOptions } from "./ordered-options";

/**
 * Ordered array settings (schema `ui.ordered`, e.g. providers.webSearchOrder):
 * position in the stored array IS the priority, so the GUI chip editor must
 * reorder within the selection and display selected options in stored order.
 */
describe("ordered array settings", () => {
	it("moves a selected option one position earlier or later", () => {
		expect(moveOrderedOption(["kimi", "bing", "mojeek"], "mojeek", -1)).toEqual(["kimi", "mojeek", "bing"]);
		expect(moveOrderedOption(["kimi", "bing", "mojeek"], "kimi", 1)).toEqual(["bing", "kimi", "mojeek"]);
	});

	it("is a no-op at the boundaries and for values outside the selection", () => {
		expect(moveOrderedOption(["a", "b"], "a", -1)).toEqual(["a", "b"]);
		expect(moveOrderedOption(["a", "b"], "b", 1)).toEqual(["a", "b"]);
		expect(moveOrderedOption(["a", "b"], "ghost", 1)).toEqual(["a", "b"]);
	});

	it("displays selected options in stored order before the unselected declared ones", () => {
		const options = [{ value: "a" }, { value: "b" }, { value: "c" }, { value: "d" }];
		expect(sortOrderedOptions(options, ["c", "a"]).map(option => option.value)).toEqual(["c", "a", "b", "d"]);
	});
});
