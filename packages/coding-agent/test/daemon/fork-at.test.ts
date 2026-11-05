/**
 * session.forkAt (GUI 消息树"从此处继续" parity): non-destructive fork
 * truncated at a target message.
 *
 *   - includeTarget: false (default) — truncate BEFORE the target (user
 *     message case: the composer backfills its text to re-answer).
 *   - includeTarget: true — keep the target as the new session's LAST
 *     record (TUI navigateTree parity for assistant/toolResult nodes: the
 *     leaf lands ON the node and the user continues from there).
 *
 * Also covers the id-spaces regression: the GUI sends view keys
 * ("role:timestamp") that never equal SDK/jsonl ids — forkAt must resolve
 * by message identity (same as branchAt).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AppendJournal } from "../../src/daemon/journal";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost, startDaemon } from "../../src/daemon/server";
import { JOURNAL_DIR } from "../../src/daemon/session-host";
import { ViewStore, viewStorePath } from "../../src/daemon/view-store";
import { computeDefaultSessionDir } from "../../src/session/session-paths";
import { FileSessionStorage } from "../../src/session/session-storage";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

interface WireMessage {
	role: string;
	timestamp: number;
	content: { type: "text"; text: string }[];
}

function makeRpc(ws: WebSocket): (method: string, params?: unknown) => Promise<any> {
	let nextId = 1;
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	ws.addEventListener("message", ev => {
		const msg = JSON.parse((ev as MessageEvent).data as string);
		if (msg.id !== undefined && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id)!;
			pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message));
			else resolve(msg.result);
		}
	});
	return (method: string, params?: unknown): Promise<any> =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
}

async function openWs(port: number): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", reject, { once: true });
	});
	return ws;
}

/** Message rows of a snapshot (role + text), for assertions. */
function rows(snap: unknown): { role: string; text: string }[] {
	const entries = (snap as { entries: { type: string; message?: WireMessage }[] }).entries ?? [];
	return entries
		.filter(e => e.type === "message")
		.map(e => ({
			role: e.message!.role,
			text: String((e.message!.content[0] as { text: string }).text),
		}));
}

/** Locate a fork file by its session id (the filename embeds the fork-time
 *  timestamp, which differs from the parent's). */
async function forkFile(sessionDir: string, forkId: string): Promise<string> {
	const names = await fs.promises.readdir(sessionDir);
	const match = names.find(n => n.includes(forkId));
	if (!match) throw new Error(`fork file for ${forkId} not found in ${sessionDir}`);
	return path.join(sessionDir, match);
}

/** Message rows of an SDK transcript FILE (role + text), for fork asserts. */
async function fileRows(filePath: string): Promise<{ role: string; text: string }[]> {
	const text = await fs.promises.readFile(filePath, "utf8");
	return text
		.split("\n")
		.filter(l => l?.trim())
		.slice(1) // header
		.map(l => {
			const rec = JSON.parse(l) as { type?: string; message?: WireMessage };
			return {
				role: rec.message?.role ?? "?",
				text: rec.message ? String((rec.message.content[0] as { text: string }).text) : "?",
			};
		});
}

describe("daemon session.forkAt", () => {
	const cleanup: (() => Promise<void>)[] = [];
	let isolatedAgentDir = "";

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("daemon-forkat-agent-");
	});

	afterAll(async () => {
		for (const fn of cleanup.reverse()) await fn();
		await restoreAgentDirForTest(isolatedAgentDir);
		// Windows daemon handles release a few seconds after close —
		// give the retried rm room beyond the default 5s hook timeout.
	}, 30000);

	test(
		"fork before a user message vs through an assistant message",
		async () => {
			const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-forkat-"));
			const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
			cleanup.push(async () => {
				await daemon.close();
			});
			const ws = await openWs(daemon.wsPort!);
			const call = makeRpc(ws);
			const sessionId = crypto.randomUUID();
			const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
			let parentFile = "";
			cleanup.push(async () => {
				ws.close();
				await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`)).catch(() => {});
				new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
				await fs.promises.rm(parentFile, { force: true });
				await fs.promises.rm(sessionDir, { recursive: true, force: true });
				await fs.promises.rm(tmp, { recursive: true, force: true });
			});

			// ── Seed: user A → assistant A → user B → assistant B ──────────
			const tA = Date.now() - 4000;
			const tA2 = Date.now() - 3000;
			const tB = Date.now() - 2000;
			const tB2 = Date.now() - 1000;
			const msgs: WireMessage[] = [
				{ role: "user", timestamp: tA, content: [{ type: "text", text: "第一轮 A" }] },
				{ role: "assistant", timestamp: tA2, content: [{ type: "text", text: "助手回复 A" }] },
				{ role: "user", timestamp: tB, content: [{ type: "text", text: "第二轮 B" }] },
				{ role: "assistant", timestamp: tB2, content: [{ type: "text", text: "助手回复 B" }] },
			];
			const iso = new Date().toISOString().replace(/[:.]/g, "-");
			parentFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
			const header = {
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: new Date().toISOString(),
				cwd: tmp,
			};
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

			// ── Fork BEFORE user B (GUI view key "user:<ts>" — id-space parity) ──
			const fb = await call("session.forkAt", {
				sessionId,
				messageId: `user:${tB}`,
				includeTarget: false,
			});
			expect(fb.sessionId).toBeTruthy();
			expect(fb.parentId).toBe(sessionId);
			const forkBefore = await forkFile(sessionDir, fb.sessionId);
			expect(await fileRows(forkBefore)).toEqual([
				{ role: "user", text: "第一轮 A" },
				{ role: "assistant", text: "助手回复 A" },
			]);
			// The fork's own snapshot matches the truncated transcript.
			const snapB = await call("session.resume", { sessionId: fb.sessionId });
			expect(rows(snapB.snapshot)).toEqual([
				{ role: "user", text: "第一轮 A" },
				{ role: "assistant", text: "助手回复 A" },
			]);

			// ── Fork THROUGH assistant A (keep the node — continue from there) ──
			const fa = await call("session.forkAt", {
				sessionId,
				messageId: `assistant:${tA2}`,
				includeTarget: true,
			});
			expect(fa.sessionId).toBeTruthy();
			const forkThrough = await forkFile(sessionDir, fa.sessionId);
			expect(await fileRows(forkThrough)).toEqual([
				{ role: "user", text: "第一轮 A" },
				{ role: "assistant", text: "助手回复 A" },
			]);
			const snapA = await call("session.resume", { sessionId: fa.sessionId });
			expect(rows(snapA.snapshot)).toEqual([
				{ role: "user", text: "第一轮 A" },
				{ role: "assistant", text: "助手回复 A" },
			]);

			// ── Default (no includeTarget) = truncate before, unchanged ────
			const fd = await call("session.forkAt", { sessionId, messageId: `user:${tB}` });
			expect(await fileRows(await forkFile(sessionDir, fd.sessionId))).toEqual([
				{ role: "user", text: "第一轮 A" },
				{ role: "assistant", text: "助手回复 A" },
			]);

			// ── Parent untouched ─────────────────────────────────────────────
			expect(await fileRows(parentFile)).toEqual([
				{ role: "user", text: "第一轮 A" },
				{ role: "assistant", text: "助手回复 A" },
				{ role: "user", text: "第二轮 B" },
				{ role: "assistant", text: "助手回复 B" },
			]);
		},
		{ timeout: 30000 },
	);

	test(
		"fork of a title-slot file stays activatable (send works)",
		async () => {
			// Regression: real SDK files start with a title slot line
			// (type "title") BEFORE the session header. forkAt used to read
			// lines[0] as the header, so the fork's own header inherited the
			// title-slot shape (no id) and the copied parent header in the
			// body became the fork's session entry — activation adopted the
			// PARENT id and session.send threw `Unknown session`. The fork
			// must carry its own id and stay sendable.
			const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-forkat-"));
			const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
			cleanup.push(async () => {
				await daemon.close();
			});
			const ws = await openWs(daemon.wsPort!);
			const call = makeRpc(ws);
			const sessionId = crypto.randomUUID();
			const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
			let parentFile = "";
			cleanup.push(async () => {
				ws.close();
				await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`)).catch(() => {});
				new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
				await fs.promises.rm(parentFile, { force: true });
				await fs.promises.rm(sessionDir, { recursive: true, force: true });
				await fs.promises.rm(tmp, { recursive: true, force: true });
			});

			const tA = Date.now() - 2000;
			const tA2 = Date.now() - 1000;
			const msgs: WireMessage[] = [
				{ role: "user", timestamp: tA, content: [{ type: "text", text: "第一轮 A" }] },
				{ role: "assistant", timestamp: tA2, content: [{ type: "text", text: "助手回复 A" }] },
			];
			const iso = new Date().toISOString().replace(/[:.]/g, "-");
			parentFile = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
			const header = {
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: new Date().toISOString(),
				cwd: tmp,
				title: "标题槽回归",
				titleSource: "auto",
			};
			const titleSlotLine = (() => {
				const obj = {
					type: "title",
					v: 1,
					title: "标题槽回归",
					source: "auto",
					updatedAt: new Date().toISOString(),
					pad: "",
				};
				const min = JSON.stringify(obj);
				const padLen = 256 - Buffer.byteLength(min) - 1;
				obj.pad = " ".repeat(Math.max(0, padLen));
				return JSON.stringify(obj);
			})();
			const sdkLines = msgs.map(m =>
				JSON.stringify({
					type: "message",
					id: crypto.randomBytes(4).toString("hex"),
					parentId: null,
					timestamp: new Date(m.timestamp).toISOString(),
					message: m,
				}),
			);
			await fs.promises.writeFile(
				parentFile,
				`${titleSlotLine}
${JSON.stringify(header)}
${sdkLines.join("\n")}
`,
			);

			const fb = await call("session.forkAt", {
				sessionId,
				messageId: `user:${tA}`,
				includeTarget: true,
			});
			expect(fb.sessionId).toBeTruthy();
			const fork = await forkFile(sessionDir, fb.sessionId);
			// DEBUG

			// The fork's OWN header carries the NEW id (type "session"), and
			// the body must NOT contain the parent's header record.
			const text = await fs.promises.readFile(fork, "utf8");
			const lines = text.split("\n").filter(l => l?.trim());
			const sessionRecs = lines
				.map(l => {
					try {
						return JSON.parse(l) as { type?: string; id?: string };
					} catch {
						return null;
					}
				})
				.filter(r => r !== null && r.type === "session");
			expect(sessionRecs.length).toBe(1);
			expect(sessionRecs[0]!.id).toBe(fb.sessionId);

			// Activation + send on the fork must succeed (the historical bug
			// threw `Unknown session` here). includeTarget on the FIRST
			// message keeps just that record as the fork's leaf.
			const resume = await call("session.resume", { sessionId: fb.sessionId });
			expect(rows(resume.snapshot)).toEqual([{ role: "user", text: "第一轮 A" }]);
			const sent = await call("session.send", { sessionId: fb.sessionId, text: "fork 续问" });
			expect(sent.accepted).toBe(true);
		},
		{ timeout: 30000 },
	);

	// ── Running fork (snapshot) ────────────────────────────────────────
	// A fork must not stop the source session. While a turn is in flight the
	// daemon copies only the settled prefix ending on that turn's user prompt;
	// entries the running turn already persisted (assistant toolCall,
	// toolResult) are dropped so the fork is a legal, resumable transcript.
	// Concurrent snapshot forks of one source reject the second with a
	// retryable code instead of interleaving two cuts.

	interface SeedMessage {
		role: string;
		timestamp: number;
		content: unknown[];
		stopReason?: string;
		toolCallId?: string;
		toolName?: string;
	}

	interface RawRow {
		type?: string;
		role: string;
		text: string;
	}

	async function seedSession(
		tmp: string,
		sessionId: string,
		messages: SeedMessage[],
	): Promise<{ file: string; sessionDir: string }> {
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		const iso = new Date().toISOString().replace(/[:.]/g, "-");
		const file = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
		const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: tmp };
		const body = messages.map((m, i) =>
			JSON.stringify({
				type: "message",
				id: `seed-${i}`,
				parentId: i === 0 ? null : `seed-${i - 1}`,
				timestamp: new Date(m.timestamp).toISOString(),
				message: m,
			}),
		);
		await fs.promises.writeFile(file, `${JSON.stringify(header)}\n${body.join("\n")}\n`);
		return { file, sessionDir };
	}

	async function rawRows(file: string): Promise<RawRow[]> {
		const text = await fs.promises.readFile(file, "utf8");
		return text
			.split("\n")
			.filter(l => l?.trim())
			.slice(1)
			.map(l => {
				const rec = JSON.parse(l) as { type?: string; message?: SeedMessage };
				const first = rec.message?.content?.[0] as { text?: string } | undefined;
				return {
					type: rec.type,
					role: rec.message?.role ?? "?",
					text: typeof first?.text === "string" ? first.text : "",
				};
			});
	}

	function busyHost(
		sessionId: string,
		tmp: string,
		state: { streaming: boolean; aborts: number; flush?: () => Promise<unknown> },
	): DaemonSessionHost {
		const live = {
			sessionId,
			agentSession: {
				get isStreaming() {
					return state.streaming;
				},
				abort: () => {
					state.aborts += 1;
				},
				sessionManager: { flush: () => state.flush?.() ?? Promise.resolve() },
			},
			activeToolCalls: new Map(),
		};
		return {
			cwd: () => tmp,
			get: (id: string) => (id === sessionId ? live : undefined),
			invalidateHistoryCache: () => {},
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
	}

	const runningMessages = (t0: number): SeedMessage[] => [
		{ role: "user", timestamp: t0, content: [{ type: "text", text: "第一轮 A" }] },
		{
			role: "assistant",
			timestamp: t0 + 1000,
			stopReason: "stop",
			content: [{ type: "text", text: "助手回复 A" }],
		},
		{ role: "user", timestamp: t0 + 2000, content: [{ type: "text", text: "第二轮 B（在途）" }] },
		{
			role: "assistant",
			timestamp: t0 + 3000,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
		},
		{
			role: "toolResult",
			timestamp: t0 + 4000,
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "工具结果" }],
		},
	];

	test(
		"snapshot fork during a run keeps the settled prefix and leaves the source running",
		async () => {
			const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-forkat-snap-"));
			const sessionId = crypto.randomUUID();
			const t0 = Date.now() - 5000;
			const { file, sessionDir } = await seedSession(tmp, sessionId, runningMessages(t0));
			const state = { streaming: true, aborts: 0 };
			const server = new DaemonServer(busyHost(sessionId, tmp, state));
			const conn = { id: "test" } as unknown as DaemonConnection;
			const forkIds: string[] = [];
			cleanup.push(async () => {
				for (const id of forkIds) {
					const fork = await forkFile(sessionDir, id).catch(() => "");
					if (fork) await fs.promises.rm(fork, { force: true });
				}
				await fs.promises.rm(file, { force: true });
				await fs.promises.rm(sessionDir, { recursive: true, force: true });
				await fs.promises.rm(tmp, { recursive: true, force: true });
			});

			// Target is the assistant toolCall the running turn already persisted:
			// the fork must NOT carry that half turn (no dangling toolCall).
			const throughTool = (await server.handle(
				"session.forkAt",
				{ sessionId, messageId: `assistant:${t0 + 3000}`, includeTarget: true, snapshot: true },
				conn,
			)) as { sessionId: string };
			forkIds.push(throughTool.sessionId);
			expect((await rawRows(await forkFile(sessionDir, throughTool.sessionId))).map(r => r.text)).toEqual([
				"第一轮 A",
				"助手回复 A",
				"第二轮 B（在途）",
			]);

			// The streaming reply is not durable yet: an id the file cannot
			// carry falls back to the same turn-start cut instead of failing.
			const throughStream = (await server.handle(
				"session.forkAt",
				{ sessionId, messageId: `assistant:${t0 + 5000}`, includeTarget: true, snapshot: true },
				conn,
			)) as { sessionId: string };
			forkIds.push(throughStream.sessionId);
			expect(await rawRows(await forkFile(sessionDir, throughStream.sessionId))).toHaveLength(3);

			// Opt-in only: without `snapshot`, the historical includeTarget copy
			// still keeps the in-flight toolCall record.
			const legacy = (await server.handle(
				"session.forkAt",
				{ sessionId, messageId: `assistant:${t0 + 3000}`, includeTarget: true },
				conn,
			)) as { sessionId: string };
			forkIds.push(legacy.sessionId);
			expect((await rawRows(await forkFile(sessionDir, legacy.sessionId))).map(r => r.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);

			// Source was never stopped and its transcript is intact.
			expect(state.aborts).toBe(0);
			expect(await rawRows(file)).toHaveLength(5);

			// The run finishes: the source keeps appending and the next snapshot
			// fork sees the completed turn.
			await fs.promises.appendFile(
				file,
				`${JSON.stringify({
					type: "message",
					id: "seed-5",
					parentId: "seed-4",
					timestamp: new Date(t0 + 6000).toISOString(),
					message: {
						role: "assistant",
						timestamp: t0 + 6000,
						stopReason: "stop",
						content: [{ type: "text", text: "助手回复 B" }],
					},
				})}\n`,
			);
			state.streaming = false;
			const completed = (await server.handle(
				"session.forkAt",
				{ sessionId, messageId: `assistant:${t0 + 6000}`, includeTarget: true, snapshot: true },
				conn,
			)) as { sessionId: string };
			forkIds.push(completed.sessionId);
			expect((await rawRows(await forkFile(sessionDir, completed.sessionId))).map(r => r.text)).toEqual([
				"第一轮 A",
				"助手回复 A",
				"第二轮 B（在途）",
				"",
				"工具结果",
				"助手回复 B",
			]);
		},
		{ timeout: 30000 },
	);

	test(
		"concurrent snapshot forks of one session reject the second as retryable",
		async () => {
			const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-forkat-lock-"));
			const sessionId = crypto.randomUUID();
			const t0 = Date.now() - 5000;
			const { file, sessionDir } = await seedSession(tmp, sessionId, runningMessages(t0));
			const gate = Promise.withResolvers<void>();
			const state = { streaming: true, aborts: 0, flush: () => gate.promise };
			const server = new DaemonServer(busyHost(sessionId, tmp, state));
			const conn = { id: "test" } as unknown as DaemonConnection;
			const forked: string[] = [];
			cleanup.push(async () => {
				for (const id of forked) {
					const fork = await forkFile(sessionDir, id).catch(() => "");
					if (fork) await fs.promises.rm(fork, { force: true });
				}
				await fs.promises.rm(file, { force: true });
				await fs.promises.rm(sessionDir, { recursive: true, force: true });
				await fs.promises.rm(tmp, { recursive: true, force: true });
			});

			const params = {
				sessionId,
				messageId: `user:${t0 + 2000}`,
				includeTarget: true,
				snapshot: true,
			};
			const first = server.handle("session.forkAt", params, conn) as Promise<{ sessionId: string }>;
			// The first fork is parked on flush with the per-session lock held.
			await expect(server.handle("session.forkAt", params, conn)).rejects.toThrow("SESSION_FORK_IN_PROGRESS");
			gate.resolve();
			const firstResult = await first;
			forked.push(firstResult.sessionId);
			expect(firstResult.sessionId).toBeTruthy();

			// The lock is released: a retry succeeds.
			const retry = (await server.handle("session.forkAt", params, conn)) as { sessionId: string };
			forked.push(retry.sessionId);
			expect(retry.sessionId).toBeTruthy();
		},
		{ timeout: 30000 },
	);
});
