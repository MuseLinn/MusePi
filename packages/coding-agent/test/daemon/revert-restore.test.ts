/**
 * Revert/restore integration (openchamber RevertedMessageDock parity):
 * session.revertTo backs up the abandoned tail; session.restoreRevert
 * re-inserts it (single {index} or {all}); session.revertList is the
 * dock's single source of truth; session.discardRevert drops a backup.
 *
 * Covers the live path (session.subscribe reactivates the seeded session)
 * and the id-mismatch regression: the GUI sends view keys
 * ("role:timestamp") that never equal SDK/jsonl ids (generateId hex) —
 * revertTo and the history truncation must resolve by message identity,
 * and a revert → restore → revert cycle must NOT empty the transcript.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";
import { AppendJournal } from "../../src/daemon/journal";
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

/** Seed a valid SDK transcript file + matching journal for `sessionId`. */
async function seedSession(
	tmp: string,
	sessionId: string,
	msgs: WireMessage[],
): Promise<{ filePath: string; sdkIds: string[] }> {
	const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
	const iso = new Date().toISOString().replace(/[:.]/g, "-");
	const filePath = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd: tmp,
	};
	const sdkIds = msgs.map(() => crypto.randomBytes(4).toString("hex"));
	const sdkLines = msgs.map((m, i) =>
		JSON.stringify({
			type: "message",
			id: sdkIds[i],
			timestamp: new Date(m.timestamp).toISOString(),
			message: m,
		}),
	);
	await fs.promises.writeFile(filePath, `${JSON.stringify(header)}\n${sdkLines.join("\n")}\n`);
	const journal = new AppendJournal(JOURNAL_DIR, sessionId);
	await journal.open();
	for (const m of msgs) {
		await journal.append({ type: "message_start", message: m } as never);
		await journal.append({ type: "message_end", message: m } as never);
	}
	await journal.close();
	return { filePath, sdkIds };
}

/** Count `"type":"message"` records in an SDK transcript file. */
async function fileMessageCount(filePath: string): Promise<number> {
	const text = await fs.promises.readFile(filePath, "utf8");
	return text
		.split("\n")
		.filter(l => l?.trim())
		.filter(l => (JSON.parse(l) as { type?: string }).type === "message").length;
}

function stdMessages(): WireMessage[] {
	const tA = Date.now() - 4000;
	const tA2 = Date.now() - 3000;
	const tB = Date.now() - 2000;
	const tB2 = Date.now() - 1000;
	return [
		{ role: "user", timestamp: tA, content: [{ type: "text", text: "第一轮 A" }] },
		{ role: "assistant", timestamp: tA2, content: [{ type: "text", text: "助手回复 A" }] },
		{ role: "user", timestamp: tB, content: [{ type: "text", text: "第二轮 B" }] },
		{ role: "assistant", timestamp: tB2, content: [{ type: "text", text: "助手回复 B" }] },
	];
}

describe("daemon revert/restore", () => {
	const cleanup: (() => Promise<void>)[] = [];

	afterAll(async () => {
		for (const fn of cleanup.reverse()) await fn();
	});

	// Real model calls (session.create + send) can take seconds when the
	// provider is slow (observed 4.4s activation) — the default 5s test
	// timeout flaked under load.
	test("revert → restore single → revert again → restore all → discard", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-revert-"));;
		const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
		cleanup.push(async () => {
			await daemon.close();
		});
		const ws = await openWs(daemon.wsPort!);
		const call = makeRpc(ws);
		const sessionId = crypto.randomUUID();
		let filePath = "";
		cleanup.push(async () => {
			ws.close();
			// Journal + materialized-view row + SDK file/dir for this session.
			await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`)).catch(() => {});
			new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
			await fs.promises.rm(filePath, { force: true });
			const dir = computeDefaultSessionDir(tmp, new FileSessionStorage());
			await fs.promises.rm(dir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});

		// ── Seed: a valid SDK transcript + matching journal, no model needed ──
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
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		const iso = new Date().toISOString().replace(/[:.]/g, "-");
		filePath = path.join(sessionDir, `${iso}_${sessionId}.jsonl`);
		const header = {
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd: tmp,
		};
		// SDK transcript records (jsonl ids = SDK hex; message carries the
		// wire timestamp the view keys on).
		const sdkLines = msgs.map(m =>
			JSON.stringify({
				type: "message",
				id: crypto.randomBytes(4).toString("hex"),
				timestamp: new Date(m.timestamp).toISOString(),
				message: m,
			}),
		);
		await fs.promises.writeFile(filePath, `${JSON.stringify(header)}\n${sdkLines.join("\n")}\n`);
		// Journal records (message_start/end — the view + truncation source).
		const journal = new AppendJournal(JOURNAL_DIR, sessionId);
		await journal.open();
		for (const m of msgs) {
			await journal.append({ type: "message_start", message: m } as never);
			await journal.append({ type: "message_end", message: m } as never);
		}
		await journal.close();

		// ── Subscribe reactivates → live view has all four rows ──────────
		const sub = await call("session.subscribe", { sessionId });
		expect(rows(sub.initial)).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
			{ role: "user", text: "第二轮 B" },
			{ role: "assistant", text: "助手回复 B" },
		]);
		// Activated views keep the SDK entry ids (hex) — the GUI sends
		// whatever id the row carries; the daemon resolves both id spaces.
		const bEntry = (sub.initial.entries as { type: string; id: string; message?: WireMessage }[]).find(
			e => e.type === "message" && e.message?.role === "user" && String(e.message.content[0].text) === "第二轮 B",
		);
		expect(bEntry?.id).toBeTruthy();
		const bId = bEntry!.id;

		// ── Revert to B (SDK hex id — never a journal key) ───────────────
		const rv = await call("session.revertTo", { sessionId, messageId: bId });
		expect(rv.ok).toBe(true);
		expect(rv.text).toBe("第二轮 B");
		let snap = await call("session.resume", { sessionId });
		expect(rows(snap.snapshot)).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
		]);
		let list = await call("session.revertList", { sessionId });
		expect(list.items).toEqual([{ index: 0, text: "第二轮 B", messageId: bId }]);

		// ── Restore single (还原单轮) ─────────────────────────────────────
		const rs = await call("session.restoreRevert", { sessionId, index: 0 });
		expect(rs.ok).toBe(true);
		snap = await call("session.resume", { sessionId });
		expect(rows(snap.snapshot)).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
			{ role: "user", text: "第二轮 B" },
			{ role: "assistant", text: "助手回复 B" },
		]);
		list = await call("session.revertList", { sessionId });
		expect(list.items).toEqual([]);

		// ── Revert again (the reported regression: must NOT empty) ───────
		const rv2 = await call("session.revertTo", { sessionId, messageId: `user:${tB}` });
		expect(rv2.ok).toBe(true);
		snap = await call("session.resume", { sessionId });
		expect(rows(snap.snapshot)).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
		]);

		// ── Restore all (还原全部) ────────────────────────────────────────
		const ra = await call("session.restoreRevert", { sessionId, all: true });
		expect(ra.ok).toBe(true);
		snap = await call("session.resume", { sessionId });
		expect(rows(snap.snapshot)).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
			{ role: "user", text: "第二轮 B" },
			{ role: "assistant", text: "助手回复 B" },
		]);
		list = await call("session.revertList", { sessionId });
		expect(list.items).toEqual([]);

		// ── Discard without restore ───────────────────────────────────────
		const rv3 = await call("session.revertTo", { sessionId, messageId: `user:${tB}` });
		expect(rv3.ok).toBe(true);
		list = await call("session.revertList", { sessionId });
		expect(list.items.length).toBe(1);
		const dg = await call("session.discardRevert", { sessionId, index: 0 });
		expect(dg.ok).toBe(true);
	list = await call("session.revertList", { sessionId });
	expect(list.items).toEqual([]);
	}, { timeout: 30000 });

	test("history path: revert on a non-activated session truncates the SDK file", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-revert-hist-"));
		const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
		cleanup.push(async () => {
			await daemon.close();
		});
		const ws = await openWs(daemon.wsPort!);
		const call = makeRpc(ws);
		const sessionId = crypto.randomUUID();
		const msgs = stdMessages();
		const { filePath, sdkIds } = await seedSession(tmp, sessionId, msgs);
		cleanup.push(async () => {
			ws.close();
			await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`)).catch(() => {});
			new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
			await fs.promises.rm(filePath, { force: true });
			const dir = computeDefaultSessionDir(tmp, new FileSessionStorage());
			await fs.promises.rm(dir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});

		// NEVER subscribe: the daemon must not activate this session, so the
		// revert runs the pure-history path (jsonl truncation, no SDK agent).
		expect(await fileMessageCount(filePath)).toBe(4);
		// GUI sends the view key — the file records carry SDK hex ids.
		const rv = await call("session.revertTo", { sessionId, messageId: `user:${msgs[2].timestamp}` });
		expect(rv.ok).toBe(true);
		expect(rv.text).toBe("第二轮 B");
		// The SDK file itself must be truncated — this is what the next
		// resume re-projects the view from (regression: it used to keep the
		// full file when the journal covered the session, silently undoing
		// the revert on reopen).
		expect(await fileMessageCount(filePath)).toBe(2);
		const list = await call("session.revertList", { sessionId });
		expect(list.items).toHaveLength(1);
		expect(list.items[0].text).toBe("第二轮 B");

		// Resume AFTER the revert: the truncated file must win → [A, A2].
		const resumed = await call("session.resume", { sessionId });
		expect(rows(resumed.snapshot)).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
		]);
	});

	test("history path: restore re-appends the SDK file records", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-revert-hist2-"));
		const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
		cleanup.push(async () => {
			await daemon.close();
		});
		const ws = await openWs(daemon.wsPort!);
		const call = makeRpc(ws);
		const sessionId = crypto.randomUUID();
		const msgs = stdMessages();
		const { filePath } = await seedSession(tmp, sessionId, msgs);
		cleanup.push(async () => {
			ws.close();
			await fs.promises.unlink(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`)).catch(() => {});
			new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
			await fs.promises.rm(filePath, { force: true });
			const dir = computeDefaultSessionDir(tmp, new FileSessionStorage());
			await fs.promises.rm(dir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});

		await call("session.revertTo", { sessionId, messageId: `user:${msgs[2].timestamp}` });
		expect(await fileMessageCount(filePath)).toBe(2);
		// Restore WITHOUT resuming — the pure-history restore path re-appends
		// the removed jsonl records to the file.
		const rs = await call("session.restoreRevert", { sessionId, index: 0 });
		expect(rs.ok).toBe(true);
		expect(rs.restored).toBe(1);
		expect(await fileMessageCount(filePath)).toBe(4);
		const resumed = await call("session.resume", { sessionId });
		expect(rows(resumed.snapshot)).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
			{ role: "user", text: "第二轮 B" },
			{ role: "assistant", text: "助手回复 B" },
		]);
	});

	test("forkAt resolves the view key and truncates the copy", async () => {
		const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-revert-fork-"));
		const daemon = await startDaemon({ socketPath: path.join(tmp, "d.sock"), wsPort: 0, cwd: tmp });
		cleanup.push(async () => {
			await daemon.close();
		});
		const ws = await openWs(daemon.wsPort!);
		const call = makeRpc(ws);
		const sessionId = crypto.randomUUID();
		const msgs = stdMessages();
		const { filePath } = await seedSession(tmp, sessionId, msgs);
		let forkFile = "";
		let forkId = "";
		cleanup.push(async () => {
			ws.close();
			for (const id of [sessionId, forkId]) {
				if (!id) continue;
				await fs.promises.unlink(path.join(JOURNAL_DIR, `${id}.journal.jsonl`)).catch(() => {});
				new ViewStore(viewStorePath(JOURNAL_DIR)).remove(id);
			}
			await fs.promises.rm(filePath, { force: true });
			await fs.promises.rm(forkFile, { force: true });
			const dir = computeDefaultSessionDir(tmp, new FileSessionStorage());
			await fs.promises.rm(dir, { recursive: true, force: true });
			await fs.promises.rm(tmp, { recursive: true, force: true });
		});

		// The GUI passes the view key ("role:timestamp"), never the jsonl id.
		const fork = await call("session.forkAt", { sessionId, messageId: `user:${msgs[2].timestamp}` });
		expect(fork.sessionId).toBeTruthy();
		forkId = fork.sessionId as string;
		expect(fork.parentId).toBe(sessionId);
		// The fork file: new id + parentSession header, transcript cut to
		// BEFORE the target (B): [A, A2].
		const sessionDir = computeDefaultSessionDir(tmp, new FileSessionStorage());
		const files = await fs.promises.readdir(sessionDir);
		forkFile = files.map(f => path.join(sessionDir, f)).find(f => f !== filePath)!;
		const forkText = await fs.promises.readFile(forkFile, "utf8");
		const forkLines = forkText.split("\n").filter(l => l?.trim());
		const forkHeader = JSON.parse(forkLines[0]!) as { id: string; parentSession: string };
		expect(forkHeader.id).toBe(fork.sessionId);
		expect(forkHeader.parentSession).toBe(sessionId);
		const forkRows = rows({ entries: forkLines.slice(1).map(l => JSON.parse(l) as { type: string; message?: WireMessage }) });
		expect(forkRows).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
		]);
		// The fork opens as its own session.
		const sub = await call("session.subscribe", { sessionId: fork.sessionId });
		expect(rows(sub.initial)).toEqual([
			{ role: "user", text: "第一轮 A" },
			{ role: "assistant", text: "助手回复 A" },
		]);
	});
});
