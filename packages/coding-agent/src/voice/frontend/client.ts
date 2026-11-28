import { sttClient } from "../../stt/asr-client";
import { type EndpointerEvent, StreamEndpointer } from "../../stt/endpointer";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	type SpawnedSubprocess,
	spawnWorkerOrUnavailable,
} from "../../subprocess/worker-client";
import { tinyWorkerEnv } from "../../tiny/title-client";
import { safeSend } from "../../utils/ipc";
import type {
	FrontendProcessInput,
	FrontendProcessResult,
	FrontendStreamResult,
	VoiceFrontendRequest,
	VoiceFrontendStreamHandle,
	VoiceFrontendStreamOptions,
	VoiceFrontendTransport,
	VoiceFrontendWorkerInbound,
	VoiceFrontendWorkerOutbound,
} from "./protocol";

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

/** Placeholder audio for results whose bytes the caller does not consume: the
 *  worker's own segments already travelled through it, and a preview's audio is
 *  superseded by the next one. */
const EMPTY_AUDIO = new Float32Array(0);

type AsrStreamFactory = typeof sttClient.startStream;

export class VoiceFrontendClient {
	readonly #transport: VoiceFrontendTransport;
	readonly #asrStreamFactory: AsrStreamFactory;
	readonly #unsubscribe: () => void;
	readonly #pending = new Map<string, PendingRequest>();
	#nextId = 0;

	constructor(
		transport: VoiceFrontendTransport,
		asrStreamFactory: AsrStreamFactory = (modelKey, options) => sttClient.startStream(modelKey, options),
	) {
		this.#transport = transport;
		this.#asrStreamFactory = asrStreamFactory;
		this.#unsubscribe = transport.onMessage(message => this.#handleMessage(message));
	}

	process(input: FrontendProcessInput): Promise<FrontendProcessResult> {
		return this.#request({ type: "process", ...input });
	}

	embed(audio: Float32Array, sampleRate: 16_000): Promise<Float32Array> {
		return this.#request({ type: "embed", audio, sampleRate });
	}

	startStream(options: VoiceFrontendStreamOptions): VoiceFrontendStreamHandle {
		// Speaker verification and enhancement both need the audio of a FINALIZED
		// run, so a gated session runs its own endpointer and can only show a
		// preview for the run it is still collecting. Ungated sessions skip that:
		// a second endpointer would re-segment audio the worker already owns and
		// hold every commit until `stream_stop`.
		const gated = options.speakerMode !== "off" || options.enhanceAudio;
		const endpointer = new StreamEndpointer();
		const results: FrontendStreamResult[] = [];
		/** Gated only: ASR segment index -> the frontend result it decodes. */
		const asrSegments: FrontendStreamResult[] = [];
		let cancelled = false;
		let queue = Promise.resolve();
		let pending = 0;
		let failure: Error | null = null;
		let lastSegmentId = 0;

		// A preview belongs to the run still being spoken, so it carries the id
		// the next commit will take. Emitting it before any segment exists is the
		// whole point: the first words must appear while the user is still talking.
		const emitPartial = (text: string, audio: Float32Array): void => {
			if (cancelled) return;
			options.onPartial?.({
				audio,
				state: "accept",
				score: null,
				enhanced: false,
				segmentId: lastSegmentId,
				text,
			});
		};

		const asr = this.#asrStreamFactory(options.modelKey, {
			language: options.language,
			onPartial: text => emitPartial(text, EMPTY_AUDIO),
			onSegment: (text, index) => {
				if (cancelled) return;
				if (gated) {
					const target = asrSegments[index];
					if (!target) return;
					target.text = text;
					options.onSegment?.(target);
					return;
				}
				// Ungated: the worker owns segmentation, so the index is the id.
				const result: FrontendStreamResult = {
					audio: EMPTY_AUDIO,
					state: "accept",
					score: null,
					enhanced: false,
					segmentId: index,
					text,
				};
				results.push(result);
				lastSegmentId = index;
				options.onSegment?.(result);
			},
		});

		const processEvent = (event: EndpointerEvent): Promise<void> => {
			if (event.kind !== "segment" || cancelled) return queue;
			if (pending >= 4) {
				failure = new Error("Voice frontend is busy; stop and retry");
				cancelled = true;
				asr.cancel();
				return queue;
			}
			pending += 1;
			queue = queue
				.then(async () => {
					if (cancelled) return;
					const processed = await this.process({
						audio: event.audio,
						sampleRate: 16_000,
						targetMs: (event.audio.length / 16_000) * 1000,
						speakerMode: options.speakerMode,
						enhanceAudio: options.enhanceAudio,
						enrollment: options.enrollment,
						acceptThreshold: options.acceptThreshold,
						rejectThreshold: options.rejectThreshold,
					});
					const result = { ...processed, segmentId: results.length, text: "" };
					results.push(result);
					lastSegmentId = result.segmentId;
					if (result.state !== "reject") {
						asrSegments.push(result);
						asr.pushUtterance(result.audio);
					}
				})
				.finally(() => {
					pending -= 1;
				});
			void queue.catch(() => {});
			return queue;
		};
		return {
			pushAudio: samples => {
				if (!gated) {
					asr.pushAudio(samples);
					return;
				}
				for (const event of endpointer.push(samples)) {
					if (event.kind === "partial") asr.pushPreview(event.audio);
					else void processEvent(event);
				}
			},
			stop: async () => {
				if (failure) throw failure;
				if (gated) {
					for (const event of endpointer.flush()) await processEvent(event);
					await queue;
					if (failure) throw failure;
				}
				const text = (await asr.stop()).trim();
				if (failure) throw failure;
				return { results, text: cancelled ? "" : text };
			},
			cancel: () => {
				cancelled = true;
				asr.cancel();
			},
		};
	}

	close(): void {
		const error = new Error("Voice frontend worker closed");
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#unsubscribe();
		void this.#transport.terminate();
	}

	#request<T>(message: VoiceFrontendRequest): Promise<T> {
		const id = String(++this.#nextId);
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
		this.#transport.send({ ...message, id });
		return promise;
	}

	#handleMessage(message: VoiceFrontendWorkerOutbound): void {
		const pending = this.#pending.get(message.id);
		if (!pending) {
			if (this.#pending.size > 0) {
				const error = new Error(`Voice frontend returned unknown response id ${message.id}`);
				for (const request of this.#pending.values()) request.reject(error);
				this.#pending.clear();
			}
			return;
		}
		this.#pending.delete(message.id);
		if (message.type === "error") pending.reject(new Error(message.error));
		else if (message.type === "embedding") pending.resolve(message.embedding);
		else if (message.type === "result") {
			pending.resolve({
				audio: message.audio,
				state: message.state,
				score: message.score,
				enhanced: message.enhanced,
				segmentId: message.segmentId,
			});
		}
	}
}

export const VOICE_FRONTEND_WORKER_ARG = "__musepi_worker_voice_frontend";

export function createVoiceFrontendSubprocess(): SpawnedSubprocess<VoiceFrontendWorkerOutbound> {
	return createWorkerSubprocess<VoiceFrontendWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(VOICE_FRONTEND_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "voice frontend subprocess",
	});
}

function wrapSubprocess(
	spawned: SpawnedSubprocess<VoiceFrontendWorkerOutbound>,
): RefCountedWorkerHandle<VoiceFrontendWorkerInbound, VoiceFrontendWorkerOutbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<VoiceFrontendWorkerInbound, VoiceFrontendWorkerOutbound>(spawned, message =>
			safeSend(proc, message, "voice-frontend"),
		),
		ref() {
			try {
				proc.ref();
			} catch {}
		},
		unref() {
			try {
				proc.unref();
			} catch {}
		},
	};
}

function spawnInlineUnavailableWorker(
	error: unknown,
): RefCountedWorkerHandle<VoiceFrontendWorkerInbound, VoiceFrontendWorkerOutbound> {
	return {
		...createUnavailableWorker<VoiceFrontendWorkerInbound, VoiceFrontendWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

function spawnVoiceFrontendWorker(): RefCountedWorkerHandle<VoiceFrontendWorkerInbound, VoiceFrontendWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createVoiceFrontendSubprocess()),
		spawnInlineUnavailableWorker,
		"voice frontend worker spawn failed; speech preprocessing disabled",
	);
}

export function createVoiceFrontendClient(): VoiceFrontendClient {
	return new VoiceFrontendClient(spawnVoiceFrontendWorker());
}
