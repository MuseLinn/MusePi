import { describe, expect, test } from "bun:test";
import { GlobalDictation } from "../electron/global-dictation.cjs";

interface HarnessOptions {
	delayAudio?: boolean;
	delayStop?: boolean;
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition did not become true");
}

async function harness(options: HarnessOptions = {}) {
	const requests: { method: string; params: Record<string, unknown> }[] = [];
	const states: Record<string, unknown>[] = [];
	const typed: string[] = [];
	let onAudio: ((error: Error | null, samples: Float32Array) => void) | null = null;
	let releaseAudio: (() => void) | null = null;
	let releaseStop: (() => void) | null = null;
	const dictation = new GlobalDictation({
		app: { on: () => {} },
		BrowserWindow: class {},
		globalShortcut: { register: () => true, unregister: () => {} },
		screen: {},
		clipboard: { writeText: () => {} },
		shell: {},
		path: { join: (...parts: string[]) => parts.join("/") },
		distDir: "",
		preloadPath: "",
		request: async (method: string, params: Record<string, unknown>) => {
			requests.push({ method, params });
			if (method === "stt.modelStatus")
				return { defaultKey: "sensevoice", models: [{ key: "sensevoice", cached: true }] };
			if (method === "voice.frontendStreamStart") return { sessionId: "voice-test" };
			if (method === "voice.frontendStreamAudio") {
				if (options.delayAudio)
					await new Promise<void>(resolve => {
						releaseAudio = () => resolve();
					});
				return { ok: true };
			}
			if (method === "voice.frontendStreamStop") {
				if (options.delayStop)
					await new Promise<void>(resolve => {
						releaseStop = () => resolve();
					});
				return {
					results: [
						{ text: "第一句。", state: "accept" },
						{ text: "第二句。", state: "accept" },
					],
					text: "第一句。第二句。",
				};
			}
			if (method === "stt.transcribe") return { text: "第一句。第二句。" };
			return {};
		},
		subscribe: () => {},
		ensureDaemon: async () => true,
		log: () => {},
	});
	dictation.show = (state: Record<string, unknown>) => {
		dictation.phase = state.phase;
		states.push(state);
	};
	dictation.scheduleHide = () => {};
	dictation.hideHud = () => {};
	dictation.loadNative = async () => ({
		AudioCapture: class {
			constructor(_rate: number, callback: (error: Error | null, samples: Float32Array) => void) {
				onAudio = callback;
			}
			stop(): void {}
		},
	});
	dictation.typeIntoFocusedApp = async (text: string) => {
		typed.push(text);
		return true;
	};
	await dictation.begin();
	return {
		dictation,
		requests,
		states,
		typed,
		audio(samples: Float32Array) {
			onAudio?.(null, samples);
		},
		event(payload: Record<string, unknown>) {
			dictation.handleEvent({ kind: "event", payload });
		},
		releaseAudio() {
			releaseAudio?.();
		},
		releaseStop() {
			releaseStop?.();
		},
	};
}

describe("global streaming dictation", () => {
	test("shows cumulative previews and stops only after queued audio arrives", async () => {
		const h = await harness({ delayAudio: true });
		expect(h.requests.map(request => request.method)).toContain("voice.frontendStreamStart");
		h.audio(new Float32Array(8_000).fill(0.1));
		h.event({
			type: "voice.frontendSegment",
			sessionId: "voice-test",
			segmentId: 0,
			text: "第一句。",
			state: "accept",
		});
		h.event({ type: "voice.frontendPartial", sessionId: "voice-test", segmentId: 1, text: "第二", state: "accept" });
		expect(h.dictation.displayTranscript()).toBe("第一句。第二");
		expect(h.states.at(-1)?.partialText).toBe("第一句。第二");

		h.dictation.finishRecording();
		await Bun.sleep(10);
		expect(h.requests.map(request => request.method)).not.toContain("voice.frontendStreamStop");
		h.releaseAudio();
		await waitFor(() => h.typed.length === 1);
		expect(h.requests.map(request => request.method)).toContain("voice.frontendStreamStop");
		expect(h.typed).toEqual(["第一句。第二句。"]);
	});

	test("invalidates late events and stop settlement after cancellation", async () => {
		const h = await harness({ delayStop: true });
		h.audio(new Float32Array(8_000).fill(0.1));
		h.dictation.finishRecording();
		h.dictation.cancel();
		h.event({ type: "voice.frontendPartial", sessionId: "voice-test", segmentId: 0, text: "迟到", state: "accept" });
		h.releaseStop();
		await Bun.sleep(20);
		expect(h.dictation.displayTranscript()).toBe("");
		expect(h.states.filter(state => state.partialText === "迟到")).toHaveLength(0);
		expect(h.typed).toEqual([]);
	});
});
