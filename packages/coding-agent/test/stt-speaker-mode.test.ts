import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings, settings } from "@musepi/pi-coding-agent/config/settings";
import * as asrClient from "@musepi/pi-coding-agent/stt/asr-client";
import * as downloader from "@musepi/pi-coding-agent/stt/downloader";
import { STTController } from "@musepi/pi-coding-agent/stt/stt-controller";
import type { FrontendStreamResult } from "@musepi/pi-coding-agent/voice/frontend/protocol";
import type { VoiceFrontendService } from "@musepi/pi-coding-agent/voice/frontend/service";
import * as frontendService from "@musepi/pi-coding-agent/voice/frontend/service";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function result(text: string, state: FrontendStreamResult["state"]): FrontendStreamResult {
	return { segmentId: 0, audio: new Float32Array(), state, score: null, enhanced: false, text };
}

function editor() {
	return {
		insertText: vi.fn(),
		setVolatileText: vi.fn(),
		clearVolatileText: vi.fn(),
		commitVolatileText: vi.fn(),
		submit: vi.fn(),
		deleteBeforeCursor: vi.fn(),
	};
}

function options() {
	return { showWarning: vi.fn(), showStatus: vi.fn(), onStateChange: vi.fn(), requestRender: vi.fn() };
}

describe("STTController speaker modes", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;
	let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
	let frontendEvents:
		| { onPartial?(result: FrontendStreamResult): void; onSegment?(result: FrontendStreamResult): void }
		| undefined;
	let service: {
		streamStart: ReturnType<typeof vi.fn>;
		streamAudio: ReturnType<typeof vi.fn>;
		streamStop: ReturnType<typeof vi.fn>;
		streamCancel: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "fast");
		settings.set("stt.submitTrigger", "release");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue();
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue(""),
			cancel: vi.fn(),
		});
		frontendEvents = undefined;
		service = {
			streamStart: vi.fn(async (_options, events) => {
				frontendEvents = events;
				return "voice-test";
			}),
			streamAudio: vi.fn(),
			streamStop: vi.fn(async () => []),
			streamCancel: vi.fn(),
		};
		vi.spyOn(frontendService, "getVoiceFrontendService").mockReturnValue(service as unknown as VoiceFrontendService);
		controller = new STTController(callback => {
			onAudio = callback;
			return { stop: vi.fn() };
		});
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		onAudio = undefined;
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	it("keeps off mode on the existing ASR stream", async () => {
		settings.set("stt.speakerMode", "off");
		const startStream = vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("hello world"),
			cancel: vi.fn(),
		});
		const input = editor();
		await controller!.toggle(input, options());
		onAudio?.(null, new Float32Array(480));
		await controller!.toggle(input, options());
		expect(startStream).toHaveBeenCalledTimes(1);
		expect(service.streamStart).not.toHaveBeenCalled();
		expect(input.submit).toHaveBeenCalledTimes(1);
	});

	it("keeps uncertain prefer-mode text as a draft and disables auto-submit", async () => {
		settings.set("stt.speakerMode", "prefer");
		service.streamStop.mockResolvedValue([result("maybe later", "uncertain")]);
		const input = editor();
		await controller!.toggle(input, options());
		onAudio?.(null, new Float32Array(480));
		frontendEvents?.onSegment?.(result("maybe later", "uncertain"));
		await controller!.toggle(input, options());
		expect(service.streamAudio).toHaveBeenCalled();
		expect(input.commitVolatileText).toHaveBeenCalledWith("maybe later");
		expect(input.submit).not.toHaveBeenCalled();
	});

	it("drops rejected strict-mode audio without transcription or submission", async () => {
		settings.set("stt.speakerMode", "strict");
		service.streamStop.mockResolvedValue([result("other person", "reject")]);
		const input = editor();
		await controller!.toggle(input, options());
		onAudio?.(null, new Float32Array(480));
		frontendEvents?.onSegment?.(result("other person", "reject"));
		await controller!.toggle(input, options());
		expect(service.streamStart).toHaveBeenCalledTimes(1);
		expect(service.streamAudio).toHaveBeenCalled();
		expect(input.commitVolatileText).not.toHaveBeenCalled();
		expect(input.submit).not.toHaveBeenCalled();
	});
});
