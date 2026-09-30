import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { listSubagentSessions, resolveResumableSession } from "@musepi/pi-coding-agent/session/session-listing";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

/**
 * Sub-agent transcript listing contract: task/vibe subagents persist their
 * transcript two levels deep (`<slug>/<parentFileBase>/<subId>.jsonl`), so
 * the top-level scan never sees them. The GUI sidebar opens a child session
 * by id through `session.subscribe` → `session.resume` → global fallback —
 * which must therefore extend into the sub-agent layer, and the session id
 * the daemon hands the tree is the transcript's header id (not the filename).
 */

let agentDir: string;

function sessionLines(id: string, firstPrompt: string): string {
	return [
		JSON.stringify({
			type: "session",
			id,
			cwd: "/repo",
			title: "Subagent Fixture",
			timestamp: "2026-09-30T00:00:00.000Z",
		}),
		JSON.stringify({ type: "message", message: { role: "user", content: firstPrompt } }),
		"",
	].join("\n");
}

beforeAll(async () => {
	agentDir = await isolateAgentDirForTest("subagent-listing-");
	const root = path.join(agentDir, "sessions", "proj");
	// Parent session: one level deep, timestamped filename per convention.
	await fsp.mkdir(root, { recursive: true });
	await fsp.writeFile(path.join(root, "1730000000000_parent-id.jsonl"), sessionLines("parent-id", "parent prompt"));
	// Sub-agent transcript: two levels deep, bare <subId>.jsonl filename.
	await fsp.mkdir(path.join(root, "1730000000000_parent-id"), { recursive: true });
	await fsp.writeFile(
		path.join(root, "1730000000000_parent-id", "sub-1.jsonl"),
		sessionLines("sub-1", "child prompt"),
	);
	// Malformed transcript at the same depth must be dropped, not surfaced.
	await fsp.writeFile(path.join(root, "1730000000000_parent-id", "garbage.jsonl"), "not json at all\n");
});

afterAll(async () => {
	await restoreAgentDirForTest(agentDir);
}, 30000);

describe("sub-agent transcript listing", () => {
	it("finds two-level-deep transcripts while the parent stays out of the subagent layer", async () => {
		const subs = await listSubagentSessions();
		expect(subs.map(s => s.id)).toEqual(["sub-1"]);
		expect(subs[0]?.path.endsWith(path.join("proj", "1730000000000_parent-id", "sub-1.jsonl"))).toBe(true);
	});

	it("drops malformed transcripts instead of surfacing them as sessions", async () => {
		const subs = await listSubagentSessions();
		expect(subs.some(s => s.path.includes("garbage"))).toBe(false);
	});

	it("resolves a child session id through the global fallback (GUI sidebar open path)", async () => {
		const match = await resolveResumableSession("sub-1", "");
		expect(match?.scope).toBe("global");
		expect(match?.session.id).toBe("sub-1");
		expect(match?.session.firstMessage).toBe("child prompt");
	});

	it("does not match a sub-agent transcript when global fallback is disabled", async () => {
		// Explicit sessionDir (the daemon's per-cwd scope) with the fallback
		// gate closed: the child transcript must stay unreachable — sub-agent
		// rows are only openable through the global scan.
		const match = await resolveResumableSession("sub-1", "", path.join(agentDir, "sessions", "other"), {
			allowGlobalFallback: false,
		});
		expect(match).toBeUndefined();
	});

	it("keeps the parent session resolvable through the normal top-level scan", async () => {
		const match = await resolveResumableSession("parent-id", "");
		expect(match?.session.id).toBe("parent-id");
		expect(match?.session.path.endsWith("1730000000000_parent-id.jsonl")).toBe(true);
	});
});
