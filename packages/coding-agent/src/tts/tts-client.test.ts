import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@musepi/pi-utils";
import type { RefCountedWorkerHandle } from "../subprocess/worker-client";
import { TtsClient } from "./tts-client";
import type { TtsProgressEvent, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";

/**
 * Client-side failure-visibility contract: when the worker reports a synthesis
 * error, the client must (1) settle the request (`null` — callers treat it as
 * "no audio"), (2) push an `error` progress event so settings-page listeners
 * can surface it, and (3) log at warn level with the worker's error text. The
 * pre-fix code logged at debug only, which is why the melotts-zh synthesis
 * failure reached the GUI as unexplained silence.
 */
function createErrorWorker(errorText: string): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	let messageHandler: ((message: TtsWorkerOutbound) => void) | null = null;
	return {
		send(message: TtsWorkerInbound) {
			queueMicrotask(() => {
				if (message.type !== "ping") messageHandler?.({ type: "error", id: message.id, error: errorText });
			});
		},
		onMessage(handler: (message: TtsWorkerOutbound) => void) {
			messageHandler = handler;
			return () => {
				messageHandler = null;
			};
		},
		onError() {
			return () => {};
		},
		async terminate() {
			messageHandler = null;
		},
		ref() {},
		unref() {},
	};
}

describe("TtsClient worker-error visibility", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("settles null, emits an error progress event, and warns with the worker error text", async () => {
		const client = new TtsClient(() => createErrorWorker("The argument object should have a field sid"));
		const progress: TtsProgressEvent[] = [];
		client.onProgress(e => progress.push(e));
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const audio = await client.synthesize("melotts-zh", "你好");

		expect(audio).toBeNull();
		expect(progress.some(e => e.modelKey === "melotts-zh" && e.status === "error")).toBe(true);
		expect(warn).toHaveBeenCalled();
		const warnArgs = warn.mock.calls[0];
		expect(JSON.stringify(warnArgs?.[1])).toContain("The argument object should have a field sid");
		await client.terminate();
	});

	it("delivers the worker's error text through the synthesize onError hook (RPC layers surface it)", async () => {
		// Contract: tts.synthesize daemon route forwards the text to the GUI so a
		// failure reads as "模型未下载/合成失败 + 原因" instead of silent nothing.
		const client = new TtsClient(() => createErrorWorker("Failed to download model.onnx: HTTP 404"));
		const errors: string[] = [];
		const audio = await client.synthesize("melotts-zh", "你好", { onError: message => errors.push(message) });
		expect(audio).toBeNull();
		expect(errors).toEqual(["Failed to download model.onnx: HTTP 404"]);
		await client.terminate();
	});

	it("fails a streaming session's chunk iterator when the worker errors mid-stream", async () => {
		const client = new TtsClient(() => createErrorWorker("sherpa TTS synthesis returned no audio samples"));
		const stream = client.synthesizeStream("melotts-zh");
		stream.push("你好");
		stream.end();
		await expect(stream.chunks.next()).rejects.toThrow("no audio samples");
		await client.terminate();
	});
});
