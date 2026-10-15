import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "../extensibility/extensions/runner";
import type { ToolSession } from "../tools/index";
import { resolveEffectiveSubagentPolicy } from "./structured-subagent";

/**
 * Extension-registered subagent types: registration validation on the real
 * runner (constructed with null collaborators — registration touches none
 * of them), plus resolution precedence through
 * `resolveEffectiveSubagentPolicy` with a stub session.
 */
function testRunner(): ExtensionRunner {
	return new ExtensionRunner([], null as never, "/tmp", null as never, null as never);
}

function def(name: string): { name: string; description: string; systemPrompt: string } {
	return { name, description: `${name} reviewer`, systemPrompt: `You review ${name}.` };
}

function stubSettings(entries: Array<[string, unknown]> = []): Record<string, unknown> {
	const store = new Map<string, unknown>([
		["task.maxRecursionDepth", 2],
		["task.disabledAgents", []],
		["task.agentModelOverrides", {}],
		["task.isolation.mode", "none"],
		["async.enabled", false],
		...entries,
	]);
	return {
		get: (key: string) => store.get(key),
		getModelRole: () => "",
	};
}

function stubSession(extra: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp/musepi-registered-agents-test",
		taskDepth: 0,
		getSessionSpawns: () => "*",
		settings: stubSettings(),
		...extra,
	} as unknown as ToolSession;
}

describe("registerSubagent", () => {
	it("validates names and required text", () => {
		const runner = testRunner();
		expect(() => runner.registerSubagent({ ...def(""), description: "d", systemPrompt: "s" })).toThrow(
			/non-empty name/,
		);
		expect(() => runner.registerSubagent({ ...def("x"), description: "  " })).toThrow(/description/);
		expect(() => runner.registerSubagent({ ...def("x"), systemPrompt: "" })).toThrow(/systemPrompt/);
		expect(() => runner.registerSubagent({ ...def("x"), tools: "read" as unknown as string[] })).toThrow(
			/must be an array/,
		);
	});

	it("stores source extension and replaces on re-register", () => {
		const runner = testRunner();
		expect(runner.registerSubagent(def("rev"))).toEqual({ name: "rev" });
		expect(runner.listRegisteredSubagents()).toMatchObject([{ name: "rev", source: "extension" }]);
		runner.registerSubagent({ ...def("rev"), systemPrompt: "v2" });
		expect(runner.listRegisteredSubagents()).toHaveLength(1);
		expect(runner.listRegisteredSubagents()[0]?.systemPrompt).toBe("v2");
		expect(runner.unregisterSubagent("rev")).toBe(true);
		expect(runner.unregisterSubagent("rev")).toBe(false);
		expect(runner.listRegisteredSubagents()).toEqual([]);
	});
});

describe("resolveEffectiveSubagentPolicy with registered types", () => {
	it("resolves a registered-only name with extension source", async () => {
		const runner = testRunner();
		runner.registerSubagent(def("registered-reviewer-xyz"));
		const session = stubSession({
			extensionRunner: runner,
		});
		const policy = await resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "task",
			assignment: "review this",
			agent: "registered-reviewer-xyz",
		});
		expect(policy.agent.name).toBe("registered-reviewer-xyz");
		expect(policy.agent.source).toBe("extension");
	});

	it("prefers registered types over same-named files and lists them when unknown", async () => {
		const runner = testRunner();
		runner.registerSubagent(def("task"));
		const session = stubSession({ extensionRunner: runner });
		const policy = await resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "task",
			assignment: "x",
			agent: "task",
		});
		// "task" is also a bundled agent; the explicit registration wins.
		expect(policy.agent.source).toBe("extension");

		await expect(
			resolveEffectiveSubagentPolicy({
				session: stubSession(),
				invocationKind: "task",
				assignment: "x",
				agent: "no-such-agent-xyz",
			}),
		).rejects.toThrow(/Unknown agent/);
	});

	it("applies disabledAgents to registered types", async () => {
		const runner = testRunner();
		runner.registerSubagent(def("gated-xyz"));
		const session = stubSession({
			extensionRunner: runner,
			settings: stubSettings([["task.disabledAgents", ["gated-xyz"]]]),
		});
		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "task",
				assignment: "x",
				agent: "gated-xyz",
			}),
		).rejects.toThrow(/disabled in settings/);
	});
});
