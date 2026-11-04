/**
 * Contract: delegation guidance is owned by the `delegation` bundled plugin,
 * gated on the active task tool, and released with the plugin. The rendering
 * preserves the existing eager/codex/batch/concurrency/scout/IRC variants.
 */
import { describe, expect, it } from "bun:test";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import { PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/orders";
import { DELEGATION_PROMPT_OWNER, registerDelegationPrompts } from "../src/bundled-plugins/delegation/prompts";

function install(): { host: PromptHost; dispose: () => void } {
	const host = new PromptHost();
	return { host, dispose: registerDelegationPrompts(host) };
}

function render(context: Record<string, unknown> = {}, activeTools: readonly string[] = ["task"]): string {
	const { host } = install();
	return host.assemble({ activeTools, context }).sections[0]?.text ?? "";
}

describe("delegation plugin prompt", () => {
	it("registers tool:task at the tool anchor under the plugin owner", () => {
		const { host } = install();
		expect(host.assemble({ activeTools: ["task"] }).sections[0]).toMatchObject({
			name: "tool:task",
			order: PROMPT_ORDERS.tool,
			owner: DELEGATION_PROMPT_OWNER,
		});
	});

	it("omits the section while task is inactive", () => {
		const { host } = install();
		expect(host.assemble({ activeTools: [] }).sections).toEqual([]);
		expect(host.assemble({ activeTools: ["read"] }).sections).toEqual([]);
	});

	it("renders the base policy, own-decomposition gate and dependency rule", () => {
		const text = render();
		expect(text).toContain("# Delegation");
		expect(text).toContain(
			"- User says `parallel` or `parallelize` → MUST use `task` subagents; parallel tool calls insufficient.",
		);
		expect(text).toContain("Map unknown code via `task`");
		expect(text).toContain("## Delegation gates");
		expect(text).toContain("**Own decomposition.**");
		expect(text).toContain("NEVER outsource top-level plan");
		expect(text).toContain("**Real concurrency.**");
		expect(text).toContain("**User intent.**");
		expect(text).toContain("**Dependencies only.**");
		expect(text).toContain("shared prerequisite inline, then fan out");
	});

	it("renders the codex and eager policy variants without stacking them", () => {
		const codex = render({ useCodexTaskPrompt: true });
		expect(codex).toContain("No subagents unless user or applicable AGENTS.md/skill explicitly requests subagents");
		expect(codex).not.toContain("Delegation preferred.");
		expect(codex).not.toContain("Delegation default.");

		const proactive = render({ useCodexTaskPrompt: true, eagerTasks: true });
		expect(proactive).toContain("Proactive multi-agent delegation active;");
		expect(proactive).not.toContain("No subagents unless");

		const preferred = render({ eagerTasks: true, eagerTasksAlways: false });
		expect(preferred).toContain("Delegation preferred.");
		expect(preferred).not.toContain("Delegation default.");

		const always = render({ eagerTasks: true, eagerTasksAlways: true });
		expect(always).toContain("Delegation default.");
		expect(always).not.toContain("Delegation preferred.");
	});

	it("renders the batch call shape and concurrency cap", () => {
		const batched = render({ taskBatch: true, MAX_CONCURRENCY: 3 });
		expect(batched).toContain("one `tasks[]` array");
		expect(batched).toContain("`tasks[]` batch > 3 delays results");
		expect(batched).toContain("At most 3 subagents concurrently");

		const parallel = render({ taskBatch: false, MAX_CONCURRENCY: 1 });
		expect(parallel).toContain("parallel calls in one message");
		expect(parallel).toContain("Parallel `task` calls > 1 delays results");
		expect(parallel).toContain("At most 1 subagent concurrently");

		expect(render({ MAX_CONCURRENCY: 0 })).not.toContain("**Cap:**");
	});

	it("renders the scout and IRC gates only when enabled", () => {
		expect(render({ scoutAvailable: true })).toContain("one read-only scout while working is allowed");
		expect(render({ scoutAvailable: false })).not.toContain("read-only scout");
		expect(render({ taskIrcEnabled: true })).toContain("B asks A via `hub`!");
		expect(render({ taskIrcEnabled: false })).not.toContain("`hub`");
	});

	it("removes the section when the registration is disposed", () => {
		const { host, dispose } = install();
		dispose();
		expect(host.assemble({ activeTools: ["task"] }).sections).toEqual([]);
	});

	it("removes the section when the owner is released", () => {
		const { host } = install();
		host.removeByOwner(DELEGATION_PROMPT_OWNER);
		expect(host.assemble({ activeTools: ["task"] }).sections).toEqual([]);
	});
});
