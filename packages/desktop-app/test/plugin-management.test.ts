import { describe, expect, it } from "bun:test";
import type { PluginPackageEntry } from "../src/components/UnifiedPluginsView";
import { setPluginManagementEnabled } from "../src/lib/plugin-management";

function row(management: "package" | "bundle"): PluginPackageEntry {
	return {
		name: "@demo/capability",
		version: "1.0.0",
		path: "/plugins/capability",
		scope: "user",
		enabled: false,
		description: null,
		icon: null,
		tools: 0,
		commands: 0,
		handlers: 0,
		management,
	};
}

describe("plugin management toggle", () => {
	it.each(["package", "bundle"] as const)("routes a %s through its owning composition", async management => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const rpc = {
			async request(method: string, params: unknown) {
				calls.push({ method, params });
				return { ok: true, enabled: true };
			},
		};
		await setPluginManagementEnabled(rpc as never, row(management), true);
		expect(calls).toEqual([
			{
				method: management === "bundle" ? "bundles.setEnabled" : "plugins.setEnabled",
				params: { name: "@demo/capability", enabled: true },
			},
		]);
	});
});
