import { afterEach, describe, expect, test } from "bun:test";
import { EventBatcher } from "../src/daemon/event-batcher";

/**
 * EventBatcher contract: events pushed within the flush window coalesce into
 * ONE `{ kind: "batch", events }` frame; a lone event in a window ships as
 * itself; per-event seq is preserved; maxEvents forces an immediate drain;
 * backpressure defers flushes up to a bounded deadline then forces through.
 */

function collect() {
	const frames: unknown[] = [];
	return {
		frames,
		send: (m: unknown) => void frames.push(m),
	};
}

async function flushWindow(ms = 20): Promise<void> {
	await new Promise(r => setTimeout(r, ms));
}

afterEach(() => {
	// No stray timers across tests.
});

describe("EventBatcher coalescing", () => {
	test("lone event in a window ships as itself (no batch envelope)", async () => {
		const { frames, send } = collect();
		const batcher = new EventBatcher(send, { windowMs: 5 });
		batcher.push({ kind: "event", seq: 1, payload: { type: "turn_start" } });
		await flushWindow();
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ kind: "event", seq: 1, payload: { type: "turn_start" } });
	});

	test("burst coalesces into one batch frame with order and seq preserved", async () => {
		const { frames, send } = collect();
		const batcher = new EventBatcher(send, { windowMs: 5 });
		for (let i = 1; i <= 10; i++) {
			batcher.push({ kind: "event", seq: i, payload: { n: i } });
		}
		await flushWindow();
		expect(frames).toHaveLength(1);
		const frame = frames[0] as { kind: string; events: { seq: number; payload: { n: number } }[] };
		expect(frame.kind).toBe("batch");
		expect(frame.events).toHaveLength(10);
		expect(frame.events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(frame.events[9]?.payload.n).toBe(10);
	});

	test("events after a flush start a new batch", async () => {
		const { frames, send } = collect();
		const batcher = new EventBatcher(send, { windowMs: 5 });
		batcher.push({ kind: "event", seq: 1, payload: {} });
		await flushWindow();
		batcher.push({ kind: "event", seq: 2, payload: {} });
		await flushWindow();
		expect(frames).toHaveLength(2);
	});

	test("maxEvents drains immediately with bounded frame size", async () => {
		const { frames, send } = collect();
		const batcher = new EventBatcher(send, { windowMs: 60_000, maxEvents: 3 });
		for (let i = 1; i <= 6; i++) batcher.push({ kind: "event", seq: i, payload: {} });
		// No timer flush yet — the maxEvents bound must have fired.
		expect(frames).toHaveLength(2);
		expect((frames[0] as { events: unknown[] }).events).toHaveLength(3);
		expect((frames[1] as { events: unknown[] }).events).toHaveLength(3);
		batcher.flushNow();
	});

	test("flushNow sends everything queued", () => {
		const { frames, send } = collect();
		const batcher = new EventBatcher(send, { windowMs: 60_000 });
		batcher.push({ kind: "event", seq: 1, payload: {} });
		batcher.push({ kind: "event", seq: 2, payload: {} });
		batcher.flushNow();
		expect(frames).toHaveLength(1);
		expect((frames[0] as { events: unknown[] }).events).toHaveLength(2);
		expect(batcher.hasPending).toBe(false);
	});
});

describe("EventBatcher backpressure", () => {
	test("flush defers while buffered above threshold, then forces through after the defer budget", async () => {
		const { frames, send } = collect();
		const buffered = 2 * 1024 * 1024; // above the 1 MiB default
		const batcher = new EventBatcher(send, { windowMs: 2, maxDeferMs: 30, buffered: () => buffered });
		batcher.push({ kind: "event", seq: 1, payload: {} });
		await flushWindow(10);
		// Still backed up and inside the defer budget — nothing sent.
		expect(frames).toHaveLength(0);
		await flushWindow(60);
		// Defer budget exhausted — forced through.
		expect(frames).toHaveLength(1);
	});

	test("backpressure clears as soon as the buffer drains", async () => {
		const { frames, send } = collect();
		let buffered = 2 * 1024 * 1024;
		const batcher = new EventBatcher(send, { windowMs: 2, maxDeferMs: 60_000, buffered: () => buffered });
		batcher.push({ kind: "event", seq: 1, payload: {} });
		await flushWindow(10);
		expect(frames).toHaveLength(0);
		buffered = 0; // consumer caught up
		await flushWindow(10);
		expect(frames).toHaveLength(1);
	});
});
