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

	afterAll(async () => {
		for (const fn of cleanup.reverse()) await fn();
	});

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
			await fs.promises.writeFile(parentFile, `${titleSlotLine}
${JSON.stringify(header)}
${sdkLines.join("\n")}
`);

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
});
