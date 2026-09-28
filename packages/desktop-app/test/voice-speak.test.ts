import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import type { RpcClient, StreamEvent } from "../src/lib/rpc";
import { sanitizeForSpeech, speak, splitSpeakableSentences } from "../src/lib/voice";

/**
 * Read-aloud contracts (2026-09-28, MeloTTS latency/pause pass):
 *
 * 1. splitSpeakableSentences: full-width 。！？ end a segment WITHOUT trailing
 *    whitespace (Chinese sentences abut), ASCII enders require whitespace so
 *    "3.14" / "example.com" never split, oversize segments split at clause
 *    punctuation, stubby fragments (<4 chars) merge into the next sentence.
 * 2. sanitizeForSpeech: markdown → spoken text (code → localized placeholder
 *    even in raw mode, links → label, bare URLs → host, headings/lists/tables
 *    flattened, inline code keeps its identifier incl. snake_case).
 * 3. speak() over the daemon RPC: failure responses surface the worker error
 *    text through onState (audio:null + error field); a multi-sentence reply
 *    synthesizes ONE tts.synthesize per sentence, first call carrying the
 *    first sentence (sentence-streamed, not one-shot).
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

/* ── splitSpeakableSentences ────────────────────────────────────── */

describe("splitSpeakableSentences", () => {
	test("cuts Mandarin sentences at 。/！/？ without waiting for whitespace", () => {
		expect(splitSpeakableSentences("已经改好了。简单说两个要点：第一点是缓存。")).toEqual([
			"已经改好了。",
			"简单说两个要点：第一点是缓存。",
		]);
	});

	test("keeps Chinese closing brackets attached to the sentence ender", () => {
		expect(splitSpeakableSentences("他说「就这样吧。」好的。")).toEqual(["他说「就这样吧。」", "好的。"]);
	});

	test("never splits decimals or mid-word dots, cuts ASCII sentences only at whitespace", () => {
		expect(splitSpeakableSentences("版本 3.14 已发布。详见 example.com 说明。")).toEqual([
			"版本 3.14 已发布。",
			"详见 example.com 说明。",
		]);
	});

	test("merges stubby fragments below the minimum segment length", () => {
		// "好的。" is 3 chars (< SEGMENT_MIN_CHARS): merging keeps MeloTTS
		// from being asked to prosody a two-syllable utterance alone.
		expect(splitSpeakableSentences("好的。收到。")).toEqual(["好的。收到。"]);
	});

	test("splits an overlong sentence at full-width clause punctuation instead of mid-phrase", () => {
		const long = Array.from({ length: 60 }, () => "某字段").join("，") + "。";
		expect(long.length).toBeGreaterThan(180);
		const segments = splitSpeakableSentences(long);
		expect(segments.length).toBeGreaterThan(1);
		for (const segment of segments) {
			expect(segment.length).toBeLessThanOrEqual(180);
			expect(segment.length).toBeGreaterThan(0);
		}
		// Every cut landed on punctuation, never inside a word.
		for (const segment of segments.slice(0, -1)) expect(segment).toMatch(/[,，、;；:：]$/);
	});
});

/* ── sanitizeForSpeech ──────────────────────────────────────────── */

describe("sanitizeForSpeech", () => {
	test("replaces fenced code with the localized placeholder, even in raw mode", () => {
		const md = "结果如下：\n```ts\nconst x = 1;\n```\n完毕。";
		expect(sanitizeForSpeech(md, "sanitize")).toBe("结果如下： 代码块 完毕。");
		expect(sanitizeForSpeech(md, "raw")).toBe("结果如下： 代码块 完毕。");
	});

	test("speaks the link label and the bare URL's host, not the href", () => {
		expect(
			sanitizeForSpeech("详见 [发布说明](https://example.com/notes?v=1) 和 https://example.com/a/b。", "sanitize"),
		).toBe("详见 发布说明 和 example.com。");
	});

	test("flattens headings, numbered lists, and tables into spoken prose", () => {
		const md = "# 部署步骤\n1. 备份数据\n2. 重启服务\n\n| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |";
		expect(sanitizeForSpeech(md, "sanitize")).toBe("部署步骤 1, 备份数据 2, 重启服务 名称，值 甲，1");
	});

	test("inline code keeps its identifier, snake_case underscore included", () => {
		expect(sanitizeForSpeech("用 `my_var` 保存结果，再读 `config.path`。", "sanitize")).toBe(
			"用 my_var 保存结果，再读 config.path。",
		);
	});

	test("summarize keeps the first two sentences and marks truncation", () => {
		const md = "已经改好了。第一点是缓存。第二点是预取。第三点以后再讲。";
		expect(sanitizeForSpeech(md, "summarize")).toBe("已经改好了。第一点是缓存。…");
	});
});

/* ── speak() over the daemon RPC ────────────────────────────────── */

/** Same minimal double as voice-settings.test.tsx. */
class FakeRpc {
	requests: { method: string; params: unknown }[] = [];
	#handlers = new Set<(event: StreamEvent) => void>();
	responses = new Map<string, unknown>();

	request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params: params ?? {} });
		return Promise.resolve(this.responses.get(method) as T);
	}

	addEventListener(handler: (event: StreamEvent) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	calls(method: string): unknown[] {
		return this.requests.filter(r => r.method === method).map(r => r.params);
	}
}

const asRpc = (fake: FakeRpc): RpcClient => fake as unknown as RpcClient;

/** Minimal AudioContext double: decode reports a tiny duration so the drain
 *  timer finishes in milliseconds; currentTime is frozen past the schedule
 *  window so no real audio time has to elapse. */
class FakeAudioContext {
	currentTime = 10_000;
	destination = {};
	async resume(): Promise<void> {}
	async suspend(): Promise<void> {}
	createGain(): { gain: { value: number }; connect(): void } {
		return { gain: { value: 1 }, connect: () => {} };
	}
	createBufferSource(): {
		buffer: unknown;
		playbackRate: { value: number };
		onended: (() => void) | null;
		connect(): void;
		start(): void;
		stop(): void;
	} {
		return {
			buffer: null,
			playbackRate: { value: 1 },
			onended: null,
			connect: () => {},
			start: () => {},
			stop: () => {},
		};
	}
	async decodeAudioData(): Promise<AudioBuffer> {
		return { duration: 0.05 } as unknown as AudioBuffer;
	}
}

const realAudioContext = globalThis.AudioContext;
afterAll(() => {
	Object.defineProperty(globalThis, "AudioContext", { value: realAudioContext, configurable: true, writable: true });
});

describe("speak() daemon path", () => {
	test("a synthesis failure surfaces the worker error text through onState", async () => {
		Object.defineProperty(globalThis, "AudioContext", {
			value: FakeAudioContext,
			configurable: true,
			writable: true,
		});
		const fake = new FakeRpc();
		fake.responses.set("tts.synthesize", {
			audio: null,
			sampleRate: 0,
			error: "Failed to download model.onnx: HTTP 404",
		});
		const activities: { phase: string; message?: string }[] = [];
		const stop = speak("已经改好了。", asRpc(fake), undefined, a => activities.push(a));
		await new Promise(resolve => setTimeout(resolve, 20));
		stop();
		const error = activities.find(a => a.phase === "error");
		expect(error).toBeDefined();
		// The worker text names the real failure (missing model file) — the
		// user must see WHY, not a generic "synthesis failed".
		expect(error!.message).toBe("Failed to download model.onnx: HTTP 404");
	});

	test("a markup-only reply reports the localized empty error before any synthesis", async () => {
		const fake = new FakeRpc();
		const activities: { phase: string; message?: string }[] = [];
		// "***" is a horizontal rule: it sanitizes to nothing speakable, so the
		// empty-segment guard must fire BEFORE the first tts.synthesize call.
		const stop = speak("***", asRpc(fake), undefined, a => activities.push(a));
		await new Promise(resolve => setTimeout(resolve, 20));
		stop();
		expect(fake.calls("tts.synthesize")).toEqual([]);
		const error = activities.find(a => a.phase === "error");
		expect(error).toBeDefined();
		expect(error!.message).toBe("这段内容没有可朗读的文字");
	});

	test("a multi-sentence reply synthesizes one segment per sentence, first call first", async () => {
		Object.defineProperty(globalThis, "AudioContext", {
			value: FakeAudioContext,
			configurable: true,
			writable: true,
		});
		const fake = new FakeRpc();
		fake.responses.set("tts.synthesize", { audio: [0.1, -0.1, 0.2, -0.2], sampleRate: 24_000 });
		const activities: { phase: string }[] = [];
		const stop = speak("第一句。第二句。", asRpc(fake), undefined, a => activities.push(a));
		// Two segments × (synth + decode) plus the drain timer — 300 ms covers it.
		await new Promise(resolve => setTimeout(resolve, 300));
		stop();
		const synthCalls = fake.calls("tts.synthesize") as { text: string }[];
		expect(synthCalls.map(c => c.text)).toEqual(["第一句。", "第二句。"]);
		expect(activities.some(a => a.phase === "speaking")).toBe(true);
		expect(activities.some(a => a.phase === "done")).toBe(true);
	});
});
