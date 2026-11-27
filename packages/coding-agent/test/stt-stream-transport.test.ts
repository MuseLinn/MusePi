import { describe, expect, it } from "bun:test";
import { SttClient } from "../src/stt/asr-client";
import type { SttWorkerInbound, SttWorkerOutbound } from "../src/stt/asr-protocol";
import type { RefCountedWorkerHandle } from "../src/subprocess/worker-client";

/** A worker handle that records what the client sends and answers on demand. */
class FakeWorker implements RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> {
	readonly sent: SttWorkerInbound[] = [];
	#handler: ((message: SttWorkerOutbound) => void) | null = null;

	send(message: SttWorkerInbound): void {
		this.sent.push(message);
	}
	onMessage(handler: (message: SttWorkerOutbound) => void): () => void {
		this.#handler = handler;
		return () => {
			this.#handler = null;
		};
	}
	onError(): () => void {
		return () => {};
	}
	async terminate(): Promise<void> {}
	ref(): void {}
	unref(): void {}
	emit(message: SttWorkerOutbound): void {
		this.#handler?.(message);
	}
	types(): string[] {
		return this.sent.map(message => message.type);
	}
}

function client(): { stt: SttClient; worker: FakeWorker } {
	const worker = new FakeWorker();
	return { stt: new SttClient(() => worker), worker };
}

describe("stt stream transport", () => {
	it("distinguishes raw frames from caller-delimited runs", () => {
		const { stt, worker } = client();
		const stream = stt.startStream("balanced");
		stream.pushAudio(new Float32Array(320));
		stream.pushUtterance(new Float32Array(16_000));
		const streamed = worker.types();
		// A run the caller already cut must arrive as its own message: sending it
		// as `stream_audio` would make the worker re-segment it and hold the commit
		// until `stream_stop` — the "text only appears when I stop talking" bug.
		expect(streamed).toContain("stream_audio");
		expect(streamed).toContain("stream_utterance");
		expect(worker.sent.filter(message => message.type === "stream_utterance").length).toBe(1);
	});

	it("keeps previews on their own channel so they never commit", () => {
		const { stt, worker } = client();
		const stream = stt.startStream("balanced");
		stream.pushPreview(new Float32Array(8_000));
		expect(worker.types()).toContain("stream_preview");
		expect(worker.types()).not.toContain("stream_utterance");
	});

	it("routes preview and segment words to their own callbacks", async () => {
		const { stt, worker } = client();
		const partials: string[] = [];
		const segments: string[] = [];
		const stream = stt.startStream("balanced", {
			onPartial: text => partials.push(text),
			onSegment: (text, index) => segments.push(`${index}:${text}`),
		});
		const id = (worker.sent[0] as { id: string }).id;
		worker.emit({ type: "partial", id, text: "hel" });
		worker.emit({ type: "segment", id, index: 0, text: "hello" });
		worker.emit({ type: "partial", id, text: "wor" });
		worker.emit({ type: "stream_done", id, text: "hello world" });
		expect(partials).toEqual(["hel", "wor"]);
		expect(segments).toEqual(["0:hello"]);
		expect(await stream.stop()).toBe("hello world");
	});

	it("drops audio for a stream that was already cancelled", () => {
		const { stt, worker } = client();
		const stream = stt.startStream("balanced");
		stream.cancel();
		const before = worker.sent.length;
		stream.pushUtterance(new Float32Array(16_000));
		stream.pushPreview(new Float32Array(16_000));
		expect(worker.sent.length).toBe(before);
	});
});
