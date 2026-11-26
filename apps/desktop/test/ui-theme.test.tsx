import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { collectSlotComponents } from "../../../packages/coding-agent/src/daemon/extension-artifact-compiler";
import { assertKnownComponentSlot } from "../../../packages/coding-agent/src/extensibility/extensions/loader";
import { apply } from "../src/plugins/ui-theme";

describe("ui-theme Cordis bundle", () => {
	it("registers the scrollbar-skin settings card", () => {
		const seats: { slot: string; moduleUrl: string; label: string }[] = [];
		apply({
			setLabel: () => undefined,
			slots: {
				register: component => seats.push(component),
			},
		});
		expect(seats.map(seat => seat.slot)).toEqual(["settings.item.appearance.rail"]);
		expect(() => assertKnownComponentSlot("settings.item.appearance.rail")).not.toThrow();
	});

	it("compiles the settings card through the real loader pipeline", async () => {
		const root = path.resolve(import.meta.dir, "..");
		const components = await collectSlotComponents(
			[
				{
					kind: "plugin-module",
					state: "active",
					path: path.join(root, "src/plugins/ui-theme/index.ts"),
				},
			],
			root,
		);
		expect(components.map(item => ({ slot: item.slot, error: item.error }))).toEqual([
			{ slot: "settings.item.appearance.rail", error: undefined },
		]);
		// The bundle owns skins.ts in its own folder, but the compiled settings
		// card must read the HOST instance (shared contributed/imported catalog),
		// not a bundled copy.
		for (const component of components) {
			expect(component.code).toContain("MusePiHostModules");
			expect(component.code).toContain("scrollbar-skins");
		}
	}, 60_000);
});
