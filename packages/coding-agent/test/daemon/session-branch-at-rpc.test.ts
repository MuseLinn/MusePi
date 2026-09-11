import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * `session.branchAt` entry resolution. This is the single RPC behind the
 * transcript's 撤回 / 编辑 / 重试 buttons, the message tree, the breadcrumb and
 * the canvas — all of which appeared to be dead buttons because this handler
 * threw before doing anything.
 *
 * Two real crashes it must not regress into:
 *  1. An entry of `type: "message"` need not carry a `message` payload (the SDK
 *     file mixes in bookkeeping records). Scanning them unguarded threw
 *     "undefined is not an object (evaluating 'message.role')".
 *  2. The navigated-to leaf need not be a message — `model_change` /
 *     `thinking_level_change` are legitimate leaves — and `messageKey`
 *     dereferences `.message`, so keying it directly threw the same error out
 *     of an otherwise successful branch.
 *
 * Plus the composer contract: 编辑 must hand back the target message's text,
 * including when the leaf is ALREADY there (navigateTree takes a no-op exit and
 * returns no editorText — exactly the state 撤回 leaves behind).
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

function runBranchAt(
	entries: StubEntry[],
	leafEntry: StubEntry,
	targetId: string,
): Promise<{ ok?: boolean; leafId?: string | null; editorText?: string | null }> {
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
		}),
		setCollabToolProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test" } as unknown as DaemonConnection;
	return server.handle("session.branchAt", { sessionId: "s1", messageId: targetId }, conn) as Promise<{
		ok?: boolean;
		leafId?: string | null;
		editorText?: string | null;
	}>;
}

describe("session.branchAt", () => {
	test("resolves a view key whose message entries include payload-less records", async () => {
		const user: StubEntry = {
			id: "u1",
			type: "message",
			message: { role: "user", timestamp: 111, content: [{ type: "text", text: "hello" }] },
		};
		const entries: StubEntry[] = [
			// A "message" record with NO payload — the shape that crashed the scan.
			{ id: "broken", type: "message" },
			user,
		];

		const res = await runBranchAt(entries, user, keyOf(user.message!));
		expect(res.ok).toBe(true);
	});

	test("keys the leaf by its nearest message ancestor", async () => {
		const user: StubEntry = {
			id: "u1",
			type: "message",
			message: { role: "user", timestamp: 111, content: [{ type: "text", text: "hi" }] },
		};
		// Leaf is a bookkeeping record whose parent is the user message; keying
		// the leaf itself would dereference a missing `.message`.
		const leaf: StubEntry = { id: "t1", type: "thinking_level_change", parentId: "u1" };
		const entries: StubEntry[] = [user, leaf];

		const res = await runBranchAt(entries, leaf, keyOf(user.message!));
		expect(res.ok).toBe(true);
		expect(res.leafId).toBe(keyOf(user.message!));
	});

	test("hands back the target user message text when navigation reports none", async () => {
		const user: StubEntry = {
			id: "u1",
			type: "message",
			message: { role: "user", timestamp: 111, content: [{ type: "text", text: "edit me" }] },
		};

		// The 撤回-then-编辑 case: navigator returns no editorText.
		const res = await runBranchAt([user], user, keyOf(user.message!));
		expect(res.editorText).toBe("edit me");
	});
});
