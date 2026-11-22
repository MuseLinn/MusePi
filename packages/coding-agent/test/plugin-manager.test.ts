import { describe, expect, test } from "bun:test";
import { createPluginManagerTools, type PluginManagementHandle } from "@musepi/pi-coding-agent/tools/plugin-manager";

const calls: string[] = [];
const handle: PluginManagementHandle = {
	listPlugins: async () => [
		{
			id: "persona",
			name: "@demo/plugin",
			state: "enabled",
			group: false,
			layers: ["profile"],
			pluginPath: "/plugins/demo",
			mountable: true,
		},
	],
	setPlugin: async (id, enabled) => {
		calls.push(`row:${id}:${String(enabled)}`);
		return { ok: true, id, application: "applied" };
	},
	listBundles: async () => [{ name: "@demo/bundle", version: "1.0.0", enabled: true, readable: true }],
	setBundle: async (name, enabled) => {
		calls.push(`bundle:${name}:${String(enabled)}`);
		return { ok: true, name };
	},
	installBundle: async spec => {
		calls.push(`install:${spec}`);
		return { ok: true, name: "@demo/bundle", version: "1.0.1", application: "applied" };
	},
	removeBundle: async name => {
		calls.push(`remove:${name}`);
		return { ok: true, name, application: "applied" };
	},
	listVersionExemptions: async () => ({
		runtimeVersion: "1.0.0",
		exemptions: { "@demo/plugin@2.0.0": ["1.0.0"] },
		warnings: [],
	}),
	setVersionExemption: async (target, _runtimeVersion, _enabled) => {
		calls.push(`exempt:${target}`);
		return { ok: true, name: target };
	},
};

const tool = createPluginManagerTools(() => handle)[0]!;

const context = (autoApprove: boolean) => ({ autoApprove }) as never;

async function run(args: Record<string, unknown>, autoApprove = false): Promise<Record<string, unknown>> {
	const result = (await tool.execute("call", args as never, undefined, context(autoApprove), undefined)) as {
		content: Array<{ text: string }>;
	};
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("plugin_manager tool", () => {
	test("lists composed plugin rows with their exact ids", async () => {
		const result = await run({ action: "list_plugins" });
		expect(result.ok).toBe(true);
		expect((result.entries as Array<{ id: string }>)[0]?.id).toBe("persona");
	});

	test("lists stackable bundles separately from their rows", async () => {
		const result = await run({ action: "list_bundles" });
		expect((result.bundles as Array<{ name: string }>)[0]?.name).toBe("@demo/bundle");
	});

	test("toggles a row by id and a bundle by name", async () => {
		expect((await run({ action: "set_plugin", target: "persona", enabled: false })).ok).toBe(true);
		expect((await run({ action: "set_bundle", target: "@demo/bundle", enabled: true })).ok).toBe(true);
		expect(calls).toContain("row:persona:false");
		expect(calls).toContain("bundle:@demo/bundle:true");
	});

	test("refuses an install outside an auto-approved session", async () => {
		const before = calls.length;
		const result = await run({ action: "install_bundle", target: "./local/bundle" });
		expect(result.ok).toBe(false);
		expect(result.nextStep).toBeDefined();
		expect(calls.length).toBe(before);
	});

	test("runs an install when the session is auto-approved", async () => {
		const result = await run({ action: "install_bundle", target: "./local/bundle" }, true);
		expect(result.version).toBe("1.0.1");
		expect(calls).toContain("install:./local/bundle");
	});

	test("exposes exact version exemptions", async () => {
		const listed = await run({ action: "list_version_exemptions" });
		expect(listed.runtimeVersion).toBe("1.0.0");
		expect((listed.exemptions as Record<string, string[]>)["@demo/plugin@2.0.0"]).toEqual(["1.0.0"]);
	});

	test("refuses to grant an exemption without explicit risk acceptance", async () => {
		const before = calls.length;
		const result = await run({
			action: "set_version_exemption",
			target: "@demo/plugin@2.0.0",
			runtimeVersion: "1.0.0",
			enabled: true,
		});
		expect(result.ok).toBe(false);
		expect(calls.length).toBe(before);
	});

	test("grants with acceptRisk in an auto-approved session and revokes freely", async () => {
		const granted = await run(
			{
				action: "set_version_exemption",
				target: "@demo/plugin@2.0.0",
				runtimeVersion: "1.0.0",
				enabled: true,
				acceptRisk: true,
			},
			true,
		);
		expect(granted.ok).toBe(true);
		const revoked = await run({
			action: "set_version_exemption",
			target: "@demo/plugin@2.0.0",
			runtimeVersion: "1.0.0",
			enabled: false,
		});
		expect(revoked.ok).toBe(true);
		expect(calls).toContain("exempt:@demo/plugin@2.0.0");
	});

	test("reports a missing daemon handle instead of pretending", async () => {
		const orphan = createPluginManagerTools(() => null)[0]!;
		const result = (await orphan.execute(
			"call",
			{ action: "list_plugins" } as never,
			undefined,
			context(false),
			undefined,
		)) as { content: Array<{ text: string }> };
		expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false });
	});

	test("rejects an unknown action", async () => {
		expect((await run({ action: "bundle" })).ok).toBe(false);
	});
});
