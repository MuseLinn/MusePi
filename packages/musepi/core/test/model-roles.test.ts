// MusePi core — model-roles parsing / resolution tests (OMP-compatible).
import assert from "node:assert";
import { describe, it } from "node:test";
import { mergeMusepiSettings } from "../src/config/schema.ts";
import {
	formatSpecForLookup,
	isModelRole,
	parseRoleModelSpec,
	resolveCandidatesForRole,
	resolveCycleOrder,
	resolveFallbackChain,
	resolveModelForRole,
} from "../src/model-roles/index.ts";

describe("parseRoleModelSpec", () => {
	it("parses provider/model without a thinking suffix", () => {
		const r = parseRoleModelSpec("anthropic/claude-sonnet-4-5");
		assert.deepStrictEqual(r, { ok: true, spec: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
	});

	it("parses provider/model:thinkingLevel", () => {
		const r = parseRoleModelSpec("anthropic/claude-sonnet-4-5:medium");
		assert.deepStrictEqual(r, {
			ok: true,
			spec: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "medium" },
		});
	});

	it("parses provider:model and provider:model:level", () => {
		assert.deepStrictEqual(parseRoleModelSpec("openai:gpt-5"), {
			ok: true,
			spec: { provider: "openai", modelId: "gpt-5" },
		});
		assert.deepStrictEqual(parseRoleModelSpec("openai:gpt-5:high"), {
			ok: true,
			spec: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
		});
	});

	it("parses a bare model id and bare model:level", () => {
		assert.deepStrictEqual(parseRoleModelSpec("claude-sonnet-4-5"), {
			ok: true,
			spec: { modelId: "claude-sonnet-4-5" },
		});
		assert.deepStrictEqual(parseRoleModelSpec("gpt-4.1-mini:low"), {
			ok: true,
			spec: { modelId: "gpt-4.1-mini", thinkingLevel: "low" },
		});
	});

	it("accepts every documented thinking level", () => {
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
			const r = parseRoleModelSpec(`p/m:${level}`);
			assert.ok(r.ok, `expected ${level} to parse`);
			assert.strictEqual(r.spec.thinkingLevel, level);
		}
	});

	it("rejects an invalid thinking suffix with a diagnostic", () => {
		const r = parseRoleModelSpec("anthropic/claude-sonnet-4-5:fast");
		assert.ok(!r.ok);
		assert.match(r.error, /invalid thinking level "fast"/);
		assert.match(r.error, /minimal/);
	});

	it("rejects empty, missing provider, and missing model id", () => {
		assert.ok(!parseRoleModelSpec("").ok);
		assert.ok(!parseRoleModelSpec("   ").ok);
		assert.ok(!parseRoleModelSpec("/model").ok);
		assert.ok(!parseRoleModelSpec("provider/").ok);
		assert.ok(!parseRoleModelSpec("provider/:high").ok);
	});

	it("rejects specs with too many segments", () => {
		assert.ok(!parseRoleModelSpec("a:b:c:d").ok);
	});

	it("trims surrounding whitespace", () => {
		const r = parseRoleModelSpec("  anthropic/claude-sonnet-4-5  ");
		assert.ok(r.ok);
		assert.strictEqual(r.spec.modelId, "claude-sonnet-4-5");
	});
});

describe("isModelRole", () => {
	it("recognizes the six built-in roles and rejects others", () => {
		for (const role of ["default", "smol", "plan", "advisor", "task", "tiny"]) {
			assert.ok(isModelRole(role), role);
		}
		assert.ok(!isModelRole("vision")); // reserved, not built-in
		assert.ok(!isModelRole("nope"));
	});
});

describe("resolveModelForRole", () => {
	it("resolves the role's own value when set", () => {
		const r = resolveModelForRole({ task: "openai/gpt-4.1-mini" }, "task");
		assert.strictEqual(r.source, "task");
		assert.deepStrictEqual(r.spec, { provider: "openai", modelId: "gpt-4.1-mini" });
		assert.deepStrictEqual(r.diagnostics, []);
	});

	it("falls back to the default role when the role is unset", () => {
		const r = resolveModelForRole({ default: "anthropic/claude-sonnet-4-5" }, "task");
		assert.strictEqual(r.source, "default");
		assert.strictEqual(r.spec?.modelId, "claude-sonnet-4-5");
	});

	it("returns undefined when the whole table is empty", () => {
		const r = resolveModelForRole({}, "task");
		assert.strictEqual(r.source, "none");
		assert.strictEqual(r.spec, undefined);
		const r2 = resolveModelForRole(undefined, "tiny");
		assert.strictEqual(r2.spec, undefined);
	});

	it("treats an invalid role value as unset and reports a diagnostic", () => {
		const r = resolveModelForRole({ task: "bad:spec:here:nope", default: "openai/gpt-5" }, "task");
		assert.strictEqual(r.source, "default");
		assert.strictEqual(r.spec?.modelId, "gpt-5");
		assert.strictEqual(r.diagnostics.length, 1);
		assert.match(r.diagnostics[0], /modelRoles\.task/);
	});

	it("reports unknown role names", () => {
		const r = resolveModelForRole({ default: "openai/gpt-5" }, "vision");
		assert.strictEqual(r.spec, undefined);
		assert.match(r.diagnostics[0], /unknown model role "vision"/);
	});
});

describe("resolveFallbackChain", () => {
	it("preserves the configured order", () => {
		const { specs, diagnostics } = resolveFallbackChain(
			{ fallbackChains: { default: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "gpt-4.1-mini:low"] } },
			"default",
		);
		assert.deepStrictEqual(diagnostics, []);
		assert.deepStrictEqual(
			specs.map(formatSpecForLookup),
			["anthropic:claude-sonnet-4-5", "openai:gpt-5", "gpt-4.1-mini"],
		);
		assert.strictEqual(specs[2].thinkingLevel, "low");
	});

	it("skips invalid entries with diagnostics and keeps going", () => {
		const { specs, diagnostics } = resolveFallbackChain(
			{ fallbackChains: { task: ["openai/gpt-5", "bad:entry:too:many", 42 as unknown as string] } },
			"task",
		);
		assert.deepStrictEqual(specs.map(formatSpecForLookup), ["openai:gpt-5"]);
		assert.strictEqual(diagnostics.length, 2);
	});

	it("returns empty for unknown roles and unset chains", () => {
		assert.deepStrictEqual(resolveFallbackChain({}, "task").specs, []);
		const r = resolveFallbackChain({}, "vision");
		assert.deepStrictEqual(r.specs, []);
		assert.match(r.diagnostics[0], /unknown model role/);
	});
});

describe("resolveCycleOrder", () => {
	it("keeps valid roles in order and drops unknown names", () => {
		const { roles, diagnostics } = resolveCycleOrder({ cycleOrder: ["smol", "default", "vision", "slow"] });
		assert.deepStrictEqual(roles, ["smol", "default"]);
		assert.strictEqual(diagnostics.length, 2);
	});

	it("returns empty when unset", () => {
		assert.deepStrictEqual(resolveCycleOrder({}).roles, []);
	});
});

describe("resolveCandidatesForRole", () => {
	it("puts the role value first, then chain entries, deduped", () => {
		const { specs } = resolveCandidatesForRole(
			{
				task: "openai/gpt-4.1-mini",
				fallbackChains: { task: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4-5"] },
			},
			"task",
		);
		assert.deepStrictEqual(specs.map(formatSpecForLookup), ["openai:gpt-4.1-mini", "anthropic:claude-sonnet-4-5"]);
	});

	it("uses the default role as primary when the role is unset", () => {
		const { specs } = resolveCandidatesForRole(
			{ default: "openai/gpt-5", fallbackChains: { task: ["anthropic/claude-sonnet-4-5"] } },
			"task",
		);
		assert.deepStrictEqual(specs.map(formatSpecForLookup), ["openai:gpt-5", "anthropic:claude-sonnet-4-5"]);
	});
});

describe("mergeMusepiSettings modelRoles", () => {
	it("defaults to a fully-empty role table", () => {
		const merged = mergeMusepiSettings(undefined);
		assert.deepStrictEqual(merged.modelRoles, {
			default: "",
			smol: "",
			plan: "",
			advisor: "",
			task: "",
			tiny: "",
			cycleOrder: [],
			fallbackChains: {},
		});
	});

	it("keeps valid role values and drops mistyped fields", () => {
		const merged = mergeMusepiSettings({
			modelRoles: {
				task: "openai/gpt-4.1-mini",
				smol: 42 as unknown as string,
				cycleOrder: ["smol", "bogus", "default"],
				fallbackChains: {
					task: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
					unknownRole: ["x"],
					smol: "not-an-array" as unknown as string[],
				},
			},
		});
		assert.strictEqual(merged.modelRoles.task, "openai/gpt-4.1-mini");
		assert.strictEqual(merged.modelRoles.smol, "");
		assert.deepStrictEqual(merged.modelRoles.cycleOrder, ["smol", "default"]);
		assert.deepStrictEqual(merged.modelRoles.fallbackChains, {
			task: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
		});
	});

	it("merged settings feed the resolvers end-to-end", () => {
		const merged = mergeMusepiSettings({
			modelRoles: { task: "openai/gpt-4.1-mini:low", fallbackChains: { task: ["openai/gpt-5"] } },
		});
		const r = resolveModelForRole(merged.modelRoles, "task");
		assert.deepStrictEqual(r.spec, { provider: "openai", modelId: "gpt-4.1-mini", thinkingLevel: "low" });
		// Unset role falls back to default → unset → undefined.
		assert.strictEqual(resolveModelForRole(merged.modelRoles, "advisor").spec, undefined);
	});
});
