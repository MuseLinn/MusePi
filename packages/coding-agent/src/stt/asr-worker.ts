import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AutomaticSpeechRecognitionOutput,
	AutomaticSpeechRecognitionPipeline,
	ProgressInfo,
} from "@huggingface/transformers";
import { getTinyModelsCacheDir } from "@musepi/pi-utils";
import {
	errorMessage,
	errorText,
	getTransformersVersionSpec,
	loadTransformersRuntime,
	MemoizedRuntime,
	replayCachedReady,
	sendLog,
	sendProgress,
} from "../subprocess/worker-runtime";
import { resolveTinyModelDevicePreference, type TinyModelDevice, tinyModelDeviceLoadOrder } from "../tiny/device";
import { resolveTinyModelDtypeOverride, type TinyModelDtype } from "../tiny/dtype";
import { fetchHubFile } from "../tiny/hub-mirrors";
import { ensureVoiceFrontendModel } from "../voice/frontend/models";
import type { SttTransport, SttWorkerInbound } from "./asr-protocol";
import { type LiveEndpointer, StreamEndpointer } from "./endpointer";
import {
	getSttModelSpec,
	type SherpaSttModelSpec,
	type SttModel,
	type SttModelKey,
	type TransformersSttModelSpec,
} from "./models";
import {
	getSherpaVersionSpec,
	installSherpaRuntime,
	type SherpaOfflineConfig,
	type SherpaOfflineRecognizer,
	type SherpaRuntime,
} from "./sherpa-runtime";
import { SpeechEndpointer } from "./speech-endpointer";
import { LiveStreamingSession } from "./streaming-session";
import { normalizeChineseScript } from "./zh-hans";

export { joinSegmentTexts } from "./streaming-session";

const ASR_TASK = "automatic-speech-recognition";
// Whisper long-form decoding: split into 30s windows with 5s overlap so audio of
// any length transcribes without exceeding the 30s receptive field.
const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;
// The client always resamples to 16 kHz mono float32 before sending; sherpa-onnx
// is told the true input rate (it resamples internally to its feature config).
const ASR_SAMPLE_RATE = 16_000;
// Silero decides sentence boundaries; decoding always uses the session's raw PCM.
const SILERO_VAD_SETTINGS = {
	threshold: 0.5,
	minSilenceDuration: 0.7,
	minSpeechDuration: 0.25,
	windowSize: 512,
	maxSpeechDuration: 30,
} as const;
const VAD_BUFFER_SECONDS = 60;
// Hub origins for raw sherpa-onnx model files (encoder/decoder/joiner/tokens):
// upstream + mainland-China mirror fallback, probe-ordered per process
// (tiny/hub-mirrors). Previously a hardcoded huggingface.co — unreachable
// from mainland networks, which is what made first-use dictation dead.
// Coalesce download progress so streaming a multi-hundred-MB model file doesn't
// flood the IPC channel with one event per chunk.
const PROGRESS_EMIT_BYTES = 4_000_000;

const sttModelDevicePreference = resolveTinyModelDevicePreference();
const sttModelDtypeOverride = resolveTinyModelDtypeOverride();

/**
 * Subset of the transformers.js ASR call options we set. The index signature
 * mirrors `GenerationFunctionParameters` so this is assignable to the pipeline's
 * `Partial<AutomaticSpeechRecognitionConfig>` param (not re-exported from the
 * package root, so we model only what we pass).
 */
interface AsrCallOptions {
	chunk_length_s: number;
	stride_length_s: number;
	return_timestamps: boolean;
	task?: string;
	language?: string;
	[key: string]: unknown;
}

interface TransformersRuntime {
	env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		logLevel?: unknown;
	};
	LogLevel: {
		ERROR: unknown;
	};
	pipeline: (
		task: typeof ASR_TASK,
		model: string,
		options: {
			device: TinyModelDevice;
			dtype: TinyModelDtype;
			progress_callback: (info: ProgressInfo) => void;
		},
	) => Promise<AutomaticSpeechRecognitionPipeline>;
}

/** A warm model plus the engine that loaded it; cached per tier key. */
type LoadedModel =
	| { engine: "transformers"; pipeline: AutomaticSpeechRecognitionPipeline }
	| { engine: "sherpa"; recognizer: SherpaOfflineRecognizer; spec: SherpaSttModelSpec; config: SherpaOfflineConfig };

const models = new Map<SttModelKey, Promise<LoadedModel>>();
// Serialize all model inference on a single chain: the recognizers are not
// guaranteed reentrant and there is one CPU-bound model per tier. Batch
// transcribes and live-stream segment/partial decodes share this lock.
let modelLock = Promise.resolve();
function runOnModel<T>(work: () => Promise<T>): Promise<T> {
	const run = modelLock.then(work, work);
	modelLock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
const transformersRuntime = new MemoizedRuntime<TransformersRuntime>();
const sherpaRuntime = new MemoizedRuntime<SherpaRuntime>();

function getSttRuntimeDir(): string {
	const key = getTransformersVersionSpec().replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(path.dirname(getTinyModelsCacheDir()), "stt-runtime", `transformers-${key}`);
}

/**
 * Resolve the native `sherpa-onnx-node` module (shared installer lives in
 * sherpa-runtime.ts). Memoized so the runtime loads once per process.
 */
function loadSherpaRuntime(transport: SttTransport, requestId: string, modelKey: SttModelKey): Promise<SherpaRuntime> {
	return sherpaRuntime.load(() =>
		installSherpaRuntime(phase =>
			transport.send({
				type: "progress",
				id: requestId,
				event: { modelKey, status: phase, name: `sherpa-onnx-node@${getSherpaVersionSpec()}` },
			}),
		),
	);
}

async function loadPipelineOnDevice(
	transformers: TransformersRuntime,
	spec: TransformersSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
	device: TinyModelDevice,
): Promise<AutomaticSpeechRecognitionPipeline> {
	return transformers.pipeline(ASR_TASK, spec.repo, {
		device,
		dtype: sttModelDtypeOverride ?? spec.dtype,
		progress_callback: info => sendProgress(transport, requestId, modelKey, info),
	});
}

async function loadPipelineWithDeviceFallback(
	transformers: TransformersRuntime,
	spec: TransformersSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<{ pipeline: AutomaticSpeechRecognitionPipeline; device: TinyModelDevice }> {
	const devices = tinyModelDeviceLoadOrder(sttModelDevicePreference);
	if (devices[0] !== sttModelDevicePreference.device) {
		sendLog(transport, "warn", "stt: requested device is unsafe in the worker; using CPU", {
			modelKey,
			repo: spec.repo,
			requestedDevice: sttModelDevicePreference.device,
			device: devices[0],
		});
	}
	for (let i = 0; i < devices.length; i += 1) {
		const device = devices[i]!;
		try {
			return {
				pipeline: await loadPipelineOnDevice(transformers, spec, modelKey, transport, requestId, device),
				device,
			};
		} catch (error) {
			if (i === devices.length - 1) throw error;
			const fallbackDevice = devices[i + 1]!;
			sendLog(transport, "warn", "stt: accelerated device failed; falling back", {
				modelKey,
				repo: spec.repo,
				device,
				fallbackDevice,
				error: errorMessage(error),
			});
		}
	}
	throw new Error("No stt model devices configured");
}

async function loadTransformersModel(
	spec: TransformersSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<LoadedModel> {
	const transformers = await loadTransformersRuntime(
		transformersRuntime,
		transport,
		requestId,
		modelKey,
		getSttRuntimeDir,
	);
	const startedAt = performance.now();
	const { pipeline, device } = await loadPipelineWithDeviceFallback(
		transformers,
		spec,
		modelKey,
		transport,
		requestId,
	);
	sendLog(transport, "debug", "stt: local model loaded", {
		modelKey,
		repo: spec.repo,
		engine: "transformers",
		device,
		requestedDevice: sttModelDevicePreference.device,
		dtype: sttModelDtypeOverride ?? spec.dtype,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
	return { engine: "transformers", pipeline };
}

/**
 * Stream a single sherpa-onnx model file from the Hub into the cache, writing to
 * a `.part` sidecar and renaming on completion so an interrupted fetch never
 * reads as cached. Emits coalesced per-file progress for the aggregating client.
 */
async function downloadSherpaFile(
	repo: string,
	filename: string,
	dest: string,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<void> {
	const url = `${repo}/resolve/main/${filename}`;
	const response = await fetchHubFile(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${filename} (${repo}): HTTP ${response.status}`);
	}
	const total = Number(response.headers.get("content-length") ?? 0);
	transport.send({
		type: "progress",
		id: requestId,
		event: { modelKey, status: "download", name: `${repo}/${filename}`, file: filename },
	});
	const part = `${dest}.part`;
	const handle = await fs.open(part, "w");
	let loaded = 0;
	let lastEmitted = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			await handle.write(value);
			loaded += value.byteLength;
			if (loaded - lastEmitted >= PROGRESS_EMIT_BYTES || (total > 0 && loaded >= total)) {
				lastEmitted = loaded;
				transport.send({
					type: "progress",
					id: requestId,
					event: {
						modelKey,
						status: "progress",
						name: `${repo}/${filename}`,
						file: filename,
						loaded,
						total: total || loaded,
					},
				});
			}
		}
	} finally {
		await handle.close();
	}
	await fs.rename(part, dest);
}

/**
 * Ensure all sherpa-onnx model files for a tier are present in the cache,
 * downloading any that are missing, and return their absolute paths keyed by
 * role (`encoder`/`decoder`/`joiner`/`tokens` for transducers, `model`/`tokens`
 * for SenseVoice).
 */
async function ensureSherpaModelFiles(
	spec: SherpaSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<Record<string, string>> {
	const dir = path.join(getTinyModelsCacheDir(), spec.repo);
	await fs.mkdir(dir, { recursive: true });
	const resolved: Record<string, string> = {};
	for (const role in spec.files) {
		const key = role as keyof typeof spec.files;
		const filename = spec.files[key];
		const dest = path.join(dir, filename);
		const present = await fs
			.stat(dest)
			.then(stats => stats.size > 0)
			.catch(() => false);
		if (!present) await downloadSherpaFile(spec.repo, filename, dest, modelKey, transport, requestId);
		resolved[key] = dest;
	}
	return resolved;
}

/**
 * SenseVoice accepts a per-request language hint (auto/zh/en/yue/ja/ko). Map the
 * configured source language onto that set; anything else falls back to auto
 * (the model auto-detects, zh-first by training).
 */
function senseVoiceLanguage(language: string | undefined): string {
	if (!language) return "auto";
	const normalized = language.trim().toLowerCase();
	if (["auto", "zh", "en", "yue", "ja", "ko"].includes(normalized)) return normalized;
	if (normalized.startsWith("zh")) return "zh";
	if (normalized.startsWith("yue") || normalized.startsWith("cantonese")) return "yue";
	if (normalized.startsWith("ja")) return "ja";
	if (normalized.startsWith("ko")) return "ko";
	if (normalized.startsWith("en")) return "en";
	return "auto";
}

async function loadSherpaModel(
	spec: SherpaSttModelSpec,
	modelKey: SttModelKey,
	transport: SttTransport,
	requestId: string,
): Promise<LoadedModel> {
	const runtime = await loadSherpaRuntime(transport, requestId, modelKey);
	const files = await ensureSherpaModelFiles(spec, modelKey, transport, requestId);
	const startedAt = performance.now();
	const numThreads = Math.max(1, Math.min(4, os.availableParallelism()));
	const modelConfig: SherpaOfflineConfig["modelConfig"] =
		spec.modelType === "sense_voice"
			? {
					senseVoice: {
						model: files.model!,
						language: "auto",
						useInverseTextNormalization: 1,
					},
					tokens: files.tokens!,
					modelType: spec.modelType,
					numThreads,
					provider: "cpu",
					debug: 0,
				}
			: {
					transducer: { encoder: files.encoder!, decoder: files.decoder!, joiner: files.joiner! },
					tokens: files.tokens!,
					modelType: spec.modelType,
					numThreads,
					provider: "cpu",
					debug: 0,
				};
	const recognizer = await runtime.OfflineRecognizer.createAsync({
		modelConfig,
		decodingMethod: "greedy_search",
	});
	sendLog(transport, "debug", "stt: local model loaded", {
		modelKey,
		repo: spec.repo,
		engine: "sherpa",
		modelType: spec.modelType,
		provider: "cpu",
		numThreads,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
	return { engine: "sherpa", recognizer, spec, config: { modelConfig, decodingMethod: "greedy_search" } };
}

async function loadModel(modelKey: SttModelKey, transport: SttTransport, requestId: string): Promise<LoadedModel> {
	const spec = getSttModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown stt model: ${modelKey}`);
	const cached = replayCachedReady(models, modelKey, transport, requestId, ASR_TASK, spec.repo);
	if (cached) return cached;

	const loading =
		spec.engine === "sherpa"
			? loadSherpaModel(spec, modelKey, transport, requestId)
			: loadTransformersModel(spec, modelKey, transport, requestId);
	const loaded = loading.then(
		model => {
			transport.send({
				type: "progress",
				id: requestId,
				event: { modelKey, status: "ready", task: ASR_TASK, model: spec.repo },
			});
			return model;
		},
		error => {
			models.delete(modelKey);
			throw error;
		},
	);
	models.set(modelKey, loaded);
	return loaded;
}

async function decodeSegment(
	model: LoadedModel,
	spec: SttModel,
	audio: Float32Array,
	language: string | undefined,
): Promise<string> {
	if (model.engine === "sherpa") {
		// SenseVoice takes the language hint per decode: re-apply the loaded
		// config with only the language swapped (dsh's recognizer pattern).
		// Parakeet is European-only and ignores the hint.
		if (model.spec.modelType === "sense_voice" && model.config.modelConfig.senseVoice) {
			model.config.modelConfig.senseVoice.language = senseVoiceLanguage(language);
			model.recognizer.setConfig(model.config);
		}
		const stream = model.recognizer.createStream();
		stream.acceptWaveform({ samples: audio, sampleRate: ASR_SAMPLE_RATE });
		const result = await model.recognizer.decodeAsync(stream);
		return normalizeChineseScript((result.text ?? "").trim(), language);
	}
	const options: AsrCallOptions = {
		chunk_length_s: CHUNK_LENGTH_S,
		stride_length_s: STRIDE_LENGTH_S,
		return_timestamps: false,
	};
	// English-only Whisper checkpoints reject `language`/`task`; multilingual ones
	// take the configured source language (auto-detected when omitted).
	if (!spec.englishOnly) {
		options.task = "transcribe";
		if (language) options.language = language;
	}
	const output = (await model.pipeline(audio, options)) as AutomaticSpeechRecognitionOutput;
	return normalizeChineseScript((output.text ?? "").trim(), language);
}

async function transcribeAudio(
	transport: SttTransport,
	requestId: string,
	modelKey: SttModelKey,
	audio: Float32Array,
	language: string | undefined,
): Promise<string> {
	const spec = getSttModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown stt model: ${modelKey}`);
	const model = await loadModel(modelKey, transport, requestId);
	return runOnModel(() => decodeSegment(model, spec, audio, language));
}

async function handleBatchRequest(
	transport: SttTransport,
	request: Extract<SttWorkerInbound, { type: "transcribe" | "download" }>,
): Promise<void> {
	try {
		if (request.type === "download") {
			await loadModel(request.modelKey, transport, request.id);
			transport.send({ type: "downloaded", id: request.id });
			return;
		}
		const text = await transcribeAudio(transport, request.id, request.modelKey, request.audio, request.language);
		transport.send({ type: "transcription", id: request.id, text });
	} catch (error) {
		transport.send({ type: "error", id: request.id, error: errorText(error) });
	}
}

// ── Live streaming sessions ─────────────────────────────────────────

const sessions = new Map<string, LiveStreamingSession>();

function startStreamingSession(
	transport: SttTransport,
	request: Extract<SttWorkerInbound, { type: "stream_start" }>,
): void {
	const spec = getSttModelSpec(request.modelKey);
	if (!spec) {
		transport.send({ type: "error", id: request.id, error: `Unknown stt model: ${request.modelKey}` });
		return;
	}
	const model = loadModel(request.modelKey, transport, request.id);
	const session = new LiveStreamingSession({
		id: request.id,
		createEndpointer: () => createLiveEndpointer(request.id, request.modelKey, transport),
		decode: async audio => {
			const loaded = await model;
			return runOnModel(() => decodeSegment(loaded, spec, audio, request.language));
		},
		send: message => {
			transport.send(message);
			if (message.type === "stream_done" || message.type === "error") sessions.delete(request.id);
		},
	});
	sessions.set(request.id, session);
}

let sileroVadModel: Promise<string> | null = null;

/**
 * A Silero-driven endpointer with its own detector (detector state is per
 * stream). Falls back to the loudness endpointer when the sherpa-onnx runtime
 * or the VAD model cannot be loaded, so a live session never loses audio.
 */
async function createLiveEndpointer(
	id: string,
	modelKey: SttModelKey,
	transport: SttTransport,
): Promise<LiveEndpointer> {
	try {
		sileroVadModel ??= ensureVoiceFrontendModel("sileroVad").catch(error => {
			sileroVadModel = null;
			throw error;
		});
		const [runtime, model] = await Promise.all([loadSherpaRuntime(transport, id, modelKey), sileroVadModel]);
		const vad = new runtime.Vad(
			{
				sileroVad: { model, ...SILERO_VAD_SETTINGS },
				sampleRate: ASR_SAMPLE_RATE,
				numThreads: 1,
				debug: 0,
				provider: "cpu",
			},
			VAD_BUFFER_SECONDS,
		);
		return new SpeechEndpointer(vad, { sampleRate: ASR_SAMPLE_RATE });
	} catch (error) {
		sendLog(transport, "warn", "stt: speech detector unavailable; segmenting by loudness", {
			modelKey,
			error: errorMessage(error),
		});
		return new StreamEndpointer();
	}
}

function handleStreamMessage(transport: SttTransport, message: SttWorkerInbound): void {
	if (message.type === "stream_start") {
		startStreamingSession(transport, message);
		return;
	}
	const session = sessions.get(message.id);
	if (!session) return;
	switch (message.type) {
		case "stream_audio":
			session.pushAudio(message.audio);
			return;
		case "stream_utterance":
			session.pushUtterance(message.audio);
			return;
		case "stream_preview":
			session.pushPreview(message.audio);
			return;
		case "stream_stop":
			void session.stop();
			return;
		case "stream_cancel":
			session.cancel();
			sessions.delete(message.id);
			return;
	}
}

export function startSttWorker(transport: SttTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "transcribe":
			case "download":
				void handleBatchRequest(transport, message);
				return;
			default:
				handleStreamMessage(transport, message);
				return;
		}
	});
}
