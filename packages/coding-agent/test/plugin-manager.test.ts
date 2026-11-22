import { describe, expect, test } from "bun:test";
import { createPluginManagerTools, type PluginManagementHandle } from "@musepi/pi-coding-agent/tools/plugin-manager";

const calls: string[] = [];
const handle: PluginManagementHandle = {
	list: async () => [{ name: "demo", version: "1.0.0", enabled: true, path: "/plugins/demo" }],
	setEnabled: async (name, enabled) => {
		calls.push(`set:${name}:${String(enabled)}`);
		return { ok: true, name, enabled, application: "applied" };
	},
	install: async spec => {
		calls.push(`install:${spec}`);
		return { ok: true, name: "demo", version: "1.0.1", application: "applied" };
	},
	remove: async name => {
		calls.push(`remove:${name}`);
		return { ok: true, name, application: "applied" };
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
	test("lists installed packages with their exact names", async () => {
		const result = await run({ action: "list_plugins" });
		expect(result.ok).toBe(true);
		expect(result.total).toBe(1);
		expect((result.entries as Array<{ name: string }>)[0]?.name).toBe("demo");
	});

	test("enable/disable delegates to the profile manager", async () => {
		const result = await run({ action: "set_plugin", target: "demo", enabled: false });
		expect(result.ok).toBe(true);
		expect(calls).toContain("set:demo:false");
	});

	test("refuses an install outside an auto-approved session", async () => {
		const before = calls.length;
		const result = await run({ action: "install_plugin", target: "./local/plugin" });
		expect(result.ok).toBe(false);
		expect(result.nextStep).toBeDefined();
		expect(calls.length).toBe(before);
	});

	test("runs an install when the session is auto-approved", async () => {
		const result = await run({ action: "install_plugin", target: "./local/plugin" }, true);
		expect(result.ok).toBe(true);
		expect(result.version).toBe("1.0.1");
		expect(calls).toContain("install:./local/plugin");
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
		const result = await run({ action: "bundle" });
		expect(result.ok).toBe(false);
	});
});
