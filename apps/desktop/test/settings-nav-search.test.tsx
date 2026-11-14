/**
 * Settings search: cross-page results in the nav. Clicking one must hand the
 * page id and the setting key to SettingsView (which opens the page and
 * scrolls to `[data-setting-key]`).
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsNav } from "../src/components/SettingsNav";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	setLocale("en-US");
});

function mount(query: string, onSelectRow: (section: string, key: string) => void): HTMLDivElement {
	setLocale("en-US");
	const element = document.createElement("div");
	document.body.appendChild(element);
	root = createRoot(element);
	act(() => {
		root?.render(
			createElement(SettingsNav, {
				extTabs: [],
				activeSection: "appearance",
				onSelect: () => {},
				onBack: () => {},
				query,
				onQueryChange: () => {},
				settingsRows: [
					{
						key: "compaction.thresholdPercent",
						section: "context",
						tab: "context",
						group: "Compaction",
						label: "Compaction Threshold",
					},
				],
				onSelectRow,
			}),
		);
	});
	host = element;
	return element;
}

describe("settings search results", () => {
	it("lists a matching setting above the page rows", () => {
		const scope = mount("compaction", () => {});
		const rows = scope.querySelectorAll<HTMLButtonElement>(".gui-settings-nav--setting");
		expect(rows.length).toBe(1);
		expect(rows[0]?.textContent).toContain("Compaction Threshold");
	});

	it("hands the owning page and the row key to the view", () => {
		const selections: [string, string][] = [];
		const scope = mount("threshold", (section, key) => selections.push([section, key]));
		act(() => scope.querySelector<HTMLButtonElement>(".gui-settings-nav--setting")?.click());
		expect(selections).toEqual([["context", "compaction.thresholdPercent"]]);
	});

	it("shows no setting results when nothing matches", () => {
		const scope = mount("zzzz-no-such-setting", () => {});
		expect(scope.querySelector(".gui-settings-nav--setting")).toBeNull();
	});
});
