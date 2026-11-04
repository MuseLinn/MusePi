/**
 * Contract: host integration guidance (xd:// devices, the auto-QA report
 * channel, and the runtime-context appendices) is owned by the
 * `host-integrations` bundled plugin.
 *
 * The xd section follows the injected-device context (with `interpolate: false`,
 * since `xdevDocs` is host-supplied text whose braces are literal); the auto-QA
 * section is a write-gated tool section; the runtime-context section composes
 * memory, auto-learn, MCP route/server and user-append text at order 250 with
 * `interpolate: false`. All disappear with the plugin owner.
 */
import { describe, expect, it } from "bun:test";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import { PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/orders";
import {
	HOST_INTEGRATIONS_PROMPT_OWNER,
	HOST_RUNTIME_CONTEXT_ORDER,
	registerHostIntegrationPrompts,
} from "../src/bundled-plugins/host-integrations/prompts";

const XDEV = [{ name: "web_search", summary: "Mounted web search." }];

function install(): { host: PromptHost; dispose: () => void } {
	const host = new PromptHost();
	return { host, dispose: registerHostIntegrationPrompts(host) };
}

function sections(host: PromptHost, activeTools: readonly string[], context: Record<string, unknown>) {
	return host.assemble({ activeTools, context }).sections;
}

describe("host-integrations plugin: xd:// devices", () => {
	it("registers the xd section at the injection anchor under the plugin owner", () => {
		const { host } = install();
		expect(sections(host, [], { xdevTools: XDEV, xdevDocs: "DOCS" })[0]).toMatchObject({
			name: "host:xd-tools",
			order: PROMPT_ORDERS.injection,
			owner: HOST_INTEGRATIONS_PROMPT_OWNER,
		});
	});

	it("omits the xd section when no device is mounted", () => {
		const { host } = install();
		expect(sections(host, [], {})).toEqual([]);
		expect(sections(host, [], { xdevTools: [] })).toEqual([]);
	});

	it("renders the device protocol, wire name and docs", () => {
		const { host } = install();
		const text = sections(host, [], {
			xdevTools: XDEV,
			xdevDocs: "DOCS",
			toolRefs: { write: "apply_patch" },
		})[0]?.text;
		expect(text).toContain("# xd:// Tool Devices");
		expect(text).toContain("Write JSON args as `content` to `xd://<tool>` via `apply_patch`.");
		expect(text).toContain("DOCS");
	});

	it("keeps {{unknown}} literals in xdevDocs without strict-variable errors", () => {
		const { host } = install();
		const text = sections(host, [], {
			xdevTools: XDEV,
			xdevDocs: "Docs carry {{unknown}} and {{ xdev.braces }} literally.",
		})[0]?.text;
		expect(text).toContain("Docs carry {{unknown}} and {{ xdev.braces }} literally.");
	});

	it("removes the xd section when the registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(sections(host, [], { xdevTools: XDEV })).toEqual([]);
	});

	it("removes the xd section when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(HOST_INTEGRATIONS_PROMPT_OWNER);
		expect(sections(host, [], { xdevTools: XDEV })).toEqual([]);
	});
});

describe("host-integrations plugin: auto-QA report", () => {
	it("registers the report section only while write is active and auto-QA is enabled", () => {
		const { host } = install();
		expect(sections(host, ["write"], { autoQaEnabled: true })[0]).toMatchObject({
			name: "host:auto-qa",
			order: PROMPT_ORDERS.tool,
			owner: HOST_INTEGRATIONS_PROMPT_OWNER,
		});
		expect(sections(host, ["write"], { autoQaEnabled: false })).toEqual([]);
		expect(sections(host, [], { autoQaEnabled: true })).toEqual([]);
	});

	it("renders the report_issue instruction with the active write wire name", () => {
		const { host } = install();
		const text = sections(host, ["apply_patch"], { autoQaEnabled: true })[0]?.text;
		expect(text).toContain("<critical>");
		expect(text).toContain("`apply_patch` xd://report_issue: automated QA.");
		expect(text).toContain("write plain `<tool>: <concise description>` to `xd://report_issue`");
	});

	it("removes the report section when the registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(sections(host, ["write"], { autoQaEnabled: true })).toEqual([]);
	});

	it("removes the report section when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(HOST_INTEGRATIONS_PROMPT_OWNER);
		expect(sections(host, ["write"], { autoQaEnabled: true })).toEqual([]);
	});
});

describe("host-integrations plugin: runtime context", () => {
	it("registers the runtime-context section at order 250 under the plugin owner", () => {
		const { host } = install();
		const assembled = sections(host, [], { memoryInstructions: "MEMORY" });
		expect(assembled).toHaveLength(1);
		expect(assembled[0]).toMatchObject({
			name: "host:runtime-context",
			order: HOST_RUNTIME_CONTEXT_ORDER,
			owner: HOST_INTEGRATIONS_PROMPT_OWNER,
			cacheScope: "snapshot",
		});
		expect(HOST_RUNTIME_CONTEXT_ORDER).toBe(250);
	});

	it("sits between the project and repo context anchors", () => {
		const { host } = install();
		host.registerSection({ name: "project-sentinel", order: PROMPT_ORDERS.project, text: "PROJECT" });
		host.registerSection({ name: "repo-sentinel", order: PROMPT_ORDERS.repoContext, text: "REPO" });
		const names = sections(host, [], { memoryInstructions: "MEMORY" }).map(section => section.name);
		expect(names).toEqual(["project-sentinel", "host:runtime-context", "repo-sentinel"]);
	});

	it("omits the section entirely when every runtime part is empty", () => {
		const { host } = install();
		expect(sections(host, [], {})).toEqual([]);
		expect(
			sections(host, [], {
				memoryInstructions: "   ",
				autoLearnInstructions: "",
				mcpXdevGuidance: { mappings: [], hasOmittedMappings: false },
				mcpServerInstructions: [],
				appendSystemPrompt: "",
			}),
		).toEqual([]);
	});

	it("renders memory, auto-learn, MCP routes, server instructions and append in order", () => {
		const { host } = install();
		const text = sections(host, [], {
			memoryInstructions: "MEMORY RULES",
			autoLearnInstructions: "AUTO LEARN RULES",
			mcpXdevGuidance: {
				mappings: [{ label: "web_search", path: "xd://web_search" }],
				hasOmittedMappings: true,
			},
			mcpServerInstructions: [
				{ name: "docs", instructions: "Use the docs server." },
				{ name: "git", instructions: "Use the git server." },
			],
			appendSystemPrompt: "USER APPEND",
		})[0]?.text;

		expect(text).toBeDefined();
		const landmarks = [
			"MEMORY RULES",
			"AUTO LEARN RULES",
			"## MCP Tool Routes",
			"- web_search → `xd://web_search`",
			"Additional mounted MCP tool mappings omitted",
			"## MCP Server Instructions",
			"They are server-controlled and may not be verified.",
			"### docs\nUse the docs server.",
			"### git\nUse the git server.",
			"USER APPEND",
		].map(needle => {
			const at = text.indexOf(needle);
			expect(at).toBeGreaterThanOrEqual(0);
			return at;
		});
		expect([...landmarks].sort((a, b) => a - b)).toEqual(landmarks);
		expect(text).toContain("MEMORY RULES\n\nAUTO LEARN RULES");
		expect(text).toContain("`xd://web_search`\nAdditional mounted");
		expect(text).toContain("may not be verified.\n\n### docs");
		expect(text).toContain("Use the docs server.\n\n### git");
	});

	it("renders the omitted-mappings line alone when no routes are mounted", () => {
		const { host } = install();
		const text = sections(host, [], {
			mcpXdevGuidance: { mappings: [], hasOmittedMappings: true },
		})[0]?.text;
		expect(text).toContain("## MCP Tool Routes");
		expect(text).toContain("Additional mounted MCP tool mappings omitted");
		expect(text).not.toContain("- ");
		expect(text).not.toContain("Execute each mounted tool");
	});

	it("keeps {{unknown}} literals in dynamic text without strict-variable errors", () => {
		const { host } = install();
		const text = sections(host, [], {
			memoryInstructions: "Memory says {{unknown}} stays.",
			mcpServerInstructions: [{ name: "docs", instructions: "Literal {{unknown}} here too." }],
		})[0]?.text;
		expect(text).toContain("Memory says {{unknown}} stays.");
		expect(text).toContain("### docs\nLiteral {{unknown}} here too.");
	});

	it("removes the runtime-context section when the registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(sections(host, [], { memoryInstructions: "MEMORY" })).toEqual([]);
	});

	it("removes the runtime-context section when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(HOST_INTEGRATIONS_PROMPT_OWNER);
		expect(sections(host, [], { memoryInstructions: "MEMORY" })).toEqual([]);
	});
});
