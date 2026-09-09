/**
 * HostClient contract: connects to the daemon JSON-RPC WS (token), calls
 * session.list → session.subscribe, applies the initial snapshot + entry/
 * event stream, and exposes the GuestSnapshot shape the renderer consumes.
 *
 * Uses a fake WebSocket global so the WS round-trip is deterministic: the
 * fake's send() answers each JSON-RPC request synchronously through the
 * client's onmessage handler (microtask-driven, no real network/timers).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { GuestSnapshot } from "./client";
import { HostClient } from "./host-client";

interface MessageEventLike {
	data: unknown;
}

type DaemonHandler = (method: string, params: Record<string, unknown>) => unknown;

/** Records each RPC method the host client sends (for asserting answers). */
type CallLog = Array<{ method: string; params: Record<string, unknown> }>;

const INITIAL_SNAPSHOT = {
	stream: "c1",
	initial: {
		header: { id: "s1", title: "test session" },
		entries: [
			{
				type: "message",
				id: "m1",
				message: {
					id: "m1",
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1000,
				},
			},
		],
		state: { isStreaming: false },
		agents: [],
	},
};

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	url: string;
	daemon: DaemonHandler | null = null;
	onopen: (() => void) | null = null;
	onmessage: ((ev: MessageEventLike) => void) | null = null;
	onclose: ((ev: { reason?: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}
	/** Answer the JSON-RPC request synchronously back into the client. */
	send(data: string): void {
		const req = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
		const result = this.daemon?.(req.method, req.params ?? {}) ?? { ok: true };
		this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) });
	}
	close(): void {
		this.onclose?.({ reason: "closed" });
	}
}

/** Connect the client, then open + wire the daemon handler. */
function connectToDaemon(_url: string, handler: DaemonHandler): { ws: FakeWebSocket; calls: CallLog } {
	const instance = FakeWebSocket.instances.at(-1)!;
	const calls: CallLog = [];
	instance.daemon = (method, params) => {
		calls.push({ method, params });
		return handler(method, params);
	};
	instance.onopen?.();
	return { ws: instance, calls };
}

/** Default daemon: session.list + session.subscribe. */
function defaultHandler(): DaemonHandler {
	return method => {
		switch (method) {
			case "session.list":
				return [{ id: "s1", title: "test session" }];
			case "session.subscribe":
				return INITIAL_SNAPSHOT;
			default:
				return { ok: true };
		}
	};
}

const previousWebSocket = globalThis.WebSocket;
afterEach(() => {
	FakeWebSocket.instances = [];
	globalThis.WebSocket = previousWebSocket;
});

/** Resolve when the snapshot satisfies the predicate (checks now + on each
 *  notification — a real async signal via the client's notify). */
function onceSnapshot(client: HostClient, predicate: (snap: GuestSnapshot) => boolean): Promise<void> {
	return new Promise<void>(resolve => {
		if (predicate(client.getSnapshot())) {
			resolve();
			return;
		}
		const unsub = client.subscribe(() => {
			if (predicate(client.getSnapshot())) {
				unsub();
				resolve();
			}
		});
	});
}

/** Drain the microtask queue (the answer RPCs are fire-and-forget `void`). */
async function flushMicrotasks(): Promise<void> {
	await new Promise<void>(resolve => queueMicrotask(resolve));
}

describe("HostClient", () => {
	it("subscribes to the daemon session and applies the initial snapshot", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const client = new HostClient("ws://127.0.0.1:1234/");
		client.connect();
		connectToDaemon("ws://127.0.0.1:1234/", defaultHandler());
		await onceSnapshot(client, s => s.phase === "live");

		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.entries.length).toBe(1);
		expect(snap.entries[0]?.type).toBe("message");
		expect(snap.focusedSessionId).toBe("s1");
		expect(snap.readOnly).toBe(false);
		expect(client.plaintext).toBe(false);
		client.close();
	});

	it("appends entry events and streams assistant message events", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const client = new HostClient("ws://127.0.0.1:1234/");
		client.connect();
		const { ws } = connectToDaemon("ws://127.0.0.1:1234/", defaultHandler());
		await onceSnapshot(client, s => s.phase === "live");

		// Assistant message streaming event.
		ws.onmessage?.({
			data: JSON.stringify({
				kind: "event",
				seq: 1,
				payload: {
					type: "message_start",
					message: { role: "assistant", content: [], timestamp: 2000 },
				},
			}),
		});
		await onceSnapshot(client, s => s.stream?.timestamp === 2000);
		expect(client.getSnapshot().streamDone).toBe(false);

		// New entry folds in (entry event).
		ws.onmessage?.({
			data: JSON.stringify({
				kind: "entry",
				seq: 2,
				payload: {
					type: "message",
					id: "m2",
					message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000 },
				},
			}),
		});
		await onceSnapshot(client, s => s.entries.length === 2);
		expect(client.getSnapshot().entries[1]?.type).toBe("message");
		client.close();
	});

	it("tracks working state via agent_start/agent_end", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const client = new HostClient("ws://127.0.0.1:1234/");
		client.connect();
		const { ws } = connectToDaemon("ws://127.0.0.1:1234/", defaultHandler());
		await onceSnapshot(client, s => s.phase === "live");
		expect(client.getSnapshot().working).toBe(false);

		ws.onmessage?.({ data: JSON.stringify({ kind: "event", seq: 1, payload: { type: "agent_start" } }) });
		await onceSnapshot(client, s => s.working === true);

		ws.onmessage?.({ data: JSON.stringify({ kind: "event", seq: 2, payload: { type: "agent_end" } }) });
		await onceSnapshot(client, s => s.working === false);
		client.close();
	});

	it("surfaces ask requests as uiRequest and answers via session.askAnswer", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const client = new HostClient("ws://127.0.0.1:1234/");
		client.connect();
		const { ws, calls } = connectToDaemon("ws://127.0.0.1:1234/", defaultHandler());
		await onceSnapshot(client, s => s.phase === "live");

		ws.onmessage?.({
			data: JSON.stringify({
				kind: "ask-request",
				seq: 1,
				payload: { requestId: "ask1", title: "Continue?", options: ["Yes", "No"], multi: false, mode: "select" },
			}),
		});
		await onceSnapshot(client, s => s.uiRequest?.kind === "select");
		const ui = client.getSnapshot().uiRequest;
		expect(ui).not.toBeNull();
		if (ui) {
			client.sendUiResponse(ui.reqId, "Yes");
			await flushMicrotasks();
			const ask = calls.find(c => c.method === "session.askAnswer");
			expect(ask).toBeTruthy();
			expect(ask?.params.requestId).toBe("ask1");
			expect(ask?.params.answer).toBe("Yes");
		}
		client.close();
	});

	it("surfaces approval requests and answers via tool.approve", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const client = new HostClient("ws://127.0.0.1:1234/");
		client.connect();
		const { ws, calls } = connectToDaemon("ws://127.0.0.1:1234/", defaultHandler());
		await onceSnapshot(client, s => s.phase === "live");

		ws.onmessage?.({
			data: JSON.stringify({
				kind: "approval-request",
				seq: 1,
				payload: { requestId: "app1", tool: "bash", args: null, prompt: "Allow bash command?" },
			}),
		});
		await onceSnapshot(client, s => s.approvalRequest !== null);
		expect(client.getSnapshot().approvalRequest?.tool).toBe("bash");
		expect(client.getSnapshot().approvalRequest?.requestId).toBe("app1");

		client.respondApproval("app1", true);
		await flushMicrotasks();
		const approve = calls.find(c => c.method === "tool.approve");
		expect(approve?.params.requestId).toBe("app1");

		const denied = calls.find(c => c.method === "tool.deny");
		expect(denied).toBeUndefined();
		client.close();
	});

	it("surfaces recap as a notice", async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		const client = new HostClient("ws://127.0.0.1:1234/");
		client.connect();
		const { ws } = connectToDaemon("ws://127.0.0.1:1234/", defaultHandler());
		await onceSnapshot(client, s => s.phase === "live");

		ws.onmessage?.({
			data: JSON.stringify({ kind: "recap", seq: 1, payload: { text: "You've been idle — recap", at: 1000 } }),
		});
		await onceSnapshot(client, s => s.notices.some(n => n.message.includes("recap")));
		expect(client.getSnapshot().notices[0]?.level).toBe("info");
		client.close();
	});
});
