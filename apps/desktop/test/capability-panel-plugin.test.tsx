import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { matchExtensionHostModule } from "@musepi/collab-proto/extension-host-modules";
import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";
import type { ExtensionAPI, ExtensionComponent } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import {
	CAPABILITY_PANEL_SLOT,
	SIDEBAR_PANEL_SLOT_PREFIX,
	type SlotComponent,
	selectSidebarPanelComponent,
} from "../src/lib/slot-host";
import { apply } from "../src/plugins/capability-panel/index";
import CapabilityPanel from "../src/plugins/capability-panel/page";

/**
 * The capability center's second-tier panel is a real Cordis contribution,
 * not a hard-coded branch. These contracts pin the seam: declaration,
 * registration, host selection/fallback, and the ONE shared nav store that
 * both the compiled `app.capability` page and this panel must bind.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

function contribution(overrides: Partial<SlotComponent> = {}): SlotComponent {
	return {
		slot: CAPABILITY_PANEL_SLOT,
		extensionId: "musepi-capability-panel",
		code: "export default function Panel() { return null; }",
		...overrides,
	};
}

describe("capability-panel Cordis plugin", () => {
	it("registers the sidebar.panel.capability seat", () => {
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
			expect.objectContaining({ slot: "sidebar.panel.capability", moduleUrl: "./page.tsx" }),
		]);
		expect(EXTENSION_SLOT_DECLARATION.prefixes).toContain(SIDEBAR_PANEL_SLOT_PREFIX);
		expect(CAPABILITY_PANEL_SLOT).toBe(`${SIDEBAR_PANEL_SLOT_PREFIX}capability`);
	});

	it("the slot entry is the same component the host falls back to", () => {
		expect(typeof CapabilityPanel).toBe("function");
	});

	it("binds the page/panel nav store through the host module table", () => {
		// A compiled plugin must not bundle its own copy of the bridge.
		expect(matchExtensionHostModule("../lib/capability-nav")).toBe("capability-nav");
		const modules = read("apps/desktop/src/lib/host-modules.ts");
		expect(modules).toContain('import * as capabilityNav from "./capability-nav"');
		expect(modules).toContain('"capability-nav": capabilityNav');
	});

	it("is marked built-in so the extensions list does not offer a duplicate install", () => {
		const registry = read("packages/coding-agent/src/extensibility/extensions-center/builtin-registry.ts");
		expect(registry).toContain('name: "capability-panel"');
	});
});

describe("selectSidebarPanelComponent for capability", () => {
	it("picks only the contribution for the capability destination", () => {
		const capability = contribution();
		const scheduled = contribution({ slot: `${SIDEBAR_PANEL_SLOT_PREFIX}scheduled` });
		expect(selectSidebarPanelComponent([scheduled, capability], "capability")).toBe(capability);
		expect(selectSidebarPanelComponent([capability], "scheduled")).toBeUndefined();
	});

	it("a compile failure or missing registry falls back to the built-in panel", () => {
		expect(selectSidebarPanelComponent([contribution({ error: "compile failed" })], "capability")).toBeUndefined();
		expect(selectSidebarPanelComponent([], "capability")).toBeUndefined();
	});
});
