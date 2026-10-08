/**
 * Live-session read RPCs: workflows.list, subagents.live, changes.ops.
 *
 * A fresh session is genuinely created because all three answer about a live
 * session; the alternative — a stubbed host — would not prove the routes reach
 * the real recorder, progress map, and journal at all. Per the repo's test
 * isolation rule the agent dir is redirected for the whole suite: session
 * creation writes transcripts, and a bare temp cwd only changes the slug, not
 * the root those writes land under.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

let isolatedDir: string;

beforeAll(async () => {
	isolatedDir = await isolateAgentDirForTest("daemon-live-reads-");
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedDir);
}, 30_000);

/** One JSON-RPC call at a time against a freshly started daemon. */
async function withDaemon<T>(fn: (rpc: (method: string, params: unknown) => Promise<any>) => Promise<T>): Promise<T> {
	const daemon = await startDaemon({
		socketPath: path.join(os.tmpdir(), `daemon-live-${crypto.randomUUID()}.sock`),
		wsPort: 0,
	});
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
		await new Promise(r => ws.addEventListener("open", r, { once: true }));
		let nextId = 1;
		const rpc = (method: string, params: unknown): Promise<any> =>
			new Promise(resolve => {
				ws.addEventListener("message", ev => resolve(JSON.parse((ev as MessageEvent).data as string)), {
					once: true,
				});
				ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }));
			});
		const out = await fn(rpc);
		ws.close();
		return out;
	} finally {
		await daemon.close();
	}
}

describe("live-session read RPCs", () => {
	test("workflows.list answers a live session that never fanned out with an empty list", async () => {
		await withDaemon(async rpc => {
			const created = await rpc("session.create", {});
			const sessionId = created.result.sessionId as string;
			expect(sessionId).toBeTruthy();
			const res = await rpc("workflows.list", { sessionId });
			// Live and empty is the honest answer, and it differs in shape from
			// an unattached session's `live: false` — a board must know whether
			// nothing ran or nothing is watching.
			expect(res.result).toEqual({ runs: [], live: true });
		});
	});

	test("workflows.list reports an unattached session as not live", async () => {
		await withDaemon(async rpc => {
			const res = await rpc("workflows.list", { sessionId: "never-existed" });
			expect(res.result).toEqual({ runs: [], live: false });
		});
	});

	test("subagents.live answers a fresh session with nothing running", async () => {
		await withDaemon(async rpc => {
			const created = await rpc("session.create", {});
			const sessionId = created.result.sessionId as string;
			const res = await rpc("subagents.live", { sessionId });
			expect(res.result).toEqual({ agents: [] });
		});
	});

	test("changes.ops reads the full window from a live session", async () => {
		await withDaemon(async rpc => {
			const created = await rpc("session.create", {});
			const sessionId = created.result.sessionId as string;
			// afterSeq 0 = "everything since the beginning". A fresh session has
			// no journal records yet, and an empty answer here must not be
			// reported as a resync: resync is reserved for a watermark that
			// skipped past a compaction, and 0 is below every compaction.
			const res = await rpc("changes.ops", { sessionId, afterSeq: 0 });
			expect(res.result.events).toEqual([]);
			expect(res.result.resyncRequired).toBe(false);
			expect(res.result.lastSeq).toBe(0);
		});
	});

	test("changes.ops rejects a watermark ahead of the journal", async () => {
		await withDaemon(async rpc => {
			const created = await rpc("session.create", {});
			const sessionId = created.result.sessionId as string;
			// A client whose cursor runs ahead of every real seq would otherwise
			// have its gate skip every future record forever.
			const res = await rpc("changes.ops", { sessionId, afterSeq: 999_999 });
			expect(res.result.resyncRequired).toBe(true);
		});
	});

	test("the three routes require a sessionId where one is expected", async () => {
		await withDaemon(async rpc => {
			for (const method of ["workflows.list", "subagents.live", "changes.ops"]) {
				const res = await rpc(method, {});
				expect(res.result.error, `${method} must refuse a missing sessionId`).toBe("sessionId required");
			}
		});
	});
});
