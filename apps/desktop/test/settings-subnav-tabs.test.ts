import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { describe, expect, it } from "bun:test";
import {
	BUILTIN_TAB_IDS,
	resolveSubnavTabs,
	type SettingsSubnavTab,
} from "../src/components/settings-sections/session-memory";

/**
 * Contract: `settings.subnav.session-memory` appends a tab, and an entry whose
 * id names a built-in tab replaces that tab's content (and label) instead of
 * adding a duplicate.
 */
describe("sessions & memory subnav tabs", () => {
	const node = null;

	it("keeps the built-in order when nothing is contributed", () => {
		const resolved = resolveSubnavTabs([]);
		expect(resolved.options.map(option => option.value)).toEqual([...BUILTIN_TAB_IDS]);
	});

	it("appends a contributed tab with its own label", () => {
		const contributed: SettingsSubnavTab[] = [{ id: "backend", label: "Backend", node }];
		const resolved = resolveSubnavTabs(contributed);
		expect(resolved.options.map(option => option.value)).toEqual([...BUILTIN_TAB_IDS, "backend"]);
		expect(resolved.options.at(-1)?.label).toBe("Backend");
		expect(resolved.contentFor("backend")).toBe(node);
	});

	it("replaces a built-in tab's content and label when the id matches", () => {
		const contributed: SettingsSubnavTab[] = [{ id: "memory", label: "Memory backend", node }];
		const resolved = resolveSubnavTabs(contributed);
		expect(resolved.options.map(option => option.value)).toEqual([...BUILTIN_TAB_IDS]);
		expect(resolved.options.find(option => option.value === "memory")?.label).toBe("Memory backend");
		expect(resolved.contentFor("memory")).toBe(node);
	});

	it("falls back to the built-in content when no contribution names the tab", () => {
		const resolved = resolveSubnavTabs([]);
		expect(resolved.contentFor("memory")).toBeUndefined();
	});
});
