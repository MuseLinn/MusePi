import { describe, expect, test } from "bun:test";
import type { RpcClient, StreamEvent } from "../src/lib/rpc";
import { openFrontendDictation } from "../src/lib/voice";

class FakeRpc {
	readonly requests: { method: string; params: unknown }[] = [];
	readonly #listeners = new Set<(event: StreamEvent) => void>();
	readonly results: unknown[] = [];

	request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params });
		if (method === "voice.frontendStreamStart") return Promise.resolve({ sessionId: "voice-test" } as T);
		if (method === "voice.frontendStreamStop") return Promise.resolve({ results: this.results } as T);
		return Promise.resolve({ ok: true } as T);
	}

	addEventListener(listener: (event: StreamEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(payload: unknown): void {
		for (const listener of this.#listeners) listener({ kind: "event", seq: 1, payload });
	}
}

function asRpc(fake: FakeRpc): RpcClient {
	return fake as unknown as RpcClient;
}

function callbacks(fake: FakeRpc) {
	const partials: string[] = [];
	const segments: string[] = [];
	const finals: string[] = [];
	const reviews: string[] = [];
	let empty = 0;
	return {
		partials,
		segments,
		finals,
		reviews,
		empty: () => empty,
		options: {
			rpc: asRpc(fake),
			modelKey: "balanced" as const,
			speakerMode: "prefer" as const,
			enhanceAudio: false,
			onPartial: (text: string) => partials.push(text),
			onSegment: (text: string) => segments.push(text),
			onFinal: (text: string) => finals.push(text),
			onReview: (text: string) => reviews.push(text),
			onEmpty: () => {
				empty += 1;
			},
			onError: (message: string) => {
				throw new Error(message);
			},
		},
	};
}

describe("streaming dictation", () => {
	test("partial text is volatile and never inserted as a final segment", async () => {
		const fake = new FakeRpc();
		const seen = callbacks(fake);
		const stream = await openFrontendDictation(seen.options);
		fake.emit({ type: "voice.frontendPartial", sessionId: "voice-test", segmentId: 0, text: "hel", state: "accept" });
		expect(seen.partials).toEqual(["hel"]);
		expect(seen.segments).toEqual([]);
		expect(seen.finals).toEqual([]);
		stream.cancel();
	});

	test("accepted segments insert immediately and retain normal final handling", async () => {
		const fake = new FakeRpc();
		const seen = callbacks(fake);
		const stream = await openFrontendDictation(seen.options);
		fake.emit({
			type: "voice.frontendSegment",
			sessionId: "voice-test",
			segmentId: 0,
			text: "hello",
			state: "accept",
		});
		await stream.stop();
		expect(seen.segments).toEqual(["hello"]);
		expect(seen.finals).toEqual(["hello"]);
		expect(seen.reviews).toEqual([]);
	});

	test("an uncertain segment forces draft review instead of final submission", async () => {
		const fake = new FakeRpc();
		const seen = callbacks(fake);
		const stream = await openFrontendDictation(seen.options);
		fake.emit({
			type: "voice.frontendSegment",
			sessionId: "voice-test",
			segmentId: 0,
			text: "accepted",
			state: "accept",
		});
		fake.emit({
			type: "voice.frontendSegment",
			sessionId: "voice-test",
			segmentId: 1,
			text: "uncertain",
			state: "uncertain",
		});
		await stream.stop();
		expect(seen.finals).toEqual([]);
		expect(seen.reviews).toEqual(["accepted uncertain"]);
	});

	test("rejected audio produces no transcript or review", async () => {
		const fake = new FakeRpc();
		const seen = callbacks(fake);
		const stream = await openFrontendDictation(seen.options);
		fake.emit({
			type: "voice.frontendSegment",
			sessionId: "voice-test",
			segmentId: 0,
			text: "other person",
			state: "reject",
		});
		await stream.stop();
		expect(seen.segments).toEqual([]);
		expect(seen.finals).toEqual([]);
		expect(seen.reviews).toEqual([]);
		expect(seen.empty()).toBe(1);
	});

	test("cancel invalidates late partials, segments, and stop settlement", async () => {
		const fake = new FakeRpc();
		const seen = callbacks(fake);
		const stream = await openFrontendDictation(seen.options);
		stream.cancel();
		fake.emit({
			type: "voice.frontendPartial",
			sessionId: "voice-test",
			segmentId: 0,
			text: "late",
			state: "accept",
		});
		fake.emit({
			type: "voice.frontendSegment",
			sessionId: "voice-test",
			segmentId: 0,
			text: "late",
			state: "accept",
		});
		await stream.stop();
		expect(seen.partials).toEqual([]);
		expect(seen.segments).toEqual([]);
		expect(seen.finals).toEqual([]);
	});
});
