import { describe, expect, test } from "bun:test";
import { inspectProviderDirectory, inspectQuery } from "@musepi/pi-coding-agent/daemon/cordis-inspect";
import { createExtensionRuntimeTools, RuntimeToolRegistry } from "@musepi/pi-coding-agent/daemon/plugin-runtime-tools";

describe("Cordis runtime API directory", () => {
	test("lists the providers a plugin can resolve before writing code", () => {
		const providers = inspectProviderDirectory();
		expect(providers.map(provider => provider.provider)).toEqual(["runtime", "package", "slots", "tools"]);
		expect(providers.find(provider => provider.provider === "runtime")?.methods).toContain("defineTool");
	});

	test("returns the exact contract of one method", () => {
		const result = inspectQuery({ provider: "runtime", method: "defineTool" });
		expect(result.ok).toBe(true);
		expect((result.data as { input: Record<string, string> }).input).toHaveProperty("name");
	});

	test("lists declared slots and builtin tools without invoking anything", () => {
		const slots = inspectQuery({ platform: "host", provider: "slots", method: "list" });
		expect(slots.ok).toBe(true);
		expect((slots.data as { exact: unknown[] }).exact.length).toBeGreaterThan(0);
		const tools = inspectQuery({ provider: "tools", method: "list" });
		expect((tools.data as { tools: string[] }).tools).toContain("read");
	});

	test("names the nearest reason for an unknown provider or method", () => {
		expect(inspectQuery({ provider: "nope", method: "x" })).toMatchObject({ ok: false });
		expect(inspectQuery({ provider: "runtime", method: "nope" })).toMatchObject({ ok: false });
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
});
