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
		BrowserWindow: {
			getAllWindows: () => [],
			getFocusedWindow: () => null,
		},
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

interface TriggerHarnessOptions {
	trigger?: "toggle" | "hold";
	failMonitor?: boolean;
}

function triggerHarness(options: TriggerHarnessOptions = {}) {
	const registrations: { accelerator: string; callback: () => void }[] = [];
	const monitors: { callback: (event: "press" | "release") => void; close: () => void; closed: () => boolean }[] = [];
	const dictation = new GlobalDictation({
		app: {},
		BrowserWindow: {
			getAllWindows: () => [],
			getFocusedWindow: () => null,
		},
		globalShortcut: {
			register: (accelerator: string, callback: () => void) => {
				registrations.push({ accelerator, callback });
				return true;
			},
			unregister: () => {},
		},
		screen: {},
		clipboard: {},
		shell: {},
		path: {},
		request: async (method: string) => {
			if (method === "settings.get") {
				return {
					"dictation.globalEnabled": true,
					"dictation.globalShortcut": "CommandOrControl+Alt+Space",
					"dictation.globalTrigger": options.trigger ?? "toggle",
				};
			}
			if (method === "stt.modelStatus")
				return { defaultKey: "sensevoice", models: [{ key: "sensevoice", cached: true }] };
			if (method === "voice.frontendStreamStart") return { sessionId: "voice-fallback" };
			if (method === "voice.frontendStreamCancel") return { ok: true };
			return {};
		},
		subscribe: () => {},
		ensureDaemon: async () => true,
		createKeyMonitor: (_accelerator: string, callback: (event: "press" | "release") => void) => {
			if (options.failMonitor) throw new Error("hook unavailable");
			let closed = false;
			const monitor = {
				callback,
				close: () => {
					closed = true;
				},
				closed: () => closed,
			};
			monitors.push(monitor);
			return monitor;
		},
	});
	return { dictation, registrations, monitors };
}

describe("global dictation trigger modes", () => {
	test("toggle uses Electron without constructing a native monitor", async () => {
		const h = triggerHarness({ trigger: "toggle" });
		await h.dictation.syncSettings();
		expect(h.registrations.map(entry => entry.accelerator)).toEqual(["CommandOrControl+Alt+Space"]);
		expect(h.monitors).toHaveLength(0);
	});

	test("hold starts once, releases to stop, and closes on dispose", async () => {
		const h = triggerHarness({ trigger: "hold" });
		await h.dictation.syncSettings();
		expect(h.registrations).toHaveLength(0);
		expect(h.monitors).toHaveLength(1);
		let starts = 0;
		let stops = 0;
		h.dictation.begin = async () => {
			starts += 1;
			h.dictation.capture = { stop: () => {} };
		};
		h.dictation.finishRecording = () => {
			stops += 1;
			h.dictation.capture = null;
		};
		await h.monitors[0]!.callback("press");
		await h.monitors[0]!.callback("press");
		expect(starts).toBe(1);
		await h.monitors[0]!.callback("release");
		expect(stops).toBe(1);
		h.dictation.dispose();
		expect(h.monitors[0]!.closed()).toBe(true);
	});

	test("monitor installation failure leaves one working toggle fallback", async () => {
		const h = triggerHarness({ trigger: "hold", failMonitor: true });
		await h.dictation.syncSettings();
		expect(h.monitors).toHaveLength(0);
		expect(h.registrations).toHaveLength(1);
		expect(h.dictation.registered).toBe(false);
		let startedCapture = false;
		h.dictation.loadNative = async () => ({
			AudioCapture: class {
				constructor() {
					startedCapture = true;
				}
				stop(): void {}
			},
		});
		h.dictation.show = (state: Record<string, unknown>) => {
			h.dictation.phase = state.phase;
		};
		h.dictation.hideHud = () => {};
		await h.registrations[0]!.callback();
		await Bun.sleep(20);
		expect(startedCapture).toBe(true);
		expect(h.dictation.capture === null).toBe(false);
		h.dictation.cancel();
	});
});

test("dispose closes the active daemon stream as well as the microphone", async () => {
	const h = await harness();
	h.audio(new Float32Array(8_000).fill(0.1));
	h.dictation.dispose();
	expect(
		h.requests.some(
			request => request.method === "voice.frontendStreamCancel" && request.params.sessionId === "voice-test",
		),
	).toBe(true);
	expect(h.dictation.displayTranscript()).toBe("");
});
