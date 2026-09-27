import { describe, expect, it } from "bun:test";
import { type DockOpens, dockKey, isDockOpen, setDockOpen, toggleDockOpen } from "../src/lib/terminal-dock-state";

/**
 * Contracts the dock render depends on: a session whose dock was never opened
 * must read closed (ChatView then never mounts TerminalPanel → no unprompted
 * daemon pties), open state must be scoped per session (switching sessions
 * follows the target session), and the welcome/empty state (null id) must not
 * leak into real sessions.
 */
describe("terminal dock per-session open set", () => {
	it("reads closed for a session whose dock was never opened", () => {
		expect(isDockOpen(new Set(), "s1")).toBe(false);
	});

	it("scopes open state per session: opening one session leaves others closed", () => {
		const opens = setDockOpen(setDockOpen(new Set<string>(), "a", true), "b", true);
		expect(isDockOpen(opens, "a")).toBe(true);
		expect(isDockOpen(opens, "b")).toBe(true);
		expect(isDockOpen(opens, "c")).toBe(false);
	});

	it("closing one session does not disturb another session's open state", () => {
		const opened = setDockOpen(setDockOpen(new Set<string>(), "a", true), "b", true);
		const closed = setDockOpen(opened, "a", false);
		expect(isDockOpen(closed, "a")).toBe(false);
		expect(isDockOpen(closed, "b")).toBe(true);
	});

	it("toggle flips only the target session across open → close", () => {
		let opens: DockOpens = new Set();
		opens = toggleDockOpen(opens, "a");
		expect(isDockOpen(opens, "a")).toBe(true);
		opens = toggleDockOpen(opens, "a");
		expect(isDockOpen(opens, "a")).toBe(false);
		expect(isDockOpen(opens, "b")).toBe(false);
	});

	it("the welcome/empty-state bucket (null id) never leaks into real sessions", () => {
		const opens = setDockOpen(new Set<string>(), null, true);
		expect(isDockOpen(opens, null)).toBe(true);
		expect(isDockOpen(opens, "a")).toBe(false);
	});

	it("setting the state a session already has returns the same set (stable React state identity)", () => {
		const opens = setDockOpen(new Set<string>(), "a", true);
		expect(setDockOpen(opens, "a", true)).toBe(opens);
		expect(setDockOpen(opens, "b", false)).toBe(opens);
	});

	it("buckets null and real session ids under the documented keys", () => {
		expect(dockKey(null)).toBe("");
		expect(dockKey("s1")).toBe("s1");
	});
});
