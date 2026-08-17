/**
 * Guest RPC contract over the wire: board/cron/workspace/fs methods served
 * by CollabHost#rpc-request. Reuses the in-memory relay harness from the
 * read-only suite. Deliberately zero-write: every assertion reads state
 * that is absent in CI (no ~/.musepi boards/crons) or rejects before
 * touching disk, so the suite never mutates the user's real stores.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@musepi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@musepi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@musepi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@musepi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@musepi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function makeHostContext(): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

interface TestGuest {
	socket: CollabSocket;
	rpc(method: string, params?: unknown): Promise<CollabFrame & { t: "rpc-result" }>;
	close(): void;
}

const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	let reqSeq = 0;
	const rpc = async (method: string, params?: unknown): Promise<CollabFrame & { t: "rpc-result" }> => {
		const reqId = ++reqSeq;
		socket.send({ t: "rpc-request", reqId, method, params });
		let frame = await nextFrame();
		while (frame.t !== "rpc-result") frame = await nextFrame();
		const result = frame as CollabFrame & { t: "rpc-result" };
		expect(result.reqId).toBe(reqId);
		return result;
	};
	return {
		socket,
		rpc,
		close: () => socket.close(),
	};
}

const guestCleanups: (() => void)[] = [];
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeHostContext());
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

describe("collab guest rpc", () => {
	it("board.list returns the boards array (empty in CI)", async () => {
		const guest = await joinAsGuest(host.link, "rpc-test");
		guestCleanups.push(() => guest.close());
		const res = await guest.rpc("board.list");
		expect(res.ok).toBe(true);
		expect(Array.isArray((res.data as { boards?: unknown }).boards)).toBe(true);
	});

	it("cron.list returns tasks + runs arrays", async () => {
		const guest = await joinAsGuest(host.link, "rpc-test");
		guestCleanups.push(() => guest.close());
		const res = await guest.rpc("cron.list");
		expect(res.ok).toBe(true);
		const data = res.data as { tasks?: unknown; runs?: unknown };
		expect(Array.isArray(data.tasks)).toBe(true);
		expect(Array.isArray(data.runs)).toBe(true);
	});

	it("workspace.tree returns a root + entries for the session cwd", async () => {
		const guest = await joinAsGuest(host.link, "rpc-test");
		guestCleanups.push(() => guest.close());
		const res = await guest.rpc("workspace.tree", { maxDepth: 1, perDirLimit: 5 });
		expect(res.ok).toBe(true);
		const data = res.data as { rootPath?: unknown; truncated?: unknown; entries?: unknown };
		expect(data.rootPath).toBe("/tmp");
		expect(Array.isArray(data.entries)).toBe(true);
	});

	it("fs.read rejects paths escaping the workspace", async () => {
		const guest = await joinAsGuest(host.link, "rpc-test");
		guestCleanups.push(() => guest.close());
		const res = await guest.rpc("fs.read", { path: "../../etc/passwd" });
		expect(res.ok).toBe(false);
		expect(String(res.error)).toMatch(/escapes|workspace/i);
	});

	it("fs.read rejects a directory with a clear error", async () => {
		const guest = await joinAsGuest(host.link, "rpc-test");
		guestCleanups.push(() => guest.close());
		const res = await guest.rpc("fs.read", { path: "." });
		expect(res.ok).toBe(false);
	});

	it("unknown method returns ok:false", async () => {
		const guest = await joinAsGuest(host.link, "rpc-test");
		guestCleanups.push(() => guest.close());
		const res = await guest.rpc("bogus.method");
		expect(res.ok).toBe(false);
		expect(String(res.error)).toContain("unknown rpc method");
	});

	it("read-only (view-link) guests are refused mutating methods", async () => {
		expect(host.viewLink).not.toBe(host.link);
		const guest = await joinAsGuest(host.viewLink, "rpc-test");
		guestCleanups.push(() => guest.close());
		const res = await guest.rpc("fs.write", { path: "x.txt", content: "hi" });
		expect(res.ok).toBe(false);
		expect(String(res.error)).toMatch(/read-only/i);
	});

	it("read-only guests may still read", async () => {
		const guest = await joinAsGuest(host.viewLink, "rpc-test");
		guestCleanups.push(() => guest.close());
		const res = await guest.rpc("board.list");
		expect(res.ok).toBe(true);
	});
});
