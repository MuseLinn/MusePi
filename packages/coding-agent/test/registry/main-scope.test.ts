import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry, isMainAgentId, MAIN_AGENT_ID } from "@musepi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";

/**
 * Two conversations, one process-global registry.
 *
 * Every top-level session used to claim the bare `Main` id, so opening a
 * second conversation silently replaced the first one's ref and the newer
 * session's teardown unregistered the id — the older session stayed alive but
 * unreachable (`hub send Main` → `Unknown agent "Main"`). These tests pin the
 * scoped-id contract that replaces it.
 */
function sessionStub(): AgentSession {
	return { dispose: async () => {} } as unknown as AgentSession;
}

describe("AgentRegistry — scoped main ids", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	function registerMain(): ReturnType<AgentRegistry["register"]> {
		return registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: sessionStub(),
			sessionFile: null,
			status: "running",
		});
	}

	it("keeps the bare Main id for the first live conversation", () => {
		expect(registerMain().id).toBe(MAIN_AGENT_ID);
	});

	it("re-keys a second live conversation instead of replacing the first", () => {
		const first = registerMain();
		const second = registerMain();
		expect(second.id).toBe("Main-2");
		// The original ref is untouched and still addressable by its own id.
		expect(registry.get(MAIN_AGENT_ID)).toBe(first);
		expect(registry.get("Main-2")).toBe(second);
	});

	it("keeps minting fresh ids for every further conversation", () => {
		const ids = [registerMain().id, registerMain().id, registerMain().id];
		expect(ids).toEqual([MAIN_AGENT_ID, "Main-2", "Main-3"]);
	});

	it("reuses a freed scoped slot after the previous conversation is gone", () => {
		registerMain();
		const second = registerMain();
		expect(registry.unregister(second.id, second)).toBe(true);
		expect(registerMain().id).toBe("Main-2");
	});

	it("does not mint for subagents — a repeated id is still a takeover", () => {
		const a = registry.register({ id: "alice", displayName: "task", kind: "sub", session: sessionStub() });
		const b = registry.register({ id: "alice", displayName: "task", kind: "sub", session: sessionStub() });
		expect(a.id).toBe("alice");
		expect(b.id).toBe("alice");
		expect(registry.get("alice")).toBe(b);
	});

	it("tearing down the second conversation leaves the first reachable", () => {
		const first = registerMain();
		const second = registerMain();
		registry.unregister(second.id, second);
		expect(registry.get(MAIN_AGENT_ID)).toBe(first);
	});

	it("recognises every scoped main id and nothing else", () => {
		expect(isMainAgentId(MAIN_AGENT_ID)).toBe(true);
		expect(isMainAgentId("Main-2")).toBe(true);
		expect(isMainAgentId("Mainline")).toBe(false);
		expect(isMainAgentId("alice")).toBe(false);
		expect(isMainAgentId("Sub-Main")).toBe(false);
	});

	it("resolves the root main through a nested subagent chain", () => {
		const root = registerMain();
		registry.register({ id: "alice", displayName: "task", kind: "sub", parentId: root.id, session: sessionStub() });
		registry.register({ id: "bob", displayName: "task", kind: "sub", parentId: "alice", session: sessionStub() });
		expect(registry.mainOf("bob")).toBe(root.id);
		expect(registry.mainOf(root.id)).toBe(root.id);
		expect(registry.mainOf("ghost")).toBeUndefined();
	});

	it("hides another conversation's main from a subagent roster", () => {
		const own = registerMain();
		const other = registerMain();
		registry.register({ id: "alice", displayName: "task", kind: "sub", parentId: own.id, session: sessionStub() });
		const roster = registry.listVisibleTo("alice").map(ref => ref.id);
		expect(roster).toContain(own.id);
		expect(roster).not.toContain(other.id);
	});

	it("still hides advisors and settled agents from the roster", () => {
		const own = registerMain();
		registry.register({ id: "alice", displayName: "task", kind: "sub", parentId: own.id, session: sessionStub() });
		registry.register({
			id: "bob",
			displayName: "task",
			kind: "sub",
			parentId: own.id,
			session: sessionStub(),
			status: "parked",
		});
		registry.register({
			id: "adv",
			displayName: "advisor",
			kind: "advisor",
			parentId: own.id,
			session: sessionStub(),
		});
		expect(registry.listVisibleTo("alice").map(ref => ref.id)).toEqual([own.id]);
	});
});
