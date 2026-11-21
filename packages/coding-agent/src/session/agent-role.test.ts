import { describe, expect, it } from "bun:test";
import { agentRoleOf, DEFAULT_AGENT_ROLE } from "./agent-role";

describe("agentRoleOf", () => {
	it("puts a main session in the coder lane", () => {
		expect(agentRoleOf({})).toEqual({ id: "coder" });
		expect(agentRoleOf(null)).toEqual(DEFAULT_AGENT_ROLE);
		expect(agentRoleOf(undefined)).toEqual(DEFAULT_AGENT_ROLE);
	});

	it("falls back to coder for a session recorded before roles existed", () => {
		// A persisted row with no identity facts: no subagent/advisor flag and
		// no agent definition name.
		expect(agentRoleOf({ subagent: false, agentName: undefined })).toEqual({ id: "coder" });
	});

	it("keeps a subagent's own definition name instead of calling it coder", () => {
		expect(agentRoleOf({ subagent: true, agentName: "sonic" })).toEqual({ id: "subagent", name: "sonic" });
	});

	it("still reports a subagent whose definition name has not been scanned", () => {
		expect(agentRoleOf({ subagent: true })).toEqual({ id: "subagent" });
	});

	it("labels an advisor transcript as the advisor, never as coder or a task subagent", () => {
		// The disk scan marks advisor transcripts as both child transcripts and
		// advisor records; the advisor reading wins.
		expect(agentRoleOf({ subagent: true, advisor: true })).toEqual({ id: "advisor" });
		expect(agentRoleOf({ advisor: true, agentName: "sonic" })).toEqual({ id: "advisor" });
	});

	it("does not hand out the shared default object", () => {
		const role = agentRoleOf({});
		role.id = "advisor";
		expect(DEFAULT_AGENT_ROLE.id).toBe("coder");
		expect(agentRoleOf({}).id).toBe("coder");
	});
});
