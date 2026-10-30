import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@musepi/pi-utils";
import { EventBatcher } from "../../src/daemon/event-batcher";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import type { SttStreamHandle } from "../../src/stt/asr-client";
import { VoiceFrontendClient } from "../../src/voice/frontend/client";
import { createSpeakerProfileStore } from "../../src/voice/frontend/profile";
import type {
	VoiceFrontendTransport,
	VoiceFrontendWorkerInbound,
	VoiceFrontendWorkerOutbound,
} from "../../src/voice/frontend/protocol";
import * as serviceModule from "../../src/voice/frontend/service";

let tmp = "";

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (tmp) await removeWithRetries(tmp);
	tmp = "";
});

class FakeTransport implements VoiceFrontendTransport {
	lastMessage: VoiceFrontendWorkerInbound | null = null;

	send(message: VoiceFrontendWorkerInbound): void {
		this.lastMessage = message;
		if (message.type === "embed") {
			this.#emit({ type: "embedding", id: message.id, embedding: new Float32Array([1, 0]) });
			return;
		}
		if (message.type === "ping") {
			this.#emit({ type: "pong", id: message.id });
			return;
		}
		this.#emit({
			type: "result",
			id: message.id,
			audio: message.audio,
			state: "accept",
			score: 0.95,
			enhanced: true,
			segmentId: 0,
		});
	}
	#handler: ((message: VoiceFrontendWorkerOutbound) => void) | null = null;
	#emit(message: VoiceFrontendWorkerOutbound): void {
		this.#handler?.(message);
	}
	onMessage(handler: (message: VoiceFrontendWorkerOutbound) => void): () => void {
		this.#handler = handler;
		return () => {
			this.#handler = null;
		};
	}
	terminate(): void {}
}

function fakeAsr(options?: {
	onPartial?: (text: string) => void;
	onSegment?: (text: string, index: number) => void;
}): SttStreamHandle {
	return {
		pushAudio: () => options?.onPartial?.("hel"),
		stop: async () => {
			options?.onSegment?.("hello", 0);
			return "hello";
		},
		cancel: () => {},
	};
}

async function makeHarness() {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-voice-rpc-"));
	const profiles = createSpeakerProfileStore({
		profilePath: path.join(tmp, "speaker.json"),
		embed: async () => new Float32Array([1, 0]),
	});
	let streamOptions: Parameters<typeof fakeAsr>[0];
	const transport = new FakeTransport();
	const client = new VoiceFrontendClient(transport, (_modelKey, options) => {
		streamOptions = options;
		return fakeAsr(options);
	});
	const service = new serviceModule.VoiceFrontendService(client, profiles);
	vi.spyOn(serviceModule, "getVoiceFrontendService").mockReturnValue(service);
	const sent: string[] = [];
	const batcher = new EventBatcher(message => sent.push(JSON.stringify(message)));
	const host = {
		cwd: () => "/tmp",
		get: () => undefined,
		emitEvent: (_conn: DaemonConnection, event: Parameters<EventBatcher["push"]>[0]) => batcher.push(event),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test" } as unknown as DaemonConnection;
	const rpc = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
		server.handle(method, params, conn);
	return {
		rpc,
		sent,
		transport,
		flush: () => batcher.flushNow(),
		emitLate: () => {
			streamOptions?.onPartial?.("late");
			streamOptions?.onSegment?.("late", 0);
		},
	};
}

function clip(seconds: number): number[] {
	return Array.from(new Float32Array(Math.round(seconds * 16_000)).fill(0.1));
}

describe("voice frontend RPC", () => {
	it("runs enrollment, status, and deletion", async () => {
		const { rpc, transport } = await makeHarness();
		expect(await rpc("voice.speakerEnrollmentStart", {})).toEqual({ count: 0, totalMs: 0 });
		for (let i = 0; i < 4; i++) {
			expect(await rpc("voice.speakerEnrollmentAdd", { audio: clip(4), sampleRate: 16_000 })).toMatchObject({
				accepted: true,
				count: i + 1,
			});
		}
		expect(await rpc("voice.speakerEnrollmentFinish", { audio: clip(2), sampleRate: 16_000 })).toMatchObject({
			ok: true,
		});
		expect(await rpc("voice.speakerStatus", {})).toMatchObject({ hasProfile: true, sampleCount: 4 });
		const started = await rpc("voice.frontendStreamStart", { modelKey: "balanced", speakerMode: "prefer" });
		const sessionId = (started as { sessionId: string }).sessionId;
		await rpc("voice.frontendStreamAudio", { sessionId, audio: clip(1) });
		await rpc("voice.frontendStreamStop", { sessionId });
		expect(transport.lastMessage?.type).toBe("process");
		if (transport.lastMessage?.type === "process") expect(transport.lastMessage.enrollment.length).toBe(4);
		await rpc("voice.speakerDelete", {});
		expect(await rpc("voice.speakerStatus", {})).toMatchObject({ hasProfile: false, sampleCount: 0 });
	});

	it("rejects invalid enrollment audio and unknown streams", async () => {
		const { rpc } = await makeHarness();
		await expect(rpc("voice.speakerEnrollmentAdd", { audio: clip(1), sampleRate: 8000 })).rejects.toThrow("16000");
		await expect(rpc("voice.frontendStreamAudio", { sessionId: "missing", audio: clip(1) })).rejects.toThrow(
			"missing",
		);
	});

	it("forwards process mode and enhancement", async () => {
		const { rpc } = await makeHarness();
		const result = await rpc("voice.frontendProcess", {
			audio: clip(2),
			sampleRate: 16_000,
			speakerMode: "prefer",
			enhanceAudio: true,
		});
		expect(result).toMatchObject({ state: "accept", score: 0.95, enhanced: true });
	});

	it("emits partial and segment events and cancels late streams", async () => {
		const { rpc, sent, flush, emitLate } = await makeHarness();
		await rpc("events.subscribe", {});
		const started = await rpc("voice.frontendStreamStart", {
			modelKey: "balanced",
			speakerMode: "prefer",
			enhanceAudio: true,
		});
		const sessionId = (started as { sessionId: string }).sessionId;
		await rpc("voice.frontendStreamAudio", { sessionId, audio: clip(1) });
		await rpc("voice.frontendStreamStop", { sessionId });
		flush();
		const all = sent.join("\n");
		expect(all).toContain('"voice.frontendPartial"');
		expect(all).toContain('"voice.frontendSegment"');
		expect(all).toContain(sessionId);

		const cancelled = await rpc("voice.frontendStreamStart", { modelKey: "balanced" });
		const cancelledId = (cancelled as { sessionId: string }).sessionId;
		await rpc("voice.frontendStreamAudio", { sessionId: cancelledId, audio: clip(1) });
		await Bun.sleep(0);
		await rpc("voice.frontendStreamCancel", { sessionId: cancelledId });
		flush();
		sent.length = 0;
		emitLate();
		flush();
		expect(sent.join("\n")).not.toContain(cancelledId);
	});
});
