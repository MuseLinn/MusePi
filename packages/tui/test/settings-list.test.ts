import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
	section: (text) => text,
};

const noop = () => {};

function makeItems() {
	return [
		{ id: "a", label: "alpha", section: "One", currentValue: "off", values: ["off", "on"] },
		{ id: "b", label: "beta", section: "One", currentValue: "off", values: ["off", "on"] },
		{ id: "c", label: "gamma", section: "Two", currentValue: "off", values: ["off", "on"] },
	];
}

describe("SettingsList sections", () => {
	it("renders a heading row before each section run", () => {
		const list = new SettingsList(makeItems(), 10, testTheme, noop, noop);
		const rendered = list.render(80);

		const oneIndex = rendered.findIndex((line) => line.includes("One"));
		const twoIndex = rendered.findIndex((line) => line.includes("Two"));
		const alphaIndex = rendered.findIndex((line) => line.includes("alpha"));
		const gammaIndex = rendered.findIndex((line) => line.includes("gamma"));

		assert.ok(oneIndex !== -1 && twoIndex !== -1);
		assert.ok(oneIndex < alphaIndex, "heading One precedes alpha");
		assert.ok(twoIndex < gammaIndex, "heading Two precedes gamma");
		assert.ok(alphaIndex < twoIndex, "sections render in item order");
	});

	it("renders no headings when items have no section (flat list unchanged)", () => {
		const items = [
			{ id: "a", label: "alpha", currentValue: "off", values: ["off", "on"] },
			{ id: "b", label: "beta", currentValue: "off", values: ["off", "on"] },
		];
		const list = new SettingsList(items, 10, testTheme, noop, noop);
		const rendered = list.render(80);

		assert.equal(rendered.filter((line) => line.includes("alpha")).length, 1);
		assert.ok(rendered[0]!.includes("alpha"), "first row is the first item, not a heading");
	});

	it("skips heading rows when moving the selection", () => {
		const list = new SettingsList(makeItems(), 10, testTheme, noop, noop);

		// Initially on "alpha"; move down twice: beta, then gamma (heading "Two" skipped)
		list.handleInput("\x1b[B");
		let rendered = list.render(80);
		assert.ok(rendered.some((line) => line.startsWith("> ") && line.includes("beta")));

		list.handleInput("\x1b[B");
		rendered = list.render(80);
		assert.ok(rendered.some((line) => line.startsWith("> ") && line.includes("gamma")));

		// Wrap around: down again returns to alpha
		list.handleInput("\x1b[B");
		rendered = list.render(80);
		assert.ok(rendered.some((line) => line.startsWith("> ") && line.includes("alpha")));
	});

	it("activates the item under the cursor, never a heading", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(makeItems(), 10, testTheme, (id, value) => changes.push([id, value]), noop);

		list.handleInput("\x1b[B"); // beta
		list.handleInput(" "); // cycle beta
		assert.deepEqual(changes, [["b", "on"]]);
	});
});

describe("SettingsList search with sections", () => {
	it("matches section names so a section query surfaces all its items", () => {
		const list = new SettingsList(makeItems(), 10, testTheme, noop, noop, { enableSearch: true });

		for (const ch of "two") {
			list.handleInput(ch);
		}
		const rendered = list.render(80);

		assert.ok(
			rendered.some((line) => line.includes("gamma")),
			"section query keeps its items",
		);
		assert.ok(!rendered.some((line) => line.includes("alpha")), "other sections filtered out");
		assert.ok(!rendered.some((line) => line.includes("beta")), "other sections filtered out");
	});

	it("still fuzzy-matches labels", () => {
		const list = new SettingsList(makeItems(), 10, testTheme, noop, noop, { enableSearch: true });

		for (const ch of "alph") {
			list.handleInput(ch);
		}
		const rendered = list.render(80);

		assert.ok(rendered.some((line) => line.includes("alpha")));
		assert.ok(!rendered.some((line) => line.includes("gamma")));
	});
});
