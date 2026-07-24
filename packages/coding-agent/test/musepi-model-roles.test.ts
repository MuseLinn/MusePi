// MusePi model roles — host-side resolution tests.
// Covers the registry-matching glue in src/musepi/model-roles.ts and
// the swarm task-role entry point (getTaskRoleModel) which reads
// musepi.modelRoles from settings.json.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { findModelForSpec, resolveRoleFallbackModels, resolveRoleModel } from "../src/musepi/model-roles.ts";
import { getTaskRoleModel } from "../src/musepi/swarm/subagent.ts";

function fakeModel(provider: string, id: string) {
	return { provider, id, name: id } as any;
}

const AVAILABLE = [
	fakeModel("anthropic", "claude-sonnet-4-5"),
	fakeModel("openai", "gpt-5"),
	fakeModel("openai", "gpt-4.1-mini"),
	fakeModel("openrouter", "openai/gpt-oss-120b"),
];

describe("findModelForSpec", () => {
	test("matches provider+id exactly", () => {
		const m = findModelForSpec({ provider: "openai", modelId: "gpt-5" }, AVAILABLE);
		expect(m?.id).toBe("gpt-5");
	});

	test("matches a bare model id", () => {
		const m = findModelForSpec({ modelId: "claude-sonnet-4-5" }, AVAILABLE);
		expect(m?.provider).toBe("anthropic");
	});

	test("matches case-insensitively", () => {
		const m = findModelForSpec({ provider: "OpenAI", modelId: "GPT-5" }, AVAILABLE);
		expect(m?.id).toBe("gpt-5");
	});

	test("falls back to the raw value for ids containing a slash", () => {
		// "openrouter/openai/gpt-oss-120b" parses as provider=openrouter,
		// modelId=openai/gpt-oss-120b — which already matches; but a bare
		// slashy id under a different provider must still resolve.
		const m = findModelForSpec({ provider: "x", modelId: "y" }, AVAILABLE, "openai/gpt-oss-120b");
		expect(m?.provider).toBe("openrouter");
	});

	test("returns undefined for unknown models", () => {
		expect(findModelForSpec({ provider: "nope", modelId: "nada" }, AVAILABLE)).toBeUndefined();
	});
});

describe("resolveRoleModel", () => {
	test("returns undefined when the table is empty", () => {
		expect(resolveRoleModel("task", undefined, AVAILABLE)).toBeUndefined();
		expect(resolveRoleModel("task", {}, AVAILABLE)).toBeUndefined();
	});

	test("resolves the task role with a thinking suffix", () => {
		const m = resolveRoleModel("task", { task: "openai/gpt-4.1-mini:low" }, AVAILABLE);
		expect(m?.model.id).toBe("gpt-4.1-mini");
		expect(m?.thinkingLevel).toBe("low");
		expect(m?.source).toBe("task");
	});

	test("falls back to the default role", () => {
		const m = resolveRoleModel("task", { default: "anthropic/claude-sonnet-4-5" }, AVAILABLE);
		expect(m?.model.id).toBe("claude-sonnet-4-5");
		expect(m?.source).toBe("default");
	});

	test("returns undefined when the configured model is not in the registry", () => {
		expect(resolveRoleModel("task", { task: "acme/does-not-exist" }, AVAILABLE)).toBeUndefined();
	});
});

describe("resolveRoleFallbackModels", () => {
	test("orders role value first, then chain entries, deduped and registry-filtered", () => {
		const out = resolveRoleFallbackModels(
			"task",
			{
				task: "openai/gpt-4.1-mini",
				fallbackChains: { task: ["openai/gpt-4.1-mini", "acme/missing", "anthropic/claude-sonnet-4-5:medium"] },
			},
			AVAILABLE,
		);
		expect(out.map((c) => `${c.model.provider}:${c.model.id}`)).toEqual([
			"openai:gpt-4.1-mini",
			"anthropic:claude-sonnet-4-5",
		]);
		expect(out[1].thinkingLevel).toBe("medium");
	});

	test("empty when neither role nor chain is configured", () => {
		expect(resolveRoleFallbackModels("task", {}, AVAILABLE)).toEqual([]);
	});
});

describe("getTaskRoleModel (settings.json)", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "musepi-roles-"));
		process.env[ENV_AGENT_DIR] = dir;
	});
	afterEach(() => {
		delete process.env[ENV_AGENT_DIR];
		rmSync(dir, { recursive: true, force: true });
	});

	function writeSettings(value: unknown) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ musepi: { modelRoles: value } }));
	}

	test("returns provider:id[:level] when the task role is configured", () => {
		writeSettings({ task: "openai/gpt-4.1-mini:low" });
		expect(getTaskRoleModel(AVAILABLE)).toBe("openai:gpt-4.1-mini:low");
	});

	test("returns null when unconfigured → caller keeps auto-routing", () => {
		writeSettings({});
		expect(getTaskRoleModel(AVAILABLE)).toBeNull();
	});

	test("falls back to the default role", () => {
		writeSettings({ default: "anthropic/claude-sonnet-4-5" });
		expect(getTaskRoleModel(AVAILABLE)).toBe("anthropic:claude-sonnet-4-5");
	});

	test("returns null when the configured model is unknown", () => {
		writeSettings({ task: "acme/does-not-exist" });
		expect(getTaskRoleModel(AVAILABLE)).toBeNull();
	});
});
