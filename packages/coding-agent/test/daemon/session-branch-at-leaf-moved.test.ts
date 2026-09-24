import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@musepi/pi-wire";
import { MaterializedView } from "@musepi/sdk";
import { isWireAgentEvent, toWireAgentEvent } from "../../src/collab/wire-guard";
import { AppendJournal } from "../../src/daemon/journal";
import { type DaemonConnection, DaemonServer, DaemonSessionHost } from "../../src/daemon/server";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";

/**
 * `session.branchAt` leaf-move broadcast (`session_leaf_moved`) + rewind-to-root.
 *
 * navigateTree only repositions the SDK tree's leaf pointer — it appends no
 * entry and fires no agent event, and the GUI store learns exclusively from
 * the event stream. Without a broadcast, 撤回/切分支 left every subscribing
 * client stuck on the stale active path forever. The daemon must therefore
 * publish a synthetic `session_leaf_moved` wire event through the live
 * session's publishWireEvent (journal seq == broadcast seq, catchup-replayable),
 * and the FIRST user message's 撤回 must reach the ROOT: its wire parentId is
 * null by snapshot-rekey construction, navigateTree lands there via resetLeaf,
 * and the 编辑契约 still hands the message text back as editorText.
 */
interface StubEntry {
	id: string;
	type?: string;
	parentId?: string | null;
	message?: { role?: string; content?: unknown; timestamp?: number; toolCallId?: string };
}

/** Wire message key the view (and therefore the GUI) uses. */
const keyOf = (m: NonNullable<StubEntry["message"]>): string =>
	m.role === "toolResult" ? `toolResult:${m.toolCallId}` : `${m.role}:${m.timestamp}`;

function captureConn(): { conn: DaemonConnection; frames: () => { seq: number; payload: unknown }[] } {
	const sent: unknown[] = [];
	const conn = {
		id: "leaf-moved-test",
		writableLength: () => 0,
		send: (m: unknown) => {
			sent.push(m);
		},
	} as unknown as DaemonConnection;
	return {
		conn,
		frames: () =>
			sent.flatMap(m => {
				// The batcher coalesces pushes into "batch" frames when a replay
				// page fills, but a sub-page tail flush rides as bare "event"
				// frames — unwrap both shapes so the assertion reads journal
				// order regardless of batching.
				const frame = m as {
					kind?: string;
					seq?: number;
					payload?: unknown;
					events?: { seq: number; payload: unknown }[];
				};
				if (frame?.kind === "batch" && Array.isArray(frame.events)) return frame.events;
				if (frame?.kind === "event") return [{ seq: frame.seq ?? 0, payload: frame.payload }];
				return [];
			}),
	};
}

/** Drive the RPC against a stubbed host; returns the response plus every
 *  event the handler published through the live session's broadcast seam. */
async function runBranchAt(
	entries: StubEntry[],
	leafEntry: StubEntry | undefined,
	targetId: string,
): Promise<{ res: { ok?: boolean; leafId?: string | null; editorText?: string | null }; published: unknown[] }> {
	const published: unknown[] = [];
	const host = {
		cwd: () => "/tmp",
		get: () => ({
			agentSession: {
				sessionManager: {
					getEntries: () => entries,
					getLeafEntry: () => leafEntry,
				},
				// A successful navigation that reports no editor text — the
				// early no-op exit when the leaf is already at the target.
				navigateTree: async () => ({ cancelled: false }),
			},
			// Spy on the live-session broadcast seam: the daemon must fan the
			// synthetic event out through publishWireEvent (journal + view +
			// subscribers), never through a side channel.
			publishWireEvent: (event: unknown) => {
				published.push(event);
			},
		}),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const { conn } = captureConn();
	const res = (await server.handle("session.branchAt", { sessionId: "s1", messageId: targetId }, conn)) as {
		ok?: boolean;
		leafId?: string | null;
		editorText?: string | null;
	};
	return { res, published };
}

describe("session.branchAt leaf-move broadcast", () => {
	test("publishes session_leaf_moved with the new leaf's view key", async () => {
		const user: StubEntry = {
			id: "u1",
			type: "message",
			message: { role: "user", timestamp: 111, content: [{ type: "text", text: "hi" }] },
		};
		const assistant: StubEntry = {
			id: "a1",
			type: "message",
			message: { role: "assistant", timestamp: 112, content: [{ type: "text", text: "hello" }] },
		};
		// Leaf was the assistant reply; branching at the user message moves the
		// leaf to its parent (the user message in this stub topology).
		const { res, published } = await runBranchAt([user, assistant], user, keyOf(user.message!));
		expect(res.ok).toBe(true);
		// Regression: without the broadcast the GUI store (event-stream-fed)
		// never learned the active path changed — 撤回 kept rendering the
		// dropped tail forever.
		expect(published).toEqual([{ type: "session_leaf_moved", leafId: keyOf(user.message!) }]);
	});

	test("a cancelled navigation publishes nothing and answers ok:false", async () => {
		const user: StubEntry = {
			id: "u1",
			type: "message",
			message: { role: "user", timestamp: 111, content: [{ type: "text", text: "hi" }] },
		};
		const published: unknown[] = [];
		const host = {
			cwd: () => "/tmp",
			get: () => ({
				agentSession: {
					sessionManager: {
						getEntries: () => [user],
						getLeafEntry: () => user,
					},
					navigateTree: async () => ({ cancelled: true }),
				},
				publishWireEvent: (event: unknown) => {
					published.push(event);
				},
			}),
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const { conn } = captureConn();
		const res = (await server.handle("session.branchAt", { sessionId: "s1", messageId: "u1" }, conn)) as {
			ok?: boolean;
		};
		// The user vetoed (session_before_tree cancel) — the leaf did not move,
		// so clients must not be told it did.
		expect(res.ok).toBe(false);
		expect(published).toEqual([]);
	});

	test("rewind-to-root: the first user message lands the leaf on the ROOT, editorText carries its text", async () => {
		// The wire snapshot rekeys the first user message's parentId to null —
		// its parent is the session root. navigateTree resolves the user
		// target to that null parent and calls resetLeaf; getLeafEntry()
		// answers undefined (no message at the root), which must surface as
		// leafId:null — NOT as a thrown "undefined is not an object" out of
		// the leaf-key walk — and the 编辑契约 still backfills the message
		// text (rewind-then-edit used to dead-end on an empty composer).
		const user: StubEntry = {
			id: "u1",
			type: "message",
			message: { role: "user", timestamp: 111, content: [{ type: "text", text: "edit me" }] },
		};
		const { res, published } = await runBranchAt([user], undefined, keyOf(user.message!));
		expect(res.ok).toBe(true);
		expect(res.leafId).toBeNull();
		expect(res.editorText).toBe("edit me");
		// The broadcast agrees with the response: null = the root.
		expect(published).toEqual([{ type: "session_leaf_moved", leafId: null }]);
	});
});

describe("session_leaf_moved wire contract", () => {
	test("crosses the wire guard and projects 1:1 through toWireAgentEvent", () => {
		const event: AgentSessionEvent = { type: "session_leaf_moved", leafId: "user:111" };
		// The guard whitelists what may cross the daemon boundary (journal,
		// live stream, collab replication) — a type missing from it would
		// silently drop the broadcast on every isWireAgentEvent-checked path.
		expect(isWireAgentEvent(event)).toBe(true);
		expect(toWireAgentEvent(event)).toEqual(event);
	});

	test("is a safe no-op for the materialized view (no entries projected)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply({ type: "session_leaf_moved", leafId: null } as never);
		// Leaf moves mutate no transcript rows — the view must not invent any.
		expect(view.snapshot().entries).toHaveLength(0);
	});

	test("is journal-replayable: catchup pushes it with its journal seq", async () => {
		// Regression: a journaled session_leaf_moved that catchup skipped or
		// renumbered would leave a refreshing client with a hole (reorder
		// buffer stall) or a duplicate (watermark divergence).
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-moved-journal-"));
		const journal = new AppendJournal(dir, "leaf-moved-s1");
		await journal.open();
		journal.append({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 111 },
		} as unknown as AgentEvent);
		const leafSeq = journal.append({ type: "session_leaf_moved", leafId: null } as unknown as AgentEvent);
		await journal.close();

		const host = new DaemonSessionHost();
		try {
			const { conn, frames } = captureConn();
			const result = await host.replayCatchup("leaf-moved-s1", leafSeq - 1, journal, conn);
			expect(result).toEqual({ ok: true });
			const pushed = frames();
			expect(pushed.map(e => e.seq)).toEqual([leafSeq]);
			expect(pushed[0].payload).toEqual({ type: "session_leaf_moved", leafId: null });
		} finally {
			host.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
