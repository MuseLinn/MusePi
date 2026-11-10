import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { collectSlotComponents } from "../../coding-agent/src/daemon/extension-artifact-compiler";
import { assertKnownComponentSlot } from "../../coding-agent/src/extensibility/extensions/loader";
import { SESSION_INFO_AGENTS_SLOT } from "../src/lib/slot-host";
import { apply } from "../src/plugins/session-info-agents";

describe("session-info-agents Cordis plugin", () => {
	it("registers the subagent section seat", () => {
		const seats: { slot: string; moduleUrl: string; label: string }[] = [];
		apply({
			setLabel: () => undefined,
			slots: {
				register: component => seats.push(component),
			},
		});
		expect(SESSION_INFO_AGENTS_SLOT).toBe("chat.session-info.agents");
		expect(seats).toEqual([{ slot: "chat.session-info.agents", moduleUrl: "./page.tsx", label: "子代理" }]);
		expect(() => assertKnownComponentSlot("chat.session-info.agents")).not.toThrow();
	});

	it("compiles through the real loader pipeline", async () => {
		const root = path.resolve(import.meta.dir, "..");
		const components = await collectSlotComponents(
			[
				{
					kind: "plugin-module",
					state: "active",
					path: path.join(root, "src/plugins/session-info-agents/index.ts"),
				},
			],
			root,
		);
		expect(components.map(item => ({ slot: item.slot, error: item.error }))).toEqual([
			{ slot: "chat.session-info.agents", error: undefined },
		]);
	}, 60_000);
});
