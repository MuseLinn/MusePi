import { describe, expect, it } from "bun:test";
import { runSessionsList } from "../src/cli/sessions-cli";
import type { SessionInfo } from "../src/session/session-listing";

function makeSession(overrides: Partial<SessionInfo> & { id: string; modified: Date }): SessionInfo {
	return {
		path: `C:/sessions/${overrides.id}.jsonl`,
		cwd: "C:/work/project-a",
		title: undefined,
		firstMessage: "(no messages)",
		created: new Date("2026-01-01T00:00:00Z"),
		messageCount: 1,
		size: 100,
		allMessagesText: "",
		...overrides,
	};
}

function capture(): {
	out: string[];
	stdout: { write(chunk: string): boolean };
	stderr: { write(chunk: string): boolean };
} {
	const out: string[] = [];
	return {
		out,
		stdout: {
			write: chunk => {
				out.push(chunk);
				return true;
			},
		},
		stderr: { write: () => true },
	};
}

const sessions: SessionInfo[] = [
	makeSession({ id: "aaa111", title: "Fix the bug", modified: new Date("2026-09-03T10:00:00Z") }),
	makeSession({
		id: "bbb222",
		firstMessage: "Older session",
		modified: new Date("2026-08-01T10:00:00Z"),
		status: "complete",
	}),
	makeSession({
		id: "ccc333",
		cwd: "C:/work/other",
		title: "Another project",
		modified: new Date("2026-09-02T10:00:00Z"),
	}),
];

describe("runSessionsList", () => {
	it("prints sessions newest-first with id, title and cwd", async () => {
		const cap = capture();
		const count = await runSessionsList({}, { ...cap, cwd: () => "C:/work/project-a", list: async () => sessions });
		expect(count).toBe(3);
		const rows = cap.out.filter(line => line.trim().length > 0);
		expect(rows).toHaveLength(3);
		// Newest first: bbb222 (Aug 1) is last; ccc333 (Sep 2) second; aaa111 (Sep 3) first.
		expect(rows[0]).toContain("aaa111");
		expect(rows[0]).toContain("Fix the bug");
		expect(rows[0]).toContain("2026-09-03");
		expect(rows[2]).toContain("bbb222");
	});

	it("filters to the exact cwd when --cwd is given", async () => {
		const cap = capture();
		const count = await runSessionsList(
			{ cwd: "C:/work/other" },
			{ ...cap, cwd: () => "C:/work/project-a", list: async () => sessions },
		);
		expect(count).toBe(1);
		expect(cap.out.join("")).toContain("ccc333");
		expect(cap.out.join("")).not.toContain("aaa111");
	});

	it("honors --limit", async () => {
		const cap = capture();
		const count = await runSessionsList(
			{ limit: 2 },
			{ ...cap, cwd: () => "C:/work/project-a", list: async () => sessions },
		);
		expect(count).toBe(2);
		expect(cap.out.join("")).not.toContain("bbb222");
	});

	it("emits structured JSON rows with full id, status and timestamps", async () => {
		const cap = capture();
		const count = await runSessionsList(
			{ json: true },
			{ ...cap, cwd: () => "C:/work/project-a", list: async () => sessions },
		);
		expect(count).toBe(3);
		const parsed = JSON.parse(cap.out.join("")) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toMatchObject({
			id: "aaa111",
			title: "Fix the bug",
			cwd: "C:/work/project-a",
			messageCount: 1,
		});
		expect(parsed[0]).not.toHaveProperty("status");
		expect(parsed[2].status).toBe("complete");
	});

	it("prints a friendly empty message when no sessions match", async () => {
		const cap = capture();
		const count = await runSessionsList({}, { ...cap, cwd: () => "C:/work/project-a", list: async () => [] });
		expect(count).toBe(0);
		expect(cap.out.join("")).toContain("No sessions found.");
	});
});
