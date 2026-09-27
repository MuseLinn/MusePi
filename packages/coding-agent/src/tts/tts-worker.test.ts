import { describe, expect, it } from "bun:test";
import type { TtsTransport, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";
import { startTtsWorker } from "./tts-worker";

/**
 * Worker error-channel contract: a failed request must produce an outbound
 * `error` message carrying the failure text — never drop the request silently
 * or die with an unhandled rejection. Unknown model keys are the cheap,
 * native-free failure path (`loadModel` throws before any engine loads), so
 * they pin the contract without dragging a 170 MB ONNX into the test.
 */
function createHarness() {
	const sent: TtsWorkerOutbound[] = [];
	let handler: ((message: TtsWorkerInbound) => void) | null = null;
	const transport: TtsTransport = {
		send: message => sent.push(message),
		sendAndFlush: async message => {
			sent.push(message);
		},
		onMessage: h => {
			handler = h;
			return () => {
				handler = null;
			};
		},
	};
	startTtsWorker(transport);
	return {
		sent,
		send: (message: TtsWorkerInbound) => handler?.(message),
	};
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for worker output");
		await Bun.sleep(5);
	}
}

describe("tts worker error channel", () => {
	it("answers a streaming session for an unknown model with an error message, not silence", async () => {
		const { sent, send } = createHarness();
		send({ type: "stream-start", id: "s1", modelKey: "bogus" as never });
		await until(() => sent.some(m => m.type === "error" && m.id === "s1"));
		const error = sent.find(m => m.type === "error" && m.id === "s1");
		if (error?.type !== "error") throw new Error("expected error message");
		expect(error.error).toContain("Unknown local TTS model");
		// No audio may accompany the failure.
		expect(sent.some(m => m.type === "audio-chunk" && m.id === "s1")).toBe(false);
		expect(sent.some(m => m.type === "stream-done" && m.id === "s1")).toBe(false);
	});

	it("answers an unknown-model download with an error message", async () => {
		const { sent, send } = createHarness();
		send({ type: "download", id: "r2", modelKey: "bogus" as never });
		await until(() => sent.some(m => m.type === "error" && m.id === "r2"));
		const error = sent.find(m => m.type === "error" && m.id === "r2");
		if (error?.type !== "error") throw new Error("expected error message");
		expect(error.error).toContain("Unknown local TTS model");
		expect(sent.some(m => m.type === "downloaded" && m.id === "r2")).toBe(false);
	});

	it("pongs pings (worker liveness contract)", async () => {
		const { sent, send } = createHarness();
		send({ type: "ping", id: "p1" });
		await until(() => sent.some(m => m.type === "pong" && m.id === "p1"));
	});
});
