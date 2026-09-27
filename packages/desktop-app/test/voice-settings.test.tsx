import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MockAssistantRow, MockConversationPreview, MockUserRow } from "../src/components/MockConversationPreview";
import { SpeakAction, TtsModelPickerCard } from "../src/components/settings-sections/voice";
import type { RpcClient, StreamEvent } from "../src/lib/rpc";

/**
 * Voice settings contracts (2026-09-28):
 *
 * 1. 朗读模型卡 (TtsModelPickerCard = SpeechModelPicker over the tts.*
 *    endpoints): a radio row per local TTS tier; selecting a row writes
 *    `tts.localModel` and NEVER auto-downloads (synthesis falls back across
 *    tiers by text script, so an uncached pick still reads aloud — the
 *    per-row download button is the only fetch trigger); the button fires
 *    `tts.modelDownload`, progress rides the global `tts.download*` event
 *    stream, and cached tiers render a ready marker instead of a button.
 * 2. 语音测试共用模拟会话视图 (MockConversationPreview + SpeakAction): the
 *    dictation result renders as a mock USER message in the transcript
 *    bubble styling (tr-row--user → tr-md), the assembled preview carries
 *    the 活动 fold summary row and the mock composer, and the read-aloud
 *    entry (tr-action) on the assistant row synthesizes through the
 *    existing tts.synthesize channel with the live schema values.
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

/** Minimal RpcClient double: records requests, replays canned responses,
 *  lets tests push global-stream events (the tts.download* channel). */
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

	emit(payload: unknown): void {
		for (const handler of this.#handlers) handler({ kind: "event", seq: 1, payload });
	}

	calls(method: string): unknown[] {
		return this.requests.filter(r => r.method === method).map(r => r.params);
	}
}

const asRpc = (fake: FakeRpc): RpcClient | null => fake as unknown as RpcClient;

function statusResponse(): Record<string, unknown> {
	return {
		models: [
			{ key: "kokoro", label: "Kokoro-82M", cached: true },
			{ key: "melotts-zh", label: "MeloTTS 中文", cached: false },
		],
		defaultKey: "kokoro",
	};
}

describe("朗读模型卡 (TtsModelPickerCard)", () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	function mount(fake: FakeRpc): void {
		act(() => {
			root.render(createElement(TtsModelPickerCard, { rpc: asRpc(fake) }));
		});
	}

	test("renders one radio row per TTS tier: cached tier shows ready, uncached shows download", async () => {
		const fake = new FakeRpc();
		fake.responses.set("tts.modelStatus", statusResponse());
		fake.responses.set("settings.get", { "tts.localModel": "kokoro" });
		mount(fake);
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		const rows = host.querySelectorAll(".gui-stt-row");
		expect(rows.length).toBe(2);
		const kokoro = rows[0]!;
		const melotts = rows[1]!;
		// Cached tier → ready marker, no download button.
		expect(kokoro.querySelector(".gui-stt-row-ready")).not.toBeNull();
		expect(kokoro.querySelector("button.gui-btn")).toBeNull();
		// Uncached tier → an enabled download button.
		const downloadBtn = melotts.querySelector<HTMLButtonElement>("button.gui-btn");
		expect(downloadBtn).not.toBeNull();
		expect(downloadBtn!.disabled).toBe(false);
		// Real registry values surface as the row labels.
		expect(melotts.textContent).toContain("MeloTTS 中文");
		expect(fake.calls("tts.modelStatus")).toEqual([{}]);
	});

	test("selecting a row writes settings.set tts.localModel and does NOT auto-download", async () => {
		const fake = new FakeRpc();
		fake.responses.set("tts.modelStatus", statusResponse());
		fake.responses.set("settings.get", { "tts.localModel": "kokoro" });
		mount(fake);
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		const melotts = host.querySelectorAll(".gui-stt-row")[1]!;
		const radio = melotts.querySelector<HTMLInputElement>("input[type=radio]")!;
		act(() => {
			radio.click();
		});
		expect(fake.calls("settings.set")).toEqual([{ key: "tts.localModel", value: "melotts-zh" }]);
		// TTS never auto-fetches: synthesis falls back across tiers by text
		// script, so an uncached pick still reads aloud through the other
		// model — the per-row download button is the only fetch trigger.
		expect(fake.calls("tts.modelDownload")).toEqual([]);
	});

	test("the download button fires tts.modelDownload and progress rides the global event stream", async () => {
		const fake = new FakeRpc();
		fake.responses.set("tts.modelStatus", statusResponse());
		fake.responses.set("settings.get", { "tts.localModel": "kokoro" });
		mount(fake);
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		const melotts = host.querySelectorAll(".gui-stt-row")[1]!;
		act(() => {
			melotts.querySelector<HTMLButtonElement>("button.gui-btn")!.click();
		});
		expect(fake.calls("tts.modelDownload")).toEqual([{ modelKey: "melotts-zh" }]);
		// The row immediately switches to its progress presentation.
		expect(melotts.querySelector(".gui-stt-row-progress")).not.toBeNull();
		// A later progress tick advances the bar (event-stream channel).
		act(() => {
			fake.emit({ type: "tts.downloadProgress", modelKey: "melotts-zh", percent: 42 });
		});
		const progressRow = melotts.querySelector(".gui-stt-row-progress");
		expect(progressRow).not.toBeNull();
		expect(progressRow!.textContent).toContain("42%");
	});
});

describe("语音测试共用模拟会话视图", () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);

	test("dictation result renders as a transcript user message (bubble + same markdown renderer)", () => {
		act(() => {
			root.render(createElement(MockUserRow, { markdown: "帮我总结一下 **测试** 结果" }));
		});
		const row = host.querySelector(".tr-row--user");
		expect(row).not.toBeNull();
		// The bubble styling hook (.tr-row--user .tr-body > .tr-md) applies:
		// the markdown root is a DIRECT tr-md child of tr-body.
		const md = row!.querySelector(".tr-body > .tr-md");
		expect(md).not.toBeNull();
		expect(md!.textContent).toContain("帮我总结一下");
		expect(md!.textContent).toContain("测试");
	});

	test("the assembled preview carries user row + 活动 fold + assistant row + composer", () => {
		act(() => {
			root.render(createElement(MockConversationPreview, null));
		});
		expect(host.querySelector(".tr-row--user")).not.toBeNull();
		expect(host.querySelector(".tr-round-fold")).not.toBeNull();
		expect(host.querySelector(".tr-row--assistant")).not.toBeNull();
		expect(host.querySelector(".gui-effect-preview-composer")).not.toBeNull();
	});

	test("read-aloud action on the assistant row synthesizes via tts.synthesize with live schema values", async () => {
		const fake = new FakeRpc();
		fake.responses.set("settings.get", { "tts.localVoice": "af_heart", "tts.rate": 1, "tts.inputMode": "sanitize" });
		fake.responses.set("tts.synthesize", { audio: null, sampleRate: 0 });
		const markdown = "已经改好了，简单说两个要点：";
		act(() => {
			root.render(
				createElement(MockAssistantRow, {
					markdown,
					showAvatar: false,
					actions: createElement(SpeakAction, { rpc: asRpc(fake), markdown }),
				}),
			);
		});
		// Read-aloud entry = the message-stream button (tr-action), which
		// reads live schema values then synthesizes through the daemon.
		const speakBtn = host.querySelector<HTMLButtonElement>("button.tr-action");
		expect(speakBtn).not.toBeNull();
		act(() => {
			speakBtn!.click();
		});
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		const get = fake.calls("settings.get")[0] as { keys: string[] };
		expect(get.keys).toEqual(["tts.localVoice", "tts.rate", "tts.inputMode"]);
		const synth = fake.calls("tts.synthesize")[0] as { text: string };
		expect(typeof synth.text).toBe("string");
		expect(synth.text.length).toBeGreaterThan(0);
	});
});
