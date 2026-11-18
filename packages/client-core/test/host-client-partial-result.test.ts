// HostClient must pass tool partial results through unchanged: the daemon
// streams objects (computer's details.viewer among them), and a string-only
// guard silently drops every one of them.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

type SentMessage = { jsonrpc: string; id: number; method: string; params: unknown };

class FakeSocket {
	static instances: FakeSocket[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	readonly sent: SentMessage[] = [];
	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(JSON.parse(data) as SentMessage);
	}
	close(): void {
		this.onclose?.({ reason: "closed" } as CloseEvent);
	}
	respond(id: number, result: unknown): void {
		this.onmessage?.({
			data: JSON.stringify({ jsonrpc: "2.0", id, result }),
		} as MessageEvent);
	}
	emit(frame: { kind: string; payload: unknown }): void {
		this.onmessage?.({
			data: JSON.stringify({ seq: 1, ...frame }),
		} as MessageEvent);
	}
	lastRequest(method: string): SentMessage | undefined {
		return this.sent.findLast(message => message.method === method);
	}
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeSocket.instances = [];
	(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});

afterAll(() => {
	(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

const { HostClient } = await import("../src/lib/host-client");

/** Drives the bootstrap RPCs so the client reaches the live phase. */
async function connect(initial?: {
	activeTools?: unknown[];
}): Promise<{ client: InstanceType<typeof HostClient>; socket: FakeSocket }> {
	const client = new HostClient("ws://test");
	client.connect();
	const socket = FakeSocket.instances[FakeSocket.instances.length - 1]!;
	socket.onopen?.();
	await Promise.resolve();

	const list = socket.lastRequest("session.list");
	expect(list).toBeDefined();
	socket.respond(list!.id, [{ id: "s1" }]);
	await Promise.resolve();

	const subscribe = socket.lastRequest("session.subscribe");
	expect(subscribe).toBeDefined();
	socket.respond(subscribe!.id, {
		initial: {
			header: { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/work" },
			entries: [],
			state: { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] },
			agents: [],
			activeTools: initial?.activeTools ?? [],
		},
	});
	// Let the bootstrap promise chain settle.
	for (let i = 0; i < 5; i++) await Promise.resolve();
	return { client, socket };
}

function toolUpdate(partialResult: unknown): { kind: string; payload: unknown } {
	return {
		kind: "event",
		payload: {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "computer",
			args: {},
			partialResult,
		},
	};
}

describe("HostClient partial results", () => {
	test("keeps an object partial result instead of dropping it", async () => {
		const { client, socket } = await connect();
		socket.emit(toolUpdate({ content: [], details: { viewer: { data: "AAAA", mimeType: "image/png" } } }));

		const tool = client.getSnapshot().activeTools.get("call-1");
		expect(tool).toBeDefined();
		expect(tool!.partialResult).toEqual({
			content: [],
			details: { viewer: { data: "AAAA", mimeType: "image/png" } },
		});

		// A later object update replaces the previous one.
		socket.emit(toolUpdate({ content: [], details: { viewer: { data: "BBBB", mimeType: "image/png" } } }));
		expect(client.getSnapshot().activeTools.get("call-1")!.partialResult).toEqual({
			content: [],
			details: { viewer: { data: "BBBB", mimeType: "image/png" } },
		});
	});

	test("keeps object partial results from the subscribe snapshot", async () => {
		const { client } = await connect({
			activeTools: [
				{
					toolCallId: "call-restored",
					toolName: "computer",
					args: {},
					partialResult: { content: [], details: { viewer: { data: "CCCC" } } },
				},
			],
		});
		expect(client.getSnapshot().activeTools.get("call-restored")!.partialResult).toEqual({
			content: [],
			details: { viewer: { data: "CCCC" } },
		});
	});
});
