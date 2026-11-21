import "./happy-dom-shim";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { agentDisplayName, agentRoleLabel, DEFAULT_AGENT_ROLE } from "../src/lib/surfaces/agent-role";

/**
 * The role contract's readable side. Two strings stay separate:
 *  - the agent's NAME (助手 / a subagent's definition name / 顾问), and
 *  - the LANE tag (编码 / 子代理 / 顾问) that rides beside it.
 * A lane this build does not know yet still renders from its own name/id, so a
 * later bot lane never disappears from the identity card.
 */

beforeEach(() => setLocale("zh-CN"));
afterAll(() => setLocale("en-US"));

describe("agent role readings", () => {
	it("names the workbench lane's agent and tags its coder role", () => {
		expect(agentDisplayName(DEFAULT_AGENT_ROLE)).toBe("助手");
		expect(agentRoleLabel(DEFAULT_AGENT_ROLE)).toBe("编码");
		setLocale("en-US");
		expect(agentDisplayName(DEFAULT_AGENT_ROLE)).toBe("Assistant");
		expect(agentRoleLabel(DEFAULT_AGENT_ROLE)).toBe("Coder");
	});

	it("keeps a subagent's definition name as its name and tags the subagent lane", () => {
		expect(agentDisplayName({ id: "subagent", name: "sonic" })).toBe("sonic");
		expect(agentRoleLabel({ id: "subagent", name: "sonic" })).toBe("子代理");
		// Before the definition name is scanned, the lane label stands in.
		expect(agentDisplayName({ id: "subagent" })).toBe("子代理");
	});

	it("reads an advisor transcript as the advisor, not as the coder", () => {
		expect(agentDisplayName({ id: "advisor" })).toBe("顾问");
		expect(agentRoleLabel({ id: "advisor" })).toBe("顾问");
	});

	it("reads an unknown lane from its own name or id instead of dropping it", () => {
		expect(agentDisplayName({ id: "bot", name: "MarsBot" })).toBe("MarsBot");
		expect(agentDisplayName({ id: "bot" })).toBe("助手");
		expect(agentRoleLabel({ id: "bot", name: "MarsBot" })).toBe("MarsBot");
		expect(agentRoleLabel({ id: "bot" })).toBe("bot");
	});
});
