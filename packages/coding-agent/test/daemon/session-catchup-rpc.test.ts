import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@musepi/pi-wire";
import { AppendJournal } from "../../src/daemon/journal";
import { type DaemonConnection, DaemonServer, DaemonSessionHost } from "../../src/daemon/server";

/**
 * session.catchup RPC contract (roadmap M1.4 gap fill), split by layer:
 *
 * - RPC layer (mock host, session-jobs-rpc pattern): input validation
 *   (sessionId required, afterSeq a non-negative integer) and delegation —
 *   the handler passes (sessionId, afterSeq, conn) to the host and returns
 *   its verdict verbatim, so both `{ok}` and `{resyncRequired}` reach the
 *   client unchanged.
 * - Replay layer (real host + temp-dir journal, no daemon dir involved):
 *   `replayCatchup` pushes every record with seq > afterSeq through the
 *   connection's batcher IN JOURNAL ORDER as kind:"event" envelopes carrying
 *   the journal seq — the exact space the client watermark gate compares.
 *   Regression: reordered/renumbered replay corrupts the gate's decisions.
 * - Guard layer: the pure catchupPlan tests live in journal.test.ts.
 */

const SESSION = "catchup-s1";

function event(n: number): AgentEvent {
	return { type: "thinking_level_changed", thinkingLevel: `lvl-${n}` } as unknown as AgentEvent;
}

/** Conn mock whose send() records frames for assertion. */
function captureConn(): { conn: DaemonConnection; frames: () => { seq: number; payload: unknown }[] } {
	const sent: unknown[] = [];
	const conn = {
		id: "catchup-test",
		writableLength: () => 0,
		send: (m: unknown) => {
			sent.push(m);
		},
	} as unknown as DaemonConnection;
	return {
		conn,
		frames: () =>
			sent.flatMap(m => {
				const frame = m as { kind?: string; events?: { seq: number; payload: unknown }[] };
				return frame?.kind === "batch" && Array.isArray(frame.events) ? frame.events : [];
			}),
	};
}

describe("session.catchup RPC (validation + delegation)", () => {
	test("rejects missing sessionId / non-integer / negative afterSeq", async () => {
		const host = {
			cwd: () => "/tmp",
			catchupFrom: () => Promise.resolve({ ok: true }),
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const { conn } = captureConn();
		await expect(server.handle("session.catchup", { afterSeq: 1 }, conn)).rejects.toThrow("sessionId required");
		await expect(server.handle("session.catchup", { sessionId: SESSION, afterSeq: -1 }, conn)).rejects.toThrow(
			"afterSeq must be a non-negative integer",
		);
		await expect(server.handle("session.catchup", { sessionId: SESSION, afterSeq: 1.5 }, conn)).rejects.toThrow(
			"afterSeq must be a non-negative integer",
		);
	});

	test("passes (sessionId, afterSeq, conn) to the host and returns its verdict verbatim", async () => {
		// Contract: the client's gap recovery acts on the daemon's verdict —
		// a wrapped/altered response would make the store buffer forever or
		// resync spuriously.
		const calls: unknown[] = [];
		const host = {
			cwd: () => "/tmp",
			catchupFrom: (sessionId: string, afterSeq: number, conn: DaemonConnection) => {
				calls.push([sessionId, afterSeq, conn.id]);
				return Promise.resolve({ resyncRequired: true, compactedThrough: 5 });
			},
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const { conn } = captureConn();
		const result = (await server.handle("session.catchup", { sessionId: SESSION, afterSeq: 3 }, conn)) as {
			resyncRequired?: boolean;
			compactedThrough?: number;
		};
		expect(calls).toEqual([[SESSION, 3, "catchup-test"]]);
		expect(result).toEqual({ resyncRequired: true, compactedThrough: 5 });
	});
});

describe("session.catchup replay (real host, temp journal)", () => {
	const dirs: string[] = [];
	let host: DaemonSessionHost;

	function tempDir(): string {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-replay-test-"));
		dirs.push(d);
		return d;
	}

	beforeEach(() => {
		host = new DaemonSessionHost();
	});

	afterEach(() => {
		host.dispose();
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	test("journal seq 1..10, afterSeq=7 → pushes 8,9,10 in order with payloads", async () => {
		const dir = tempDir();
		const j = new AppendJournal(dir, SESSION);
		await j.open();
		for (let i = 1; i <= 10; i++) j.append(event(i));
		await j.close();

		const { conn, frames } = captureConn();
		const result = await host.replayCatchup(SESSION, 7, j, conn);
		expect(result).toEqual({ ok: true });
		const pushed = frames();
		expect(pushed.map(e => e.seq)).toEqual([8, 9, 10]);
		expect(pushed.map(e => (e.payload as { thinkingLevel: string }).thinkingLevel)).toEqual([
			"lvl-8",
			"lvl-9",
			"lvl-10",
		]);
	});

	test("afterSeq at the tail pushes nothing and still answers ok", async () => {
		const dir = tempDir();
		const j = new AppendJournal(dir, SESSION);
		await j.open();
		for (let i = 1; i <= 3; i++) j.append(event(i));
		await j.close();

		const { conn, frames } = captureConn();
		const result = await host.replayCatchup(SESSION, 3, j, conn);
		expect(result).toEqual({ ok: true });
		expect(frames()).toEqual([]);
	});
});
