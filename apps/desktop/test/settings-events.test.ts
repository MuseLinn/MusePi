import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import {
	dispatchSettingsChanged,
	LEGACY_SETTINGS_CHANGED_EVENT,
	onSettingsChanged,
	SETTINGS_CHANGED_EVENT,
} from "../src/lib/settings-events";

describe("settings-changed events", () => {
	it("uses the musepi prefix and keeps omp as a deprecated alias", () => {
		expect(SETTINGS_CHANGED_EVENT).toBe("musepi-settings-changed");
		expect(LEGACY_SETTINGS_CHANGED_EVENT).toBe("omp-settings-changed");
	});

	it("notifies canonical subscribers once and legacy listeners too", () => {
		const canonical: string[] = [];
		const legacy: string[] = [];
		const off = onSettingsChanged(detail => canonical.push(detail.key));
		const onLegacy = (event: Event): void => {
			legacy.push((event as CustomEvent<{ key: string }>).detail.key);
		};
		window.addEventListener(LEGACY_SETTINGS_CHANGED_EVENT, onLegacy);

		dispatchSettingsChanged("widget.enabled");

		window.removeEventListener(LEGACY_SETTINGS_CHANGED_EVENT, onLegacy);
		off();
		expect(canonical).toEqual(["widget.enabled"]);
		expect(legacy).toEqual(["widget.enabled"]);
	});

	it("stops delivering after unsubscribe", () => {
		const seen: string[] = [];
		const off = onSettingsChanged(detail => seen.push(detail.key));
		off();
		dispatchSettingsChanged("board.enabled");
		expect(seen).toEqual([]);
	});
});
