import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@musepi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@musepi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@musepi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@musepi/pi-coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@musepi/pi-coding-agent/modes/types";
import type { ToolApprovalRequest } from "@musepi/pi-wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function makeHostContext(): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-approval",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-approval", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "approval test",
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

interface ApprovalHarness {
	pending: Map<string, ToolApprovalRequest>;
	resolved: { requestId: string; approved: boolean }[];
	provider: {
		list(): ToolApprovalRequest[];
		resolve(requestId: string, approved: boolean): boolean;
		subscribe(listener: () => void): () => void;
	};
	publish(request: ToolApprovalRequest): void;
}

function makeApprovals(): ApprovalHarness {
	const pending = new Map<string, ToolApprovalRequest>();
	const listeners = new Set<() => void>();
	const resolved: { requestId: string; approved: boolean }[] = [];
	const notify = (): void => {
		for (const listener of listeners) listener();
	};
	return {
		pending,
		resolved,
		provider: {
			list: () => [...pending.values()],
			resolve(requestId, approved) {
				if (!pending.has(requestId)) return false;
				resolved.push({ requestId, approved });
				pending.delete(requestId);
				notify();
				return true;
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		publish(request) {
			pending.set(request.requestId, request);
			notify();
		},
	};
}

interface TestGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
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
	return {
		socket,
		nextFrame: () => {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			const { promise, resolve } = Promise.withResolvers<CollabFrame>();
			waiters.push(resolve);
			return promise;
		},
	};
}

async function expectWelcome(guest: TestGuest): Promise<void> {
	const frame = await guest.nextFrame();
	if (frame.t !== "welcome") throw new Error(`expected welcome, got ${frame.t}`);
}

const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => installInMemoryRelay());
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	uninstallInMemoryRelay();
});

describe("remote guest tool approvals", () => {
	it("routes only writable guests, resolves the host once, and closes every device", async () => {
		const approvals = makeApprovals();
		const host = new CollabHost(makeHostContext(), "session", approvals.provider);
		await host.start("ws://localhost:8787");
		cleanups.push(() => host.stop("test done"));
		const first = await joinAsGuest(host.link, "writer-a");
		const second = await joinAsGuest(host.link, "writer-b");
		const viewer = await joinAsGuest(host.viewLink, "viewer");
		cleanups.push(
			() => first.socket.close(),
			() => second.socket.close(),
			() => viewer.socket.close(),
		);
		await Promise.all([expectWelcome(first), expectWelcome(second), expectWelcome(viewer)]);

		const request: ToolApprovalRequest = {
			requestId: "approval-1",
			tool: "bash",
			args: { command: "ls" },
			prompt: "Allow tool: bash\n\nls",
		};
		approvals.publish(request);
		expect(await first.nextFrame()).toEqual({ t: "approval-request", request });
		expect(await second.nextFrame()).toEqual({ t: "approval-request", request });

		viewer.socket.send({ t: "approval-response", requestId: request.requestId, approved: true });
		const rejected = await viewer.nextFrame();
		if (rejected.t !== "error") throw new Error(`expected read-only error, got ${rejected.t}`);
		expect(rejected.message).toContain("read-only");
		expect(approvals.resolved).toEqual([]);

		// A later writable guest receives only requests that are still pending.
		const late = await joinAsGuest(host.link, "writer-late");
		cleanups.push(() => late.socket.close());
		await expectWelcome(late);
		expect(await late.nextFrame()).toEqual({ t: "approval-request", request });

		first.socket.send({ t: "approval-response", requestId: request.requestId, approved: false });
		const end = { t: "approval-request-end", requestId: request.requestId } as const;
		expect(await first.nextFrame()).toEqual(end);
		expect(await second.nextFrame()).toEqual(end);
		expect(await late.nextFrame()).toEqual(end);
		expect(approvals.resolved).toEqual([{ requestId: request.requestId, approved: false }]);

		// A late duplicate answer cannot resolve the request a second time.
		second.socket.send({ t: "approval-response", requestId: request.requestId, approved: true });
		approvals.publish({ ...request, requestId: "approval-2" });
		expect(await first.nextFrame()).toEqual({
			t: "approval-request",
			request: { ...request, requestId: "approval-2" },
		});
		expect(approvals.resolved).toHaveLength(1);
	});
});
