import { describe, expect, test } from "bun:test";
import {
	cordisInspectRegistry,
	inspectProviderDirectory,
	inspectQuery,
	registerInspectProvider,
} from "@musepi/pi-coding-agent/daemon/cordis-inspect";
import { createExtensionRuntimeTools, RuntimeToolRegistry } from "@musepi/pi-coding-agent/daemon/plugin-runtime-tools";

describe("Cordis runtime API registry", () => {
	test("lists the providers a plugin can resolve before writing code", () => {
		const providers = inspectProviderDirectory();
		expect(providers.map(provider => provider.provider)).toEqual(["runtime", "package", "slots", "tools"]);
		expect(providers.find(provider => provider.provider === "runtime")?.methods).toContain("defineTool");
	});

	test("returns the exact contract of one method", async () => {
		const result = await inspectQuery({ provider: "runtime", method: "defineTool" });
		expect(result.ok).toBe(true);
		expect((result.data as { input: Record<string, string> }).input).toHaveProperty("name");
	});

	test("answers live queries: declared slots and the session's tool vocabulary", async () => {
		const slots = await inspectQuery({ platform: "host", provider: "slots", method: "list" });
		expect(slots.ok).toBe(true);
		expect((slots.data as { exact: unknown[] }).exact.length).toBeGreaterThan(0);
		const tools = await inspectQuery({ provider: "tools", method: "list" }, { toolNames: ["session_only_tool"] });
		expect((tools.data as { tools: string[] }).tools).toContain("read");
		expect((tools.data as { tools: string[] }).tools).toContain("session_only_tool");
	});

	test("serves the seat catalog: contract, register options and current occupants", async () => {
		const all = await inspectQuery({ provider: "slots", method: "catalog" });
		expect(all.ok).toBe(true);
		const { exact, prefixes } = all.data as {
			exact: Array<{
				name: string;
				kind: string;
				scope: string;
				declaredBy: string;
				replaceRisk: string;
				registerOptions: Array<{ name: string; requirement: string }>;
				occupants: Array<{ slot: string; plugin: string }>;
			}>;
			prefixes: Array<{ prefix: string; occupants: unknown[] }>;
		};
		expect(exact.length).toBeGreaterThan(0);
		expect(prefixes.length).toBeGreaterThan(0);

		const page = exact.find(entry => entry.name === "settings.section")!;
		expect(page.kind).toBe("list");
		expect(page.registerOptions.find(option => option.name === "id")?.requirement).toBe("required");
		expect(page.occupants.map(occupant => occupant.slot)).toContain("settings.section");

		const composer = exact.find(entry => entry.name === "conversation.composer.dock")!;
		expect(composer.occupants.length).toBeGreaterThan(0);
	});

	test("narrows the catalog to one seat and names an unknown one", async () => {
		const one = await inspectQuery({ provider: "slots", method: "catalog", input: { slot: "settings.section" } });
		expect(one.ok).toBe(true);
		expect((one.data as { exact: unknown[] }).exact).toHaveLength(1);

		const missing = await inspectQuery({ provider: "slots", method: "catalog", input: { slot: "nope.seat" } });
		expect(missing.data).toMatchObject({ ok: false });
		expect((missing.data as { seats: string[] }).seats).toContain("settings.section");
	});

	test("accepts an injected provider and restores the previous one on release", async () => {
		const release = registerInspectProvider({
			platform: "host",
			provider: "clock",
			summary: "Fixture clock provider",
			methods: {
				now: { description: "Current fixture time", query: () => ({ now: 42 }) },
			},
		});
		try {
			expect(inspectProviderDirectory().map(provider => provider.provider)).toContain("clock");
			const result = await inspectQuery({ provider: "clock", method: "now" });
			expect((result.data as { now: number }).now).toBe(42);
		} finally {
			release();
		}
		expect(inspectProviderDirectory().map(provider => provider.provider)).not.toContain("clock");
	});

	test("names the nearest reason for an unknown provider or method", async () => {
		expect(await inspectQuery({ provider: "nope", method: "x" })).toMatchObject({ ok: false });
		expect(await inspectQuery({ provider: "runtime", method: "nope" })).toMatchObject({ ok: false });
	});

	test("the tools expose list / query / self separately", async () => {
		const tools = createExtensionRuntimeTools(
			() => null,
			() => new RuntimeToolRegistry(),
		);
		const names = tools.map(tool => tool.name);
		expect(names).toContain("cordis_inspect_list");
		expect(names).toContain("cordis_inspect_query");
		expect(names).toContain("cordis_inspect_self");

		const list = tools.find(tool => tool.name === "cordis_inspect_list")!;
		const result = (await list.execute(
			"call",
			{} as never,
			undefined,
			{ autoApprove: false } as never,
			undefined,
		)) as {
			content: Array<{ text: string }>;
		};
		expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true });
	});

	test("the host registry is the one built-ins registered into", () => {
		expect(cordisInspectRegistry.list().length).toBeGreaterThanOrEqual(4);
	});
});
