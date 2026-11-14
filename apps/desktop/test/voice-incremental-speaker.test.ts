/**
 * Delta-level read-aloud: the desktop now speaks completed sentences while
 * the model is still writing the rest of the reply (terminal vocalizer
 * parity). `feed` receives the current FULL text on every snapshot update;
 * only newly completed sentences may reach tts.synthesize.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";

/** Minimal Web Audio graph so queued segments can complete without a real
 *  speaker; the module-level speakGraph() picks this up on first use. */
class StubAudioContext {
	currentTime = 0;
	destination = {};
	createGain() {
		return { connect: () => {}, gain: { value: 1 } };
	}
	createBufferSource() {
		return {
			buffer: null,
			playbackRate: { value: 1 },
			connect: () => {},
			start: () => {},
			stop: () => {},
			onended: null,
		};
	}
	decodeAudioData() {
		return Promise.resolve({ duration: 0.1 });
	}
	resume() {
		return Promise.resolve();
	}
	suspend() {
		return Promise.resolve();
	}
}
(globalThis as unknown as { AudioContext: unknown }).AudioContext = StubAudioContext;

import type { RpcClient } from "../src/lib/rpc";
import { createIncrementalSpeaker, type IncrementalSpeaker } from "../src/lib/voice";

setLocale("zh-CN");

class FakeRpc {
	calls: { method: string; params: Record<string, unknown> }[] = [];
	rewrite: (text: string) => { text: string | null } | Error = () => ({ text: "改写后的口语。" });
	synthesizeFails = false;

	request<T>(method: string, params?: unknown): Promise<T> {
		this.calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
		if (method === "tts.rewrite") {
			const r = this.rewrite(String((params as { text: string }).text));
			if (r instanceof Error) return Promise.reject(r);
			return Promise.resolve(r as T);
		}
		if (this.synthesizeFails) {
			return Promise.resolve({ audio: null, sampleRate: 0, error: "stop" } as T);
		}
		return Promise.resolve({ audio: [0, 0, 0, 0], sampleRate: 24_000 } as T);
	}

	synthTexts(): string[] {
		return this.calls.filter(c => c.method === "tts.synthesize").map(c => String(c.params.text));
	}
	rewriteTexts(): string[] {
		return this.calls.filter(c => c.method === "tts.rewrite").map(c => String(c.params.text));
	}
	rewriteCalls(): unknown[] {
		return this.calls.filter(c => c.method === "tts.rewrite").map(c => c.params);
	}
}

const asRpc = (fake: FakeRpc): RpcClient => fake as unknown as RpcClient;
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

let active: IncrementalSpeaker | null = null;
afterEach(() => {
	active?.stop();
	active = null;
});

function make(fake: FakeRpc, options: Parameters<typeof createIncrementalSpeaker>[1] = {}): IncrementalSpeaker {
	active = createIncrementalSpeaker(asRpc(fake), options);
	return active;
}

describe("createIncrementalSpeaker", () => {
	it("speaks the first completed sentence while the reply is still streaming", async () => {
		const fake = new FakeRpc();
		const speaker = make(fake);
		speaker.feed("第一句。还在写");
		await tick();
		expect(fake.synthTexts()).toEqual(["第一句。"]);
	});

	it("never re-synthesizes a sentence already spoken", async () => {
		const fake = new FakeRpc();
		const speaker = make(fake);
		speaker.feed("第一句。");
		await tick();
		speaker.feed("第一句。第二句。");
		await tick();
		speaker.feed("第一句。第二句。第三句。");
		await tick();
		expect(fake.synthTexts()).toEqual(["第一句。", "第二句。", "第三句。"]);
	});

	it("holds an unfinished tail until finish() flushes it", async () => {
		const fake = new FakeRpc();
		const speaker = make(fake);
		speaker.feed("第一句。尾巴没写完");
		await tick();
		expect(fake.synthTexts()).toEqual(["第一句。"]);
		speaker.finish();
		await tick();
		expect(fake.synthTexts()).toEqual(["第一句。", "尾巴没写完"]);
	});

	it("ignores feed/finish after stop", async () => {
		const fake = new FakeRpc();
		const speaker = make(fake);
		speaker.feed("第一句。");
		await tick();
		speaker.stop();
		speaker.feed("第一句。第二句。");
		speaker.finish();
		await tick();
		expect(fake.synthTexts()).toEqual(["第一句。"]);
	});

	it("rewrites each completed sentence when enhanced is on", async () => {
		const fake = new FakeRpc();
		const speaker = make(fake, { enhanced: true, sessionId: "session-1" });
		speaker.feed("第一句。第二句。");
		await tick();
		expect(fake.rewriteTexts()).toEqual(["第一句。", "第二句。"]);
		expect(fake.synthTexts()).toEqual(["改写后的口语。", "改写后的口语。"]);
	});

	it("falls back to mechanical cleanup per sentence when the rewrite fails", async () => {
		const fake = new FakeRpc();
		fake.rewrite = () => new Error("no tiny model");
		const speaker = make(fake, { enhanced: true, sessionId: "session-1" });
		speaker.feed("第一句。第二句。");
		await tick();
		expect(fake.synthTexts()).toEqual(["第一句。", "第二句。"]);
	});

	it("skips sentences the rewrite judged unspeakable", async () => {
		const fake = new FakeRpc();
		fake.rewrite = () => ({ text: "" });
		const speaker = make(fake, { enhanced: true, sessionId: "session-1" });
		speaker.feed("第一句。第二句。");
		await tick();
		expect(fake.synthTexts()).toEqual([]);
	});

	it("speaks text before an open fence and waits for the code block to close", async () => {
		const fake = new FakeRpc();
		const speaker = make(fake);
		speaker.feed("第一句。\n\n```ts\nconst a = 1;\n");
		await tick();
		expect(fake.synthTexts()).toEqual(["第一句。"]);
		speaker.feed("第一句。\n\n```ts\nconst a = 1;\n```\n\n第二句。");
		await tick();
		expect(fake.synthTexts().join(" ")).toContain("第二句。");
	});

	it("caps per-reply rewrite calls at 12 sentences", async () => {
		const fake = new FakeRpc();
		const speaker = make(fake, { enhanced: true, sessionId: "session-1" });
		const text = Array.from({ length: 14 }, (_, i) => `第${i + 1}句。`).join("");
		speaker.feed(text);
		await tick();
		expect(fake.rewriteCalls()).toHaveLength(12);
		expect(fake.synthTexts()).toHaveLength(14);
	});

	it("stops queueing synthesis after the backend fails once", async () => {
		const fake = new FakeRpc();
		fake.synthesizeFails = true;
		const speaker = make(fake);
		speaker.feed("第一句。第二句。第三句。");
		await tick();
		expect(fake.synthTexts()).toEqual(["第一句。"]);
	});
});
