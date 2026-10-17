/**
 * session.retitle contract (openchamber SessionAiRename parity):
 *  - unknown session id rejects ("Unknown session");
 *  - a session with no user message answers { ok: false, reason: "empty" };
 *  - a session whose title model is unavailable answers
 *    { ok: false, reason: "generation-failed" } (test daemons carry no
 *    model credentials, so this is the deterministic headless branch);
 *  the success path (real title + setSessionName "user") needs a live
 *  model and is verified against the running app, not here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";
import { computeDefaultSessionDir } from "../../src/session/session-paths";
import { FileSessionStorage } from "../../src/session/session-storage";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

type RpcCall = (method: string, params?: unknown) => Promise<unknown>;

function makeRpc(ws: WebSocket): RpcCall {
	let nextId = 1;
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	ws.addEventListener("message", ev => {
		const msg = JSON.parse((ev as MessageEvent).data as string) as {
			id?: number;
			error?: { message: string };
			result?: unknown;
		};
		if (msg.id !== undefined && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id)!;
			pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message));
			else resolve(msg.result);
		}
	});
	return (method: string, params?: unknown): Promise<unknown> => {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return promise;
	};
}

async function openWs(port: number): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("ws connect failed")), {
			once: true,
		});
	});
	return ws;
}

async function writeSdkSession(
	tmp: string,
	sessionId: string,
	records: { role: string; ts: number; text: string }[],
): Promise<{ sessionDir: string; file: string }> {
	const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
	const iso = new Date().toISOString().replace(/[:.]/g, "-");
	const file = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd: tmp,
	};
	const ids = records.map(() => crypto.randomBytes(4).toString("hex"));
	const lines = records.map((r, i) =>
		JSON.stringify({
			type: "message",
			id: ids[i],
			parentId: i > 0 ? ids[i - 1] : null,
			timestamp: new Date(r.ts).toISOString(),
			message: {
				role: r.role,
				timestamp: r.ts,
				content: [{ type: "text", text: r.text }],
			},
		}),
	);
	await fs.promises.writeFile(file, `${JSON.stringify(header)}\n${lines.join("\n")}\n`);
	return { sessionDir, file };
}

describe("session.retitle", () => {
	const cleanup: (() => Promise<void>)[] = [];
	let isolatedAgentDir = "";
	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("daemon-retitle-agent-");
	});
	afterAll(async () => {
		for (const fn of cleanup.reverse()) await fn();
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30000);

	async function boot(): Promise<RpcCall> {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-retitle-"));
		const daemon = await startDaemon({
			socketPath: path.join(tmp, "d.sock"),
			wsPort: 0,
			cwd: tmp,
		});
		cleanup.push(async () => {
			await daemon.close();
		});
		const ws = await openWs(daemon.wsPort!);
		cleanup.push(async () => {
			ws.close();
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});
		return makeRpc(ws);
	}

	test("unknown session rejects", async () => {
		const call = await boot();
		await expect(call("session.retitle", { sessionId: crypto.randomUUID() })).rejects.toThrow("Unknown session");
	}, 20000);

	test("session with no user message answers empty", async () => {
		const call = await boot();
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-retitle-sdk-"));
		const sessionId = crypto.randomUUID();
		const t = Date.now();
		const { sessionDir } = await writeSdkSession(tmp, sessionId, [
			{ role: "assistant", ts: t, text: "orphan reply" },
		]);
		cleanup.push(async () => {
			await fs.promises.rm(sessionDir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});
		const res = (await call("session.retitle", { sessionId })) as {
			ok: boolean;
			reason?: string;
		};
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("empty");
	}, 20000);

	test("user message without a title model answers generation-failed", async () => {
		const call = await boot();
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-retitle-sdk-"));
		const sessionId = crypto.randomUUID();
		const t = Date.now();
		const { sessionDir } = await writeSdkSession(tmp, sessionId, [
			{ role: "user", ts: t, text: "name this session about databases" },
			{ role: "assistant", ts: t + 1, text: "sure" },
		]);
		cleanup.push(async () => {
			await fs.promises.rm(sessionDir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});
		const res = (await call("session.retitle", { sessionId })) as {
			ok: boolean;
			reason?: string;
		};
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("generation-failed");
	}, 20000);
});
