/**
 * 设置 → 外观 → 时间格式 / 一周起始日: the triggers must render localized
 * labels, never a raw i18n key.
 *
 * GuiSelect matches the current value against the option ids and falls back
 * to `String(value)` when nothing matches, so a component that kept
 * "general.auto" in state painted exactly that string. The same value was
 * read by resolveHour12 / weekStartIndex as an option id, which made both
 * settings inert. These assertions hold the UI side of that contract.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppearanceSection } from "../src/components/settings-sections/appearance";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	localStorage.clear();
});

function mount(): HTMLDivElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	act(() => {
		root?.render(<AppearanceSection showAvatars onToggleAvatars={() => {}} rpc={null} />);
	});
	host = el;
	return el;
}

/** The dropdown trigger rendered for the row carrying `labelText`. */
function selectTrigger(scope: HTMLElement, labelText: string): HTMLElement {
	const label = [...scope.querySelectorAll(".gui-settings-field-label")].find(n => n.textContent === labelText);
	const trigger = label?.closest(".gui-settings-field")?.querySelector<HTMLElement>(".gui-select-trigger");
	if (!trigger) throw new Error(`no select trigger under "${labelText}"`);
	return trigger;
}

describe("appearance localization selects", () => {
	it("shows the localized label instead of the i18n key when no pref is stored", () => {
		const scope = mount();
		const auto = t("general.auto");
		expect(selectTrigger(scope, t("general.timeFormat")).textContent).toBe(auto);
		expect(selectTrigger(scope, t("general.weekStarts")).textContent).toBe(auto);
	});

	it("resolves a stored option id to its label", () => {
		localStorage.setItem("musepi-gui-timefmt", "24h");
		const scope = mount();
		expect(selectTrigger(scope, t("general.timeFormat")).textContent).toBe(t("general.24Hour"));
	});

	it("normalizes a legacy i18n-key value so the pick is preserved", () => {
		// A build that stored the key left this on disk; the row must still
		// show the Sunday label and the calendar must still rotate to it.
		localStorage.setItem("musepi-gui-weekstart", "general.sunday");
		const scope = mount();
		expect(selectTrigger(scope, t("general.weekStarts")).textContent).toBe(t("general.sunday"));
	});

	it("never leaks a raw translation key into the label", () => {
		localStorage.setItem("musepi-gui-timefmt", "general.bogus");
		const scope = mount();
		const text = selectTrigger(scope, t("general.timeFormat")).textContent ?? "";
		expect(text).not.toContain("general.");
	});
});
