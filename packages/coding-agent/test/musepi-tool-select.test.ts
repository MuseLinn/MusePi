// MusePi tool-select — host seam tests (tool-select-native.ts).
// Uses a stub AgentSession (active-set + tool registry + history) and a
// real merged musepi settings object; covers gate off/on, active-set
// shaping, resume reconciliation, select_tools execution, and the
// announcement transformer.

import { mergeMusepiSettings } from "@musepi/core";
import { describe, expect, test } from "vitest";
import {
	initMusepiToolSelect,
	musepiSelectToolsToolDef,
	transformMusepiToolSelectContext,
} from "../src/musepi/tool-select-native.ts";

const K3_MODEL = {
	provider: "moonshotai",
	id: "kimi-k3",
	compat: { deferredToolsMode: "kimi" },
};
const GPT_MODEL = { provider: "openai", id: "gpt-5", compat: {} };

function fakeSession(opts: {
	model: any;
	active: string[];
	tools: { name: string; source: string }[];
	messages?: any[];
}) {
	let active = [...opts.active];
	return {
		model: opts.model,
		messages: opts.messages ?? [],
		getAllTools: () => opts.tools.map((t) => ({ name: t.name, sourceInfo: { source: t.source } })),
		getActiveToolNames: () => [...active],
		setActiveToolsByName: (names: string[]) => {
			active = [...names];
		},
	} as any;
}

function fakeSettings(musepi?: Parameters<typeof mergeMusepiSettings>[0]) {
	return { getMusepi: () => mergeMusepiSettings(musepi) } as any;
}

const REGISTRY = [
	{ name: "read", source: "builtin" },
	{ name: "create_goal", source: "sdk" },
	{ name: "select_tools", source: "sdk" },
	{ name: "mcp_fs_read", source: "extension" },
	{ name: "mcp_web_search", source: "extension" },
];

describe("initMusepiToolSelect", () => {
	test("gate off (default config): select_tools hidden, deferrable tools stay active", () => {
		const session = fakeSession({
			model: K3_MODEL,
			active: ["read", "create_goal", "select_tools", "mcp_fs_read"],
			tools: REGISTRY,
		});
		initMusepiToolSelect(session, fakeSettings());
		expect(session.getActiveToolNames()).toEqual(["read", "create_goal", "mcp_fs_read"]);
	});

	test("gate off for non-capable model even when enabled", () => {
		const session = fakeSession({
			model: GPT_MODEL,
			active: ["read", "select_tools", "mcp_fs_read"],
			tools: REGISTRY,
		});
		initMusepiToolSelect(session, fakeSettings({ toolSelect: { enabled: true } }));
		expect(session.getActiveToolNames()).toEqual(["read", "mcp_fs_read"]);
	});

	test("allowlist rescues a non-declared model", () => {
		const session = fakeSession({
			model: GPT_MODEL,
			active: ["read", "create_goal", "select_tools", "mcp_fs_read", "mcp_web_search"],
			tools: REGISTRY,
		});
		initMusepiToolSelect(session, fakeSettings({ toolSelect: { enabled: true, models: ["openai/gpt-5"] } }));
		expect(session.getActiveToolNames()).toEqual(["read", "create_goal", "select_tools"]);
	});

	test("gate on for K3: deferrable tools stripped, core sdk tools kept", () => {
		const session = fakeSession({
			model: K3_MODEL,
			active: ["read", "create_goal", "select_tools", "mcp_fs_read", "mcp_web_search"],
			tools: REGISTRY,
		});
		initMusepiToolSelect(session, fakeSettings({ toolSelect: { enabled: true } }));
		expect(session.getActiveToolNames()).toEqual(["read", "create_goal", "select_tools"]);
	});

	test("resume reconciliation: historically loaded deferrable tools re-activate", () => {
		const session = fakeSession({
			model: K3_MODEL,
			active: ["read", "select_tools", "mcp_fs_read"],
			tools: REGISTRY,
			messages: [
				{
					role: "toolResult",
					toolCallId: "1",
					toolName: "select_tools",
					addedToolNames: ["mcp_web_search"],
					content: [],
					isError: false,
					timestamp: 0,
				},
			],
		});
		initMusepiToolSelect(session, fakeSettings({ toolSelect: { enabled: true } }));
		expect(session.getActiveToolNames()).toEqual(["read", "select_tools", "mcp_web_search"]);
	});
});

describe("select_tools execution", () => {
	test("loads deferrable tools into the active set and reports the three-way split", async () => {
		const session = fakeSession({
			model: K3_MODEL,
			active: ["read", "create_goal", "select_tools", "mcp_fs_read", "mcp_web_search"],
			tools: REGISTRY,
		});
		initMusepiToolSelect(session, fakeSettings({ toolSelect: { enabled: true } }));
		const result = await musepiSelectToolsToolDef.execute(
			"call_1",
			{ names: ["mcp_fs_read", "read", "nope"] },
			undefined,
			undefined,
			{} as any,
		);
		expect(session.getActiveToolNames()).toEqual(["read", "create_goal", "select_tools", "mcp_fs_read"]);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Loaded: mcp_fs_read");
		expect(text).toContain("Already available: read");
		expect(text).toContain("Unknown tool: nope");
	});

	test("rejects when the gate is off", async () => {
		const session = fakeSession({ model: GPT_MODEL, active: ["read"], tools: REGISTRY });
		initMusepiToolSelect(session, fakeSettings());
		await expect(
			musepiSelectToolsToolDef.execute("call_2", { names: ["mcp_fs_read"] }, undefined, undefined, {} as any),
		).rejects.toThrow("not available");
	});

	test("throws when every requested name is unknown", async () => {
		const session = fakeSession({ model: K3_MODEL, active: ["read", "select_tools"], tools: REGISTRY });
		initMusepiToolSelect(session, fakeSettings({ toolSelect: { enabled: true } }));
		await expect(
			musepiSelectToolsToolDef.execute("call_2b", { names: ["nope"] }, undefined, undefined, {} as any),
		).rejects.toThrow("Unknown tool: nope");
	});
});

describe("announcement transformer", () => {
	test("appends a tools_added user message listing loadable tools", () => {
		const session = fakeSession({
			model: K3_MODEL,
			active: ["read", "select_tools", "mcp_fs_read", "mcp_web_search"],
			tools: REGISTRY,
		});
		initMusepiToolSelect(session, fakeSettings({ toolSelect: { enabled: true } }));
		const out = transformMusepiToolSelectContext([{ role: "user", content: "hi" } as any]);
		expect(out).toHaveLength(2);
		const injected = out[1] as any;
		expect(injected.role).toBe("user");
		expect(injected.content[0].text).toContain("<tools_added>\nmcp_fs_read\nmcp_web_search\n</tools_added>");
	});

	test("no-op when gate is off", () => {
		const session = fakeSession({ model: GPT_MODEL, active: ["read"], tools: REGISTRY });
		initMusepiToolSelect(session, fakeSettings());
		const messages = [{ role: "user", content: "hi" } as any];
		expect(transformMusepiToolSelectContext(messages)).toBe(messages);
	});

	test("no-op once everything deferrable is loaded", async () => {
		const session = fakeSession({
			model: K3_MODEL,
			active: ["read", "select_tools", "mcp_fs_read"],
			tools: REGISTRY.filter((t) => t.name !== "mcp_web_search"),
		});
		initMusepiToolSelect(session, fakeSettings({ toolSelect: { enabled: true } }));
		await musepiSelectToolsToolDef.execute("call_3", { names: ["mcp_fs_read"] }, undefined, undefined, {} as any);
		const messages = [{ role: "user", content: "hi" } as any];
		expect(transformMusepiToolSelectContext(messages)).toBe(messages);
	});
});
