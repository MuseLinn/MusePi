/**
 * History-resume freshness: a checkpoint-less journal that missed records
 * must not stand in for a newer SDK transcript.
 *
 * Failure mode (real session): the daemon journal held a single stale
 * record (async-write loss / cross-instance rewrite) while the SDK file
 * kept the full transcript. Resume served the 1-record replay because
 * `events.length > 0`, the complete SDK fallback never ran, and the GUI
 * showed a fragment forever (no past-hole healing exists client-side).
 *
 * Contract: with no checkpoint, when the SDK tail is strictly newer than
 * the newest journal record, resume serves the SDK projection (advisor
 * cards and all). Ties and unreadable tails keep the journal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonSessionHost, JOURNAL_DIR } from "../../src/daemon/session-host";
import { computeDefaultSessionDir } from "../../src/session/session-paths";
import { FileSessionStorage } from "../../src/session/session-storage";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

function linesFor(sessionId: string, base: number): string[] {
	const ids = [crypto.randomBytes(4).toString("hex"), crypto.randomBytes(4).toString("hex")];
	const cardId = crypto.randomBytes(4).toString("hex");
	const iso = (t: number): string => new Date(t).toISOString();
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: iso(base),
		cwd: "/tmp/x",
	};
	return [
		JSON.stringify(header),
		JSON.stringify({
			type: "message",
			id: ids[0],
			parentId: null,
			timestamp: iso(base),
			message: {
				role: "user",
				content: [{ type: "text", text: "first question" }],
				timestamp: base,
			},
		}),
		JSON.stringify({
			type: "message",
			id: ids[1],
			parentId: ids[0],
			timestamp: iso(base + 1000),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "full reply" }],
				timestamp: base + 1000,
			},
		}),
		JSON.stringify({
			type: "custom_message",
			customType: "advisor",
			content: '<advisory severity="nit">note</advisory>',
			display: true,
			details: { notes: [{ note: "note", severity: "nit" }] },
			attribution: "agent",
			id: cardId,
			parentId: ids[1],
			timestamp: iso(base + 2000),
		}),
	];
}

describe("history resume prefers a fresher SDK transcript over a thin journal", () => {
	let isolatedAgentDir = "";
	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("daemon-resume-freshness-");
	});
	afterAll(async () => {
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30000);

	test("stale single-record journal + newer SDK file serves the SDK content", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resume-freshness-"));
		const sessionId = crypto.randomUUID();
		const base = Date.now();
		// SDK transcript: the complete session (user + reply + advisor card).
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		await fs.promises.mkdir(sessionDir, { recursive: true });
		const iso = new Date(base).toISOString().replace(/[:.]/g, "-");
		const sdkFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
		await fs.promises.writeFile(sdkFile, `${linesFor(sessionId, base).join("\n")}\n`);
		// Journal: a single record 10 minutes older — the frozen-tail shape.
		const journalFile = path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`);
		const staleTs = new Date(base - 600_000).toISOString();
		await fs.promises.mkdir(path.dirname(journalFile), { recursive: true });
		await fs.promises.writeFile(
			journalFile,
			`${JSON.stringify({ seq: 7, ts: staleTs, event: { type: "notice", level: "info", message: "boot" } })}\n`,
		);
		const host = new DaemonSessionHost({ cwd: tmp });
		try {
			const snap = await host.snapshot(sessionId);
			const entries = snap.entries as Array<{
				type: string;
				customType?: string;
				message?: { role?: string };
			}>;
			const roles = entries.map(e => (e.type === "message" ? e.message?.role : `${e.type}:${e.customType ?? ""}`));
			expect(roles).toContain("assistant");
			expect(entries.some(e => e.type === "custom_message" && e.customType === "advisor")).toBe(true);
		} finally {
			await fs.promises.rm(journalFile, { force: true });
			await fs.promises.rm(`${journalFile}.checkpoint.json`, { force: true });
			await fs.promises.rm(sdkFile, { force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		}
	}, 20_000);

	test("journal and SDK tied on time keeps serving the journal", async () => {
		// Same setup, but the SDK tail carries exactly the journal record's
		// timestamp: bursts share milliseconds, so ties stay on the journal.
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resume-freshness-"));
		const sessionId = crypto.randomUUID();
		const base = Date.now();
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		await fs.promises.mkdir(sessionDir, { recursive: true });
		const iso = new Date(base).toISOString().replace(/[:.]/g, "-");
		const sdkFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
		await fs.promises.writeFile(sdkFile, `${linesFor(sessionId, base).join("\n")}\n`);
		const journalFile = path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`);
		await fs.promises.mkdir(path.dirname(journalFile), { recursive: true });
		// Journal newest record shares the SDK tail timestamp exactly.
		const tailTs = new Date(base + 2000).toISOString();
		await fs.promises.writeFile(
			journalFile,
			`${JSON.stringify({ seq: 1, ts: tailTs, event: { type: "notice", level: "info", message: "boot" } })}\n`,
		);
		const host = new DaemonSessionHost({ cwd: tmp });
		try {
			const snap = await host.snapshot(sessionId);
			const entries = snap.entries as Array<{ type: string }>;
			// Journal replay wins the tie: a lone notice, no SDK user message.
			expect(entries.some(e => e.type === "message")).toBe(false);
		} finally {
			await fs.promises.rm(journalFile, { force: true });
			await fs.promises.rm(`${journalFile}.checkpoint.json`, { force: true });
			await fs.promises.rm(sdkFile, { force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		}
	}, 20_000);

	test("stale persisted snapshot + newer advisor transcript serves the completed reply", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "resume-freshness-store-"));
		const sessionId = crypto.randomUUID();
		const base = Date.now();
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		await fs.promises.mkdir(sessionDir, { recursive: true });
		const iso = new Date(base).toISOString().replace(/[:.]/g, "-");
		const sdkFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
		await fs.promises.writeFile(sdkFile, `${linesFor(sessionId, base).join("\n")}\n`);
		const host = new DaemonSessionHost({ cwd: tmp });
		try {
			host.viewStore.upsert(sessionId, {
				header: { type: "session", id: sessionId, timestamp: new Date(base).toISOString(), cwd: tmp },
				entries: [
					{
						type: "message",
						id: `user:${base}`,
						parentId: null,
						timestamp: new Date(base).toISOString(),
						message: { role: "user", content: [{ type: "text", text: "first question" }], timestamp: base },
					},
				],
				state: { isStreaming: false, queuedMessageCount: 0, cwd: tmp, participants: [] },
				agents: [],
				cursor: 1,
			});

			const snap = await host.snapshot(sessionId);
			const entries = snap.entries as Array<{ type: string; message?: { role?: string; stopReason?: string } }>;
			expect(entries.some(e => e.type === "message" && e.message?.role === "assistant")).toBe(true);
		} finally {
			host.dispose();
			await fs.promises.rm(sdkFile, { force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		}
	}, 20_000);
});
