// MusePi core — tool-select (progressive tool disclosure) 引擎测试。
// 覆盖：门控组合、partition（可延迟划分）、planLoad 三分、
// ledger fold/resume 自愈、公告渲染、active-set 开关转换。
import assert from "node:assert";
import { describe, it } from "node:test";
import {
	activeNamesOnDisable,
	activeNamesOnEnable,
	foldLoadedToolNames,
	isToolSelectEnabled,
	modelInAllowlist,
	modelSupportsDeferredTools,
	partitionTools,
	planLoad,
	reconcileResumedActiveNames,
	renderLoadableToolsAnnouncement,
	renderLoadResult,
	SELECT_TOOLS_TOOL_NAME,
} from "../src/tool-select/index.ts";

const K3 = { provider: "moonshotai", id: "kimi-k3", deferredToolsMode: "kimi" };
const GPT = { provider: "openai", id: "gpt-5" };

describe("gate", () => {
	it("off by default even for capable models", () => {
		assert.equal(isToolSelectEnabled(undefined, K3), false);
		assert.equal(isToolSelectEnabled({}, K3), false);
		assert.equal(isToolSelectEnabled({ enabled: false }, K3), false);
	});

	it("on when enabled and model declares deferredToolsMode kimi", () => {
		assert.equal(isToolSelectEnabled({ enabled: true }, K3), true);
	});

	it("off when enabled but model lacks capability and is not allowlisted", () => {
		assert.equal(isToolSelectEnabled({ enabled: true }, GPT), false);
	});

	it("allowlist rescues capable-but-undeclared models", () => {
		assert.equal(isToolSelectEnabled({ enabled: true, models: ["openai/gpt-5"] }, GPT), true);
		assert.equal(isToolSelectEnabled({ enabled: true, models: ["gpt-5"] }, GPT), true);
		assert.equal(isToolSelectEnabled({ enabled: true, models: ["other"] }, GPT), false);
	});

	it("model capability helpers", () => {
		assert.equal(modelSupportsDeferredTools(K3), true);
		assert.equal(modelSupportsDeferredTools(GPT), false);
		assert.equal(modelSupportsDeferredTools(undefined), false);
		assert.equal(modelInAllowlist(GPT, ["openai/gpt-5"]), true);
		assert.equal(modelInAllowlist(GPT, []), false);
		assert.equal(modelInAllowlist(undefined, ["gpt-5"]), false);
	});
});

describe("partitionTools", () => {
	const entries = [
		{ name: "read", source: "builtin" },
		{ name: "goal_create", source: "sdk" },
		{ name: "mcp_fs_read", source: "extension" },
		{ name: "lsp_hover", source: "npm:some-package" },
		{ name: SELECT_TOOLS_TOOL_NAME, source: "sdk" },
	];

	it("defers non-builtin/non-sdk sources, keeps builtins and sdk tools", () => {
		const { alwaysLoaded, deferrable } = partitionTools(entries, {
			never: [SELECT_TOOLS_TOOL_NAME],
		});
		assert.deepEqual(
			alwaysLoaded.map((t) => t.name),
			["read", "goal_create", SELECT_TOOLS_TOOL_NAME],
		);
		assert.deepEqual(
			deferrable.map((t) => t.name),
			["mcp_fs_read", "lsp_hover"],
		);
	});

	it("defer list force-defers a builtin; never list wins over defer list", () => {
		const p1 = partitionTools(entries, { defer: ["read"] });
		assert.ok(p1.deferrable.some((t) => t.name === "read"));
		const p2 = partitionTools(entries, { defer: ["read"], never: ["read"] });
		assert.ok(p2.alwaysLoaded.some((t) => t.name === "read"));
	});
});

describe("active-set transitions", () => {
	it("activeNamesOnEnable strips deferrable tools and appends select_tools once", () => {
		const next = activeNamesOnEnable(["read", "mcp_a", "mcp_b", "goal_create"], new Set(["mcp_a", "mcp_b"]), "select_tools");
		assert.deepEqual(next, ["read", "goal_create", "select_tools"]);
	});

	it("activeNamesOnEnable does not duplicate select_tools", () => {
		const next = activeNamesOnEnable(["read", "select_tools"], new Set(), "select_tools");
		assert.deepEqual(next, ["read", "select_tools"]);
	});

	it("activeNamesOnDisable hides select_tools only", () => {
		assert.deepEqual(activeNamesOnDisable(["read", "select_tools", "mcp_a"], "select_tools"), ["read", "mcp_a"]);
	});
});

describe("ledger", () => {
	it("foldLoadedToolNames collects addedToolNames from tool results only", () => {
		const loaded = foldLoadedToolNames([
			{ role: "user" },
			{ role: "toolResult", addedToolNames: ["mcp_a", "mcp_b"] },
			{ role: "assistant", addedToolNames: ["ignored"] },
			{ role: "toolResult" },
			{ role: "toolResult", addedToolNames: ["mcp_a", "mcp_c"] },
		]);
		assert.deepEqual([...loaded].sort(), ["mcp_a", "mcp_b", "mcp_c"]);
	});

	it("reconcileResumedActiveNames re-activates historically loaded deferrable tools", () => {
		const next = reconcileResumedActiveNames(["read", "select_tools"], new Set(["mcp_a", "mcp_b"]), new Set(["mcp_b", "gone"]));
		assert.deepEqual(next, ["read", "select_tools", "mcp_b"]);
	});

	it("reconcile is a no-op when nothing is missing", () => {
		const next = reconcileResumedActiveNames(["read", "mcp_a"], new Set(["mcp_a"]), new Set(["mcp_a"]));
		assert.deepEqual(next, ["read", "mcp_a"]);
	});
});

describe("planLoad", () => {
	const opts = { deferrable: new Set(["mcp_a", "mcp_b"]), active: new Set(["read", "select_tools"]) };

	it("splits into toLoad / alreadyAvailable / unknown", () => {
		const plan = planLoad(["mcp_b", "read", "nope", "mcp_a"], opts);
		assert.deepEqual(plan.toLoad, ["mcp_a", "mcp_b"]); // sorted
		assert.deepEqual(plan.alreadyAvailable, ["read"]);
		assert.deepEqual(plan.unknown, ["nope"]);
	});

	it("dedupes repeated names", () => {
		const plan = planLoad(["mcp_a", "mcp_a"], opts);
		assert.deepEqual(plan.toLoad, ["mcp_a"]);
	});

	it("already-loaded deferrable tools report as alreadyAvailable", () => {
		const plan = planLoad(["mcp_a"], { deferrable: opts.deferrable, active: new Set(["mcp_a"]) });
		assert.deepEqual(plan.toLoad, []);
		assert.deepEqual(plan.alreadyAvailable, ["mcp_a"]);
	});
});

describe("rendering", () => {
	it("announcement lists names in a tools_added block with guidance", () => {
		const text = renderLoadableToolsAnnouncement(["mcp_a", "mcp_b"]);
		assert.ok(text.includes("<tools_added>\nmcp_a\nmcp_b\n</tools_added>"));
		assert.ok(text.includes("select_tools"));
	});

	it("empty loadable set renders nothing", () => {
		assert.equal(renderLoadableToolsAnnouncement([]), "");
	});

	it("load result mirrors kimi output and error semantics", () => {
		const ok = renderLoadResult({ toLoad: ["mcp_a"], alreadyAvailable: ["read"], unknown: ["nope"] });
		assert.equal(ok.isError, false);
		assert.ok(ok.text.includes("Loaded: mcp_a"));
		assert.ok(ok.text.includes("Already available: read"));
		assert.ok(ok.text.includes("Unknown tool: nope"));
		const bad = renderLoadResult({ toLoad: [], alreadyAvailable: [], unknown: ["nope"] });
		assert.equal(bad.isError, true);
	});
});
