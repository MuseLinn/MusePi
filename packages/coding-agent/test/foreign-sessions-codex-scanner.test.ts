import { describe, expect, it } from "vitest";
import { listAllCodexSessions, listCodexSessions } from "../src/foreign-sessions/codex-scanner.ts";

describe("codex-scanner", () => {
	it("exports listCodexSessions function", () => {
		expect(typeof listCodexSessions).toBe("function");
	});

	it("exports listAllCodexSessions function", () => {
		expect(typeof listAllCodexSessions).toBe("function");
	});

	it("returns empty array for nonexistent cwd", () => {
		const sessions = listCodexSessions("/nonexistent/path");
		expect(sessions).toEqual([]);
	});

	it("listAllCodexSessions returns empty array by default", () => {
		const all = listAllCodexSessions();
		expect(Array.isArray(all)).toBe(true);
	});
});
