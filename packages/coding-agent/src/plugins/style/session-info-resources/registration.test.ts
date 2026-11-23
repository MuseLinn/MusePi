/**
 * The `musepi-session-info-resources` bundled plugin owns one card section.
 *
 * The session info card mounts every `chat.session-info.<id>` contribution by
 * prefix; if `apply` stopped registering the seat, the readout would vanish
 * from the card with no host-side change to notice it.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionComponent, PluginAPI } from "../../../extensibility/extensions/types";
import { apply } from "./index";

function fakeCtx(): { ctx: PluginAPI; components: ExtensionComponent[] } {
	const components: ExtensionComponent[] = [];
	const ctx = {
		setLabel() {},
		slots: {
			register(component: ExtensionComponent) {
				components.push(component);
			},
		},
		logger: { info() {}, warn() {}, error() {} },
	} as unknown as PluginAPI;
	return { ctx, components };
}

describe("musepi-session-info-resources plugin", () => {
	test("registers the card's resources section", () => {
		const { ctx, components } = fakeCtx();
		apply(ctx);
		expect(components.map(component => component.slot)).toEqual(["chat.session-info.resources"]);
		expect(components[0]?.moduleUrl).toBe("./ui/resources-section.tsx");
	});
});
