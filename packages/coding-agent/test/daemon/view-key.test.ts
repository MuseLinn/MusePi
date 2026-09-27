/**
 * daemon view id-space regression (layer-1/2/3 data contract):
 * when a history session is activated, the materialized snapshot must
 * hand the GUI entries whose ids AND parentIds live in the messageKey
 * ("role:timestamp") space — never the SDK hex tree ids. A mixed id
 * space silently kills branchChildren/breadcrumb/leafPath (all keyed by
 * messageKey), so every tree surface renders nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AppendJournal } from "../../src/daemon/journal";
import { startDaemon } from "../../src/daemon/server";
import { computeDefaultSessionDir } from "../../src/session/session-paths";
import { FileSessionStorage } from "../../src/session/session-storage";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

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

describe("daemon snapshot id space (messageKey)", () => {
	const cleanup: (() => Promise<void>)[] = [];
	let isolatedAgentDir = "";
	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("daemon-viewkey-agent-");
	});
	afterAll(async () => {
		for (const fn of cleanup.reverse()) await fn();
		await restoreAgentDirForTest(isolatedAgentDir);
		// Windows daemon handles release a few seconds after close —
		// give the retried rm room beyond the default 5s hook timeout.
	}, 30000);

	test("history session entries carry messageKey ids and parentIds incl. branch points", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-viewkey-"));
		const journalDir = path.join(tmp, "journal");
		const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
		cleanup.push(async () => {
			await daemon.close();
		});
		const ws = await openWs(daemon.wsPort!);
		const call = makeRpc(ws);
		const sessionId = crypto.randomUUID();
		const t = Date.now();
		const msgs: WireMessage[] = [
			{ role: "user", timestamp: t, content: [{ type: "text", text: "根问题" }] },
			{ role: "assistant", timestamp: t + 1, content: [{ type: "text", text: "助手调查" }] },
			{ role: "user", timestamp: t + 2, content: [{ type: "text", text: "分支点提问" }] },
			{ role: "assistant", timestamp: t + 3, content: [{ type: "text", text: "主线回答" }] },
			{ role: "assistant", timestamp: t + 4, content: [{ type: "text", text: "兄弟分支回答" }] },
			{ role: "user", timestamp: t + 5, content: [{ type: "text", text: "继续主线" }] },
			{ role: "assistant", timestamp: t + 6, content: [{ type: "text", text: "主线收尾" }] },
		];
		// SDK file with an explicit branch: record 4 (sibling reply) hangs
		// under record 2 (the branch point) — a persisted branchAt+re-answer.
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		const iso = new Date().toISOString().replace(/[:.]/g, "-");
		const parentFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
		const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: tmp };
		const ids = msgs.map(() => crypto.randomBytes(4).toString("hex"));
		const lines: string[] = [];
		for (let i = 0; i < msgs.length; i++) {
			const parentIdx = i === 4 ? 2 : i - 1;
			lines.push(
				JSON.stringify({
					type: "message",
					id: ids[i],
					parentId: parentIdx >= 0 ? ids[parentIdx] : null,
					timestamp: new Date(msgs[i].timestamp).toISOString(),
					message: msgs[i],
				}),
			);
		}
		await fs.promises.writeFile(parentFile, `${JSON.stringify(header)}\n${lines.join("\n")}\n`);
		const journal = new AppendJournal(journalDir, sessionId);
		await journal.open();
		for (const m of msgs) {
			await journal.append({ type: "message_start", message: m } as never);
			await journal.append({ type: "message_end", message: m } as never);
		}
		await journal.close();
		cleanup.push(async () => {
			ws.close();
			await fs.promises.rm(parentFile, { force: true });
			// The mangled session dir lives under ~/.musepi/agent/sessions
			// (NOT under tmp) — remove it too or the SDK scan keeps listing
			// the test session in the real daemon's tree.
			await fs.promises.rm(sessionDir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});

		await call("session.subscribe", { sessionId });
		const snap = (await call("session.snapshot", { sessionId })) as {
			entries: { id: string; parentId: string | null; message: { role: string } }[];
		};
		const entries = snap.entries ?? [];
		expect(entries.length).toBe(7);

		// Every id AND parentId must be a messageKey (no hex).
		for (const e of entries) {
			expect(e.id).toMatch(/^(user|assistant|toolResult):\d+$/);
			if (e.parentId !== null) expect(e.parentId).toMatch(/^(user|assistant|toolResult):\d+$/);
		}

		// Branch point (record 2, "分支点提问") has exactly two children.
		const branchPoint = entries.find(e => e.id === `user:${t + 2}`);
		expect(branchPoint).toBeDefined();
		const children = entries.filter(e => e.parentId === `user:${t + 2}`);
		expect(children.length).toBe(2);
		// Sibling branch reply hangs under the branch point, not linearly.
		expect(children.map(c => c.id)).toContain(`assistant:${t + 4}`);
	}, 20_000);

	test("message parentId walks up non-message leaves (model_change) to nearest message ancestor", async () => {
		// The SDK leaf at append time may be a non-message entry; the
		// rekey must link the next message to the nearest MESSAGE
		// ancestor, not null it out (scattered single-node trees).
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-viewkey-"));
		const journalDir = path.join(tmp, "journal");
		const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
		cleanup.push(async () => {
			await daemon.close();
		});
		const ws = await openWs(daemon.wsPort!);
		const call = makeRpc(ws);
		const sessionId = crypto.randomUUID();
		const t = Date.now();
		const msgs: WireMessage[] = [
			{ role: "user", timestamp: t, content: [{ type: "text", text: "A" }] },
			{ role: "assistant", timestamp: t + 1, content: [{ type: "text", text: "B" }] },
			{ role: "user", timestamp: t + 2, content: [{ type: "text", text: "C" }] },
			{ role: "assistant", timestamp: t + 3, content: [{ type: "text", text: "D" }] },
		];
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		const iso = new Date().toISOString().replace(/[:.]/g, "-");
		const parentFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
		const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: tmp };
		const ids = msgs.map(() => crypto.randomBytes(4).toString("hex"));
		// A model_change sits BETWEEN assistant B and user C — its id is
		// the leaf when C is appended, so C's hex parentId points at it.
		const modelChangeId = crypto.randomBytes(4).toString("hex");
		const lines: string[] = [];
		for (let i = 0; i < msgs.length; i++) {
			const parentIdx = i - 1;
			const parentId =
				i === 2
					? modelChangeId // C's parent is the model_change entry
					: parentIdx >= 0
						? ids[parentIdx]
						: null;
			lines.push(
				JSON.stringify({
					type: "message",
					id: ids[i],
					parentId,
					timestamp: new Date(msgs[i].timestamp).toISOString(),
					message: msgs[i],
				}),
			);
			if (i === 1) {
				lines.push(
					JSON.stringify({
						type: "model_change",
						id: modelChangeId,
						parentId: ids[1], // leaf = assistant B when it appended
						timestamp: new Date(msgs[i].timestamp + 0.5).toISOString(),
						model: "test/model",
						resolvedModelIsFallback: false,
					}),
				);
			}
		}
		await fs.promises.writeFile(
			parentFile,
			`${JSON.stringify(header)}
${lines.join("\n")}
`,
		);
		cleanup.push(async () => {
			ws.close();
			await fs.promises.rm(parentFile, { force: true });
			// The mangled session dir lives under ~/.musepi/agent/sessions
			// (NOT under tmp) — remove it too or the SDK scan keeps listing
			// the test session in the real daemon's tree.
			await fs.promises.rm(sessionDir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});

		await call("session.subscribe", { sessionId });
		const snap = (await call("session.snapshot", { sessionId })) as {
			entries: { id: string; parentId: string | null; message: { role: string } }[];
		};
		const entries = snap.entries ?? [];
		// The non-message entry (model_change) stays in the view (the
		// timeline shows it); only the tree projection filters it out.
		expect(entries.length).toBe(5);
		// C (user at t+2) must hang under B (assistant at t+1) — the walk
		// skips the model_change entry — not under a null/hex parent.
		const c = entries.find(e => e.id === `user:${t + 2}`);
		expect(c).toBeDefined();
		expect(c!.parentId).toBe(`assistant:${t + 1}`);
		// D hangs under C; the chain is fully connected (one root).
		const d = entries.find(e => e.id === `assistant:${t + 3}`);
		expect(d!.parentId).toBe(`user:${t + 2}`);
		const roots = entries.filter(e => e.parentId === null);
		expect(roots.length).toBe(1);
	}, 20_000);

	test("non-message entries (custom / model_change) rekey into the view key space — every parentId resolves in-snapshot", async () => {
		// Contract: the snapshot handed to the GUI is ONE self-contained id
		// space. Before the rekey extension, custom/model_change entries kept
		// SDK hex ids and hex parentIds pointing at messages that had been
		// rekeyed away — dangling chains for any consumer that walks them.
		// Now: message ids are messageKeys, non-message ids are deterministic
		// "type:tsMs", and every parentId resolves to an entry in the same
		// snapshot (or null at the root).
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-viewkey-"));
		const journalDir = path.join(tmp, "journal");
		const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
		cleanup.push(async () => {
			await daemon.close();
		});
		const ws = await openWs(daemon.wsPort!);
		const call = makeRpc(ws);
		const sessionId = crypto.randomUUID();
		const t = Date.now();
		const msgs: WireMessage[] = [
			{ role: "user", timestamp: t, content: [{ type: "text", text: "A" }] },
			{ role: "assistant", timestamp: t + 1, content: [{ type: "text", text: "B" }] },
			{ role: "user", timestamp: t + 2, content: [{ type: "text", text: "C" }] },
		];
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		const iso = new Date().toISOString().replace(/[:.]/g, "-");
		const parentFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
		const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: tmp };
		const ids = msgs.map(() => crypto.randomBytes(4).toString("hex"));
		// B's leaf position is taken by a custom entry; C's by a model_change —
		// both carry hex parentIds into the message tree.
		const customId = crypto.randomBytes(4).toString("hex");
		const modelChangeId = crypto.randomBytes(4).toString("hex");
		const lines: string[] = [];
		for (let i = 0; i < msgs.length; i++) {
			const parentIdx = i - 1;
			lines.push(
				JSON.stringify({
					type: "message",
					id: ids[i],
					parentId: parentIdx >= 0 ? ids[parentIdx] : null,
					timestamp: new Date(msgs[i].timestamp).toISOString(),
					message: msgs[i],
				}),
			);
			if (i === 1) {
				lines.push(
					JSON.stringify({
						type: "custom",
						id: customId,
						parentId: ids[1],
						timestamp: new Date(msgs[i].timestamp + 10).toISOString(),
						content: "marker",
					}),
				);
			}
			if (i === 2) {
				lines.push(
					JSON.stringify({
						type: "model_change",
						id: modelChangeId,
						parentId: customId, // leaf = the custom entry when it appended
						timestamp: new Date(msgs[i].timestamp + 20).toISOString(),
						model: "test/model",
						resolvedModelIsFallback: false,
					}),
				);
			}
		}
		await fs.promises.writeFile(
			parentFile,
			`${JSON.stringify(header)}
${lines.join("\n")}
`,
		);
		cleanup.push(async () => {
			ws.close();
			await fs.promises.rm(parentFile, { force: true });
			// The mangled session dir lives under ~/.musepi/agent/sessions
			// (NOT under tmp) — remove it too or the SDK scan keeps listing
			// the test session in the real daemon's tree.
			await fs.promises.rm(sessionDir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});

		await call("session.subscribe", { sessionId });
		const snap = (await call("session.snapshot", { sessionId })) as {
			entries: { id: string; parentId: string | null; type: string; timestamp: string }[];
		};
		const entries = snap.entries ?? [];
		expect(entries.length).toBe(5);

		// One key space, no SDK hex ids left.
		for (const e of entries) {
			expect(e.id).toMatch(/^(user|assistant|toolResult):\d+$|^[a-z_]+:\d+(#\d+)?$/);
		}
		// The model_change rekeys to "type:tsMs" ...
		const mc = entries.find(e => e.type === "model_change");
		expect(mc).toBeDefined();
		expect(mc!.id).toBe(`model_change:${t + 22}`);
		// ... and its parent chain resolves: model_change → assistant B
		// (nearest MESSAGE ancestor, skipping the custom entry), custom → B.
		expect(mc!.parentId).toBe(`assistant:${t + 1}`);
		const custom = entries.find(e => e.type === "custom");
		expect(custom).toBeDefined();
		expect(custom!.parentId).toBe(`assistant:${t + 1}`);
		// Universal invariant: every parentId resolves to an id present in
		// the same snapshot, or is null at exactly one root.
		const idsInSnapshot = new Set(entries.map(e => e.id));
		for (const e of entries) {
			if (e.parentId !== null) expect(idsInSnapshot.has(e.parentId)).toBe(true);
		}
		expect(entries.filter(e => e.parentId === null).length).toBe(1);
	}, 20_000);
});
