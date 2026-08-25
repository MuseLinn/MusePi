/**
 * session.branchAt (TUI navigateTree parity, layer-1 session-tree nav):
 * move the session leaf IN PLACE — non-destructive (never truncates)
 * (no truncation) and unlike forkAt (no new session file). The old leaf
 * and its subtree stay reachable as a sibling branch.
 *
 *   - resolves the GUI's view key ("role:timestamp") to the SDK entry id
 *     (id-space parity — same message-key matching as forkAt);
 *   - user messages re-answer: leaf = parent, editorText backfilled;
 *   - assistant messages: leaf lands ON the node (continue from there);
 *   - returns the new leaf as a messageKey so the GUI tree can link it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AppendJournal } from "../../src/daemon/journal";
import { startDaemon } from "../../src/daemon/server";
import { ViewStore, viewStorePath } from "../../src/daemon/view-store";
import { computeDefaultSessionDir } from "../../src/session/session-paths";
import { FileSessionStorage } from "../../src/session/session-storage";

const JOURNAL_DIR = path.join(os.tmpdir(), "musepi-daemon", "journal");

interface WireMessage {
	role: string;
	timestamp: number;
	content: { type: "text"; text: string }[];
}

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
		ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
	});
	return ws;
}

interface BranchAtResult {
	ok: boolean;
	leafId: string | null;
	editorText: string | null;
}

function branchAtResult(v: unknown): BranchAtResult {
	const r = (v ?? {}) as { ok?: unknown; leafId?: unknown; editorText?: unknown };
	return {
		ok: r.ok === true,
		leafId: typeof r.leafId === "string" ? r.leafId : null,
		editorText: typeof r.editorText === "string" ? r.editorText : null,
	};
}

async function seedSession(
	tmp: string,
	sessionId: string,
	msgs: WireMessage[],
): Promise<{ sessionDir: string; parentFile: string }> {
	const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
	const iso = new Date().toISOString().replace(/[:.]/g, "-");
	const parentFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
	const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: tmp };
	const sdkLines = msgs.map(m =>
		JSON.stringify({
			type: "message",
			id: crypto.randomBytes(4).toString("hex"),
			timestamp: new Date(m.timestamp).toISOString(),
			message: m,
		}),
	);
	await fs.promises.writeFile(parentFile, `${JSON.stringify(header)}\n${sdkLines.join("\n")}\n`);
	const journal = new AppendJournal(JOURNAL_DIR, sessionId);
	await journal.open();
	for (const m of msgs) {
		await journal.append({ type: "message_start", message: m } as never);
		await journal.append({ type: "message_end", message: m } as never);
	}
	await journal.close();
	return { sessionDir, parentFile };
}

describe("daemon session.branchAt", () => {
	const cleanup: (() => Promise<void>)[] = [];

	afterAll(async () => {
		for (const fn of cleanup.reverse()) await fn();
	});

	test(
		"moves the leaf onto an assistant node without truncating the tail",
		async () => {
			const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-branchat-"));
			const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
			cleanup.push(async () => {
				await daemon.close();
			});
			const ws = await openWs(daemon.wsPort!);
			const call = makeRpc(ws);
			const sessionId = crypto.randomUUID();
			const tA = Date.now() - 2000;
			const tA2 = Date.now() - 1000;
			const { sessionDir, parentFile } = await seedSession(tmp, sessionId, [
				{ role: "user", timestamp: tA, content: [{ type: "text", text: "第一轮 A" }] },
				{ role: "assistant", timestamp: tA2, content: [{ type: "text", text: "助手回复 A" }] },
			]);
			cleanup.push(async () => {
				ws.close();
				await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`)).catch(() => {});
				new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
				await fs.promises.rm(parentFile, { force: true });
				// The mangled session dir lives under ~/.musepi/agent/sessions
				// (NOT under tmp) — remove it too or the SDK scan keeps listing
				// the test session in the real daemon's tree.
				await fs.promises.rm(sessionDir, { recursive: true, force: true });
				await fs.promises.rm(tmp, { recursive: true, force: true });
			});

			// Activate the session (history → live) so branchAt can move its leaf.
			await call("session.subscribe", { sessionId });

			// ── Branch onto the assistant node (view key "assistant:<ts>") ──
			const res = branchAtResult(await call("session.branchAt", { sessionId, messageId: `assistant:${tA2}` }));
			expect(res.ok).toBe(true);
			// Leaf lands on the assistant node itself.
			expect(res.leafId).toBe(`assistant:${tA2}`);
			// Assistant nodes do NOT backfill editor text (continue-from).
			expect(res.editorText).toBeNull();
			await new Promise(r => setTimeout(r, 50));

			// ── Branch onto the user node: leaf = parent (null root), text
			// backfilled for re-answer.
			const res2 = branchAtResult(await call("session.branchAt", { sessionId, messageId: `user:${tA}` }));
			expect(res2.ok).toBe(true);
			expect(res2.leafId).toBeNull();
			expect(res2.editorText).toContain("第一轮 A");
		},
		20_000,
	);

	test(
		"rejects an unknown message key",
		async () => {
			const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-branchat-"));
			const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
			cleanup.push(async () => {
				await daemon.close();
			});
			const ws = await openWs(daemon.wsPort!);
			const call = makeRpc(ws);
			const sessionId = crypto.randomUUID();
			const { sessionDir, parentFile } = await seedSession(tmp, sessionId, [
				{ role: "user", timestamp: Date.now() - 1000, content: [{ type: "text", text: "只有一条" }] },
			]);
			cleanup.push(async () => {
				ws.close();
				await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`)).catch(() => {});
				new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
				await fs.promises.rm(parentFile, { force: true });
				// The mangled session dir lives under ~/.musepi/agent/sessions
				// (NOT under tmp) — remove it too or the SDK scan keeps listing
				// the test session in the real daemon's tree.
				await fs.promises.rm(sessionDir, { recursive: true, force: true });
				await fs.promises.rm(tmp, { recursive: true, force: true });
			});

			await call("session.subscribe", { sessionId });

			let rejected = false;
			try {
				await call("session.branchAt", { sessionId, messageId: `user:${Date.now()}` });
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
		},
		20_000,
	);
});
