import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { matchExtensionHostModule } from "@musepi/collab-proto/extension-host-modules";
import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";
import type { ExtensionAPI, ExtensionComponent } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import {
	SCHEDULED_PANEL_SLOT,
	SIDEBAR_PANEL_SLOT_PREFIX,
	type SlotComponent,
	selectSidebarPanelComponent,
} from "../src/lib/slot-host";
import { apply } from "../src/plugins/scheduled-panel/index";
import ScheduledPanel from "../src/plugins/scheduled-panel/page";

/**
 * The task-center sidebar panel is a real Cordis contribution, not a hidden
 * hard-coded branch. These contracts pin the seam: declaration, registration,
 * host selection/fallback, and the shared nav store the compiled component
 * must read (a bundled copy would silently break the page → panel bridge).
 */

function contribution(overrides: Partial<SlotComponent> = {}): SlotComponent {
	return {
		slot: SCHEDULED_PANEL_SLOT,
		extensionId: "musepi-scheduled-panel",
		code: "export default function Panel() { return null; }",
		...overrides,
	};
}

describe("scheduled-panel Cordis plugin", () => {
	it("registers the sidebar.panel.scheduled seat", () => {
		const components: ExtensionComponent[] = [];
		apply({
			setLabel() {},
			slots: {
				register(component: ExtensionComponent) {
					components.push(component);
				},
			},
		} as unknown as ExtensionAPI);
		expect(components).toEqual([
			expect.objectContaining({ slot: "sidebar.panel.scheduled", moduleUrl: "./page.tsx" }),
		]);
		expect(EXTENSION_SLOT_DECLARATION.prefixes).toContain(SIDEBAR_PANEL_SLOT_PREFIX);
	});

	it("the slot entry is the same component the host falls back to", () => {
		expect(typeof ScheduledPanel).toBe("function");
	});

	it("binds the page's nav store through the host module table", () => {
		// A compiled plugin must not bundle its own copy of the bridge.
		expect(matchExtensionHostModule("../lib/scheduled-task-nav")).toBe("task-nav");
	});
});

describe("selectSidebarPanelComponent", () => {
	it("picks only the contribution for the requested destination", () => {
		const scheduled = contribution();
		const home = contribution({ slot: `${SIDEBAR_PANEL_SLOT_PREFIX}home` });
		expect(selectSidebarPanelComponent([home, scheduled], "scheduled")).toBe(scheduled);
		expect(selectSidebarPanelComponent([scheduled], "home")).toBeUndefined();
	});

	it("a compile failure falls back to the built-in panel", () => {
		expect(selectSidebarPanelComponent([contribution({ error: "compile failed" })], "scheduled")).toBeUndefined();
		expect(selectSidebarPanelComponent([], "scheduled")).toBeUndefined();
	});
});
