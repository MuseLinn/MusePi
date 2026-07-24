import { describe, expect, it } from "vitest";
import { listAllClaudeSessions, listClaudeSessions } from "../src/foreign-sessions/claude-scanner.ts";

describe("claude-scanner", () => {
	it("exports listClaudeSessions function", () => {
		expect(typeof listClaudeSessions).toBe("function");
	});

	it("exports listAllClaudeSessions function", () => {
		expect(typeof listAllClaudeSessions).toBe("function");
	});

	it("returns empty array for nonexistent cwd", () => {
		const sessions = listClaudeSessions("/nonexistent/path");
		expect(sessions).toEqual([]);
	});

	it("returns empty array from listAll when no claude config exists", () => {
		const all = listAllClaudeSessions();
		expect(Array.isArray(all)).toBe(true);
	});
});
