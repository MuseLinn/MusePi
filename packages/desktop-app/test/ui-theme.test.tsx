import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { collectSlotComponents } from "../../coding-agent/src/daemon/extension-artifact-compiler";
import { assertKnownComponentSlot } from "../../coding-agent/src/extensibility/extensions/loader";
import { apply } from "../src/plugins/ui-theme";

describe("ui-theme Cordis bundle", () => {
	it("registers the rail overlay and the rail settings card", () => {
		const seats: { slot: string; moduleUrl: string; label: string }[] = [];
		apply({
			setLabel: () => undefined,
			slots: {
				register: component => seats.push(component),
			},
		});
		expect(seats.map(seat => seat.slot)).toEqual(["app.overlay", "settings.appearance.item"]);
		expect(() => assertKnownComponentSlot("app.overlay")).not.toThrow();
		expect(() => assertKnownComponentSlot("settings.appearance.item")).not.toThrow();
	});

	it("compiles both components through the real loader pipeline", async () => {
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
			{ slot: "app.overlay", error: undefined },
			{ slot: "settings.appearance.item", error: undefined },
		]);
		// The bundle owns skins.ts in its own folder, but the compiled rail and
		// settings card must read the HOST instance (shared contributed/imported
		// catalog), not a bundled copy.
		for (const component of components) {
			expect(component.code).toContain("MusePiHostModules");
			expect(component.code).toContain("scrollbar-skins");
		}
	}, 60_000);
});
