/**
 * Session sheet filter: title or cwd, case-insensitive. Kept as a pure helper
 * so the mobile sheet and any future session picker cannot drift on what
 * "matching a session" means.
 */
import { describe, expect, it } from "bun:test";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { filterSessions } from "../src/components/shell/SessionsSheet";

function session(overrides: Partial<WorkspaceSessionInfo>): WorkspaceSessionInfo {
	return {
		id: "s1",
		title: null,
		cwd: null,
		messageCount: 0,
		working: false,
		paused: false,
		live: false,
		updatedAt: 0,
		...overrides,
	};
}

const sessions = [
	session({ id: "a", title: "重构移动端 Header", cwd: "/work/musepi" }),
	session({ id: "b", title: "Board widget polish", cwd: "/work/musepi" }),
	session({ id: "c", title: null, cwd: "/tmp/scratch" }),
];

describe("filterSessions", () => {
	it("returns every session for a blank query", () => {
		expect(filterSessions(sessions, "")).toHaveLength(3);
		expect(filterSessions(sessions, "   ")).toHaveLength(3);
	});

	it("matches titles case-insensitively", () => {
		expect(filterSessions(sessions, "board").map(s => s.id)).toEqual(["b"]);
		expect(filterSessions(sessions, "移动端").map(s => s.id)).toEqual(["a"]);
	});

	it("matches the working directory when the title is empty", () => {
		expect(filterSessions(sessions, "scratch").map(s => s.id)).toEqual(["c"]);
	});
});
