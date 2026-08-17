import { describe, expect, it } from "bun:test";
import {
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
} from "../src/index.ts";

describe("tool-select gate", () => {
	it("detects native deferred tools mode", () => {
		expect(modelSupportsDeferredTools({ provider: "moonshotai", id: "kimi-k3", deferredToolsMode: "kimi" })).toBe(
			true,
		);
		expect(modelSupportsDeferredTools({ provider: "openai", id: "gpt-4" })).toBe(false);
		expect(modelSupportsDeferredTools(undefined)).toBe(false);
	});

	it("checks model allowlist", () => {
		const model = { provider: "anthropic", id: "claude-4" };
		expect(modelInAllowlist(model, { models: ["claude-4"] })).toBe(true);
		expect(modelInAllowlist(model, { models: ["anthropic/claude-4"] })).toBe(true);
		expect(modelInAllowlist(model, { models: ["other-model"] })).toBe(false);
		expect(modelInAllowlist(model, undefined)).toBe(false);
	});

	it("requires both flag and model support", () => {
		const kimi = { provider: "moonshotai", id: "kimi-k3", deferredToolsMode: "kimi" };
		expect(isToolSelectEnabled(kimi, { enabled: true })).toBe(true);
		expect(isToolSelectEnabled(kimi, { enabled: false })).toBe(false);
		expect(isToolSelectEnabled(kimi, undefined)).toBe(false);
		expect(isToolSelectEnabled(undefined, { enabled: true })).toBe(false);
	});
});

describe("tool-select partition", () => {
	it("keeps builtins and always-active in active set", () => {
		const entries = [
			{ name: "read", source: "builtin" },
			{ name: "mcp_tool", source: "extension" },
		];
		const { active, deferrable } = partitionTools(entries);
		expect(active.length).toBe(1);
		expect(active[0].name).toBe("read");
		expect(deferrable.length).toBe(1);
		expect(deferrable[0].name).toBe("mcp_tool");
	});

	it("never defers core tools", () => {
		const entries = [
			{ name: "select_tools", source: "sdk" },
			{ name: "goal", source: "extension" },
		];
		const { active } = partitionTools(entries);
		expect(active.some(e => e.name === "select_tools")).toBe(true);
		expect(active.some(e => e.name === "goal")).toBe(true);
	});

	it("computes active names on enable", () => {
		const active = [
			{ name: "read", source: "builtin" },
			{ name: "bash", source: "builtin" },
		];
		const deferrable = [{ name: "mcp_gh", source: "extension" }];
		const names = activeNamesOnEnable(active, deferrable);
		expect(names).toEqual(["read", "bash"]);
	});
});

describe("tool-select ledger", () => {
	it("folds loaded tool names from history", () => {
		const loaded = foldLoadedToolNames([
			{ role: "toolResult", addedToolNames: ["mcp_fetch"] },
			{ role: "user" },
			{ role: "toolResult", addedToolNames: ["mcp_gh", "mcp_fs"] },
		]);
		expect(loaded.size).toBe(3);
		expect(loaded.has("mcp_fetch")).toBe(true);
		expect(loaded.has("mcp_gh")).toBe(true);
	});

	it("reconciles resumed active names", () => {
		const result = reconcileResumedActiveNames(new Set(["mcp_fetch"]), ["read", "bash"]);
		expect(result).toContain("mcp_fetch");
		expect(result).toContain("read");
	});
});

describe("tool-select plan", () => {
	it("splits names three ways", () => {
		const plan = planLoad(["mcp_a", "read", "unknown_tool"], {
			deferrable: new Set(["mcp_a", "mcp_b"]),
			active: new Set(["read", "bash"]),
		});
		expect(plan.toLoad).toEqual(["mcp_a"]);
		expect(plan.alreadyAvailable).toEqual(["read"]);
		expect(plan.unknown).toEqual(["unknown_tool"]);
	});
});

describe("tool-select announcements", () => {
	it("renders loadable tools", () => {
		const result = renderLoadableToolsAnnouncement(["mcp_a", "mcp_b"]);
		expect(result).toContain("mcp_a");
		expect(result).toContain("mcp_b");
		expect(result).toContain("<tools_added>");
		expect(result).toContain("</tools_added>");
	});

	it("returns empty when none loadable", () => {
		expect(renderLoadableToolsAnnouncement([])).toBe("");
	});

	it("renders load result", () => {
		const text = renderLoadResult({ toLoad: ["mcp_a"], alreadyAvailable: ["read"], unknown: [] });
		expect(text).toContain("Loaded");
		expect(text).toContain("Already available");
	});
});
