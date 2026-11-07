import { describe, expect, it } from "bun:test";
import { subagentSessionTitle } from "@musepi/pi-coding-agent/task/label";

/**
 * A spawned subagent's session title and roster name: the caller's spawn label
 * (`name`), else the agent id. Never the agent *type* ("task") — that is the
 * definition name every unnamed spawn would otherwise share.
 */
describe("subagentSessionTitle", () => {
	it("prefers the spawn label", () => {
		expect(subagentSessionTitle("Alice", "Alice")).toBe("Alice");
		expect(subagentSessionTitle("Alice", "selene-1")).toBe("Alice");
	});

	it("falls back to the agent id when the caller supplied no label", () => {
		expect(subagentSessionTitle(undefined, "SwiftFalcon")).toBe("SwiftFalcon");
	});

	it("ignores a blank label instead of titling the session with whitespace", () => {
		expect(subagentSessionTitle("   ", "Bob")).toBe("Bob");
	});
});
