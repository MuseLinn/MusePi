import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { ProgressInfo, RawAudio } from "@huggingface/transformers";
import { ensureRuntimeInstalled, getTinyModelsCacheDir, resolveRuntimeModule } from "@musepi/pi-utils";
import {
	getSherpaVersionSpec,
	installSherpaRuntime,
	type SherpaOfflineTts,
	type SherpaRuntime,
} from "../stt/sherpa-runtime";
import {
	errorMessage,
	errorText,
	installSharpStubResolver,
	MemoizedRuntime,
	replayCachedReady,
	sendLog,
	sendProgress,
	TRANSFORMERS_PACKAGE,
} from "../subprocess/worker-runtime";
import { resolveTinyModelDevicePreference, type TinyModelDevice, tinyModelDeviceLoadOrder } from "../tiny/device";
import { resolveTinyModelDtypeOverride, type TinyModelDtype } from "../tiny/dtype";
import { fetchHubFile, preferredHubOrigin } from "../tiny/hub-mirrors";
import {
	getTtsLocalModelSpec,
	type KokoroTtsLocalModelSpec,
	resolveSherpaSpeakerId,
	resolveTtsModelForText,
	resolveTtsVoice,
	type SherpaTtsLocalModelSpec,
	type TtsLocalModelKey,
	type TtsLocalModelSpec,
} from "./models";
import {
	getTtsRuntimeDir,
	KOKORO_PACKAGE,
	KOKORO_VERSION,
	ONNXRUNTIME_NODE_PACKAGE,
	ONNXRUNTIME_NODE_VERSION,
} from "./runtime";
import type { TtsTransport, TtsWorkerInbound } from "./tts-protocol";

const TTS_TASK = "text-to-speech";
// Coalesce sherpa-onnx raw-file download progress so streaming a multi-hundred-MB
// model file doesn't flood the IPC channel with one event per chunk.
const PROGRESS_EMIT_BYTES = 4_000_000;
// kokoro-js is NEVER a dependency of the main tree: its transformers@3.8.1 +
// onnxruntime-node@1.21 graph must not pollute it (1.21 segfaults Bun on session
// creation). It is lazily `bun install`ed into a side runtime dir on first use,
// with onnxruntime-node force-pinned to the Bun-safe version the rest of the
// stack runs. Bump KOKORO_VERSION to roll the cached runtime + model wrapper.

const ttsDevicePreference = resolveTinyModelDevicePreference();
const ttsDtypeOverride = resolveTinyModelDtypeOverride();

/** Device values `kokoro-js` accepts; the tiny device order is mapped onto these. */
type KokoroDevice = "cpu" | "wasm" | "webgpu";

/** A loaded Kokoro voice synthesizer (subset of `kokoro-js`'s `KokoroTTS`). */
interface KokoroTtsInstance {
	generate(text: string, options: { voice: string }): Promise<RawAudio>;
}

/** `KokoroTTS` static surface used to load a model from the Hugging Face Hub. */
interface KokoroRuntime {
	KokoroTTS: {
		from_pretrained(
			repo: string,
			options: {
				dtype: TinyModelDtype;
				device: KokoroDevice;
				progress_callback: (info: ProgressInfo) => void;
			},
		): Promise<KokoroTtsInstance>;
	};
}

/**
 * The `@huggingface/transformers` instance `kokoro-js` runs on. We only touch its
 * `env` (cache dir + log level) and `LogLevel`; inference goes through Kokoro.
 */
interface TransformersEnv {
	env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		logLevel?: unknown;
		remoteHost?: string;
		backends?: {
			onnx?: {
				logLevel?: unknown;
			};
		};
	};
	LogLevel?: {
		ERROR: unknown;
	};
}

/** A loaded TTS engine instance plus its engine tag, cached per tier key. */
type TtsSynthesizer =
	| { engine: "kokoro"; instance: KokoroTtsInstance }
	| { engine: "sherpa"; instance: SherpaOfflineTts };

const models = new Map<TtsLocalModelKey, Promise<TtsSynthesizer>>();
let synthesizeQueue = Promise.resolve();
const kokoroRuntime = new MemoizedRuntime<KokoroRuntime>();
const sherpaRuntime = new MemoizedRuntime<SherpaRuntime>();

/**
 * In-flight streaming sessions keyed by request id. A session is created on
 * `stream-start` and torn down when its run loop finishes. Each `stream-push`
 * carries one complete speakable segment (the parent's `SpeakableStream` does
 * all splitting and normalization); segments queue here and the run loop
 * synthesizes them in arrival order, waking via `wake` when idle.
 */
interface StreamSession {
	modelKey: TtsLocalModelKey;
	voice: string | undefined;
	/** Speakable segments awaiting synthesis, in arrival order. */
	queue: string[];
	/** Resolves the run loop's idle wait when a push/end/cancel arrives. */
	wake: (() => void) | null;
	ended: boolean;
	cancelled: boolean;
}
const streamSessions = new Map<string, StreamSession>();

/**
 * Map a tiny-model device onto the narrow set `kokoro-js` accepts. The worker
 * always runs `kokoro-js` on Node, where `cpu` (onnxruntime-node) is the only
 * safe option; `webgpu`/`wasm` are honored if explicitly requested.
 */
function toKokoroDevice(device: TinyModelDevice): KokoroDevice {
	if (device === "wasm") return "wasm";
	if (device === "webgpu" || device === "gpu") return "webgpu";
	return "cpu";
}

async function configureTransformers(transformers: TransformersEnv): Promise<void> {
	transformers.env.cacheDir = getTinyModelsCacheDir();
	transformers.env.allowLocalModels = false;
	transformers.env.logLevel = transformers.LogLevel?.ERROR ?? "error";
	if (transformers.env.backends?.onnx) transformers.env.backends.onnx.logLevel = "error";
	// Hub mirror fallback (快赢包 A1): Kokoro fetches its ONNX weights through
	// transformers.js, which defaults to huggingface.co — unreachable from
	// mainland networks. Point remoteHost at the probe-winning origin before
	// the first from_pretrained call (cached models never touch the network).
	transformers.env.remoteHost = await preferredHubOrigin();
}

/**
 * Lazily `bun install` `kokoro-js` into a side runtime dir (idempotent, version-
 * keyed) and return its module, with the `@huggingface/transformers` instance it
 * loads configured (cache dir + quiet logging). `kokoro-js` is NEVER a dependency
 * of the main tree: its transformers@3.8.1 graph pulls onnxruntime-node@1.21,
 * which segfaults Bun on session creation, so the runtime manifest force-pins
 * onnxruntime-node to the Bun-safe version via `overrides`. `sharp` is stubbed —
 * the TTS pipeline is audio-only, so the native image codec transformers eagerly
 * requires is dead weight. Memoized so the runtime loads once per process.
 */
function loadKokoroRuntime(
	transport: TtsTransport,
	requestId: string,
	modelKey: TtsLocalModelKey,
): Promise<KokoroRuntime> {
	return kokoroRuntime.load(async () => {
		const runtimeDir = await ensureRuntimeInstalled({
			runtimeDir: getTtsRuntimeDir(),
			install: {
				dependencies: { [KOKORO_PACKAGE]: KOKORO_VERSION },
				overrides: { [ONNXRUNTIME_NODE_PACKAGE]: ONNXRUNTIME_NODE_VERSION },
				trustedDependencies: [ONNXRUNTIME_NODE_PACKAGE],
			},
			probePackage: KOKORO_PACKAGE,
			onPhase: phase =>
				transport.send({
					type: "progress",
					id: requestId,
					event: { modelKey, status: phase, name: `${KOKORO_PACKAGE}@${KOKORO_VERSION}` },
				}),
		});
		const nodeModules = await installSharpStubResolver(runtimeDir);
		const kokoroEntry = resolveRuntimeModule(nodeModules, KOKORO_PACKAGE);
		if (!kokoroEntry) throw new Error(`Unable to resolve ${KOKORO_PACKAGE} in runtime at ${nodeModules}`);
		const transformersEntry = resolveRuntimeModule(nodeModules, TRANSFORMERS_PACKAGE);
		if (!transformersEntry) throw new Error(`Unable to resolve ${TRANSFORMERS_PACKAGE} in runtime at ${nodeModules}`);
		const runtimeRequire = createRequire(kokoroEntry);
		await configureTransformers(runtimeRequire(transformersEntry) as TransformersEnv);
		return runtimeRequire(kokoroEntry) as KokoroRuntime;
	});
}

async function loadModelOnDevice(
	runtime: KokoroRuntime,
	spec: KokoroTtsLocalModelSpec,
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
	requestId: string,
	device: KokoroDevice,
): Promise<KokoroTtsInstance> {
	return runtime.KokoroTTS.from_pretrained(spec.repo, {
		device,
		dtype: ttsDtypeOverride ?? spec.dtype,
		progress_callback: info => sendProgress(transport, requestId, modelKey, info),
	});
}

async function loadModelWithDeviceFallback(
	runtime: KokoroRuntime,
	spec: KokoroTtsLocalModelSpec,
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
	requestId: string,
): Promise<{ model: KokoroTtsInstance; device: KokoroDevice }> {
	const order = tinyModelDeviceLoadOrder(ttsDevicePreference);
	if (order[0] !== ttsDevicePreference.device) {
		sendLog(transport, "warn", "tts: requested device is unsafe in the worker; using CPU", {
			modelKey,
			repo: spec.repo,
			requestedDevice: ttsDevicePreference.device,
			device: order[0],
		});
	}
	const devices: KokoroDevice[] = [];
	for (const device of order) {
		const mapped = toKokoroDevice(device);
		if (!devices.includes(mapped)) devices.push(mapped);
	}
	for (let i = 0; i < devices.length; i += 1) {
		const device = devices[i]!;
		try {
			return { model: await loadModelOnDevice(runtime, spec, modelKey, transport, requestId, device), device };
		} catch (error) {
			if (i === devices.length - 1) throw error;
			const fallbackDevice = devices[i + 1]!;
			sendLog(transport, "warn", "tts: accelerated device failed; falling back", {
				modelKey,
				repo: spec.repo,
				device,
				fallbackDevice,
				error: errorMessage(error),
			});
		}
	}
	throw new Error("No TTS devices configured");
}

/**
 * Resolve the native `sherpa-onnx-node` module for the TTS worker. The shared
 * installer lives in `stt/sherpa-runtime.ts` — MeloTTS-zh adds no new runtime
 * dependency beyond what the STT worker already installs. Memoized so the
 * runtime loads once per process.
 */
function loadSherpaTtsRuntime(
	transport: TtsTransport,
	requestId: string,
	modelKey: TtsLocalModelKey,
): Promise<SherpaRuntime> {
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

/**
 * Stream a single sherpa-onnx TTS model file from the Hub into the cache
 * (`.part` sidecar + rename, mirror fallback via fetchHubFile), coalescing
 * per-chunk progress. Mirrors the STT worker's `downloadSherpaFile`.
 */
async function downloadSherpaTtsFile(
	repo: string,
	filename: string,
	dest: string,
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
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
 * Ensure all sherpa-onnx TTS files for a tier (flat `model`/`tokens`/`lexicon`
 * plus, when declared, the jieba dict dir and the rule FSTs) are present in the
 * cache, downloading any missing, and return their absolute paths in
 * OfflineTtsConfig shape.
 */
async function ensureSherpaTtsFiles(
	spec: SherpaTtsLocalModelSpec,
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
	requestId: string,
): Promise<{ model: string; tokens: string; lexicon: string; dictDir?: string; ruleFsts?: string }> {
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
		if (!present) await downloadSherpaTtsFile(spec.repo, filename, dest, modelKey, transport, requestId);
		resolved[key] = dest;
	}
	let dictDir: string | undefined;
	if (spec.dict) {
		dictDir = path.join(dir, spec.dict.dir);
		await fs.mkdir(dictDir, { recursive: true });
		for (const filename of spec.dict.files) {
			const dest = path.join(dictDir, filename);
			const present = await fs
				.stat(dest)
				.then(stats => stats.size > 0)
				.catch(() => false);
			if (!present)
				await downloadSherpaTtsFile(
					spec.repo,
					`${spec.dict.dir}/${filename}`,
					dest,
					modelKey,
					transport,
					requestId,
				);
		}
	}
	const ruleFsts = spec.ruleFsts?.length
		? spec.ruleFsts.map(filename => path.join(dir, filename)).join(",")
		: undefined;
	return { model: resolved.model!, tokens: resolved.tokens!, lexicon: resolved.lexicon!, dictDir, ruleFsts };
}

/** Top-level `OfflineTtsConfig` extras beyond the shared STT-side shape. */
type SherpaTtsCreateConfig = Parameters<SherpaRuntime["OfflineTts"]["createAsync"]>[0] & { ruleFsts?: string };

async function loadSherpaTtsModel(
	spec: SherpaTtsLocalModelSpec,
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
	requestId: string,
): Promise<TtsSynthesizer> {
	const runtime = await loadSherpaTtsRuntime(transport, requestId, modelKey);
	const files = await ensureSherpaTtsFiles(spec, modelKey, transport, requestId);
	const startedAt = performance.now();
	const numThreads = Math.max(1, Math.min(4, os.availableParallelism()));
	const config: SherpaTtsCreateConfig = {
		model: {
			vits: {
				model: files.model,
				tokens: files.tokens,
				lexicon: files.lexicon,
				...(files.dictDir ? { dictDir: files.dictDir } : {}),
			},
			numThreads,
			provider: "cpu",
			debug: 0,
		},
		maxNumSentences: 1,
		...(files.ruleFsts ? { ruleFsts: files.ruleFsts } : {}),
	};
	const instance = await runtime.OfflineTts.createAsync(config);
	sendLog(transport, "debug", "tts: local model loaded", {
		modelKey,
		repo: spec.repo,
		engine: "sherpa",
		modelType: spec.modelType,
		provider: "cpu",
		numThreads,
		dictDir: files.dictDir !== undefined,
		ruleFsts: files.ruleFsts !== undefined,
		elapsedMs: Math.round(performance.now() - startedAt),
	});
	return { engine: "sherpa", instance };
}

async function loadModel(
	modelKey: TtsLocalModelKey,
	transport: TtsTransport,
	requestId: string,
): Promise<TtsSynthesizer> {
	const spec = getTtsLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown local TTS model: ${modelKey}`);
	const cached = replayCachedReady(models, modelKey, transport, requestId, TTS_TASK, spec.repo);
	if (cached) return cached;

	const startedAt = performance.now();
	const loading =
		spec.engine === "sherpa"
			? loadSherpaTtsModel(spec, modelKey, transport, requestId)
			: loadKokoroRuntime(transport, requestId, modelKey).then(runtime =>
					loadModelWithDeviceFallback(runtime, spec, modelKey, transport, requestId).then(
						async ({ model, device }) => {
							sendLog(transport, "debug", "tts: local model loaded", {
								modelKey,
								repo: spec.repo,
								device,
								requestedDevice: ttsDevicePreference.device,
								dtype: ttsDtypeOverride ?? spec.dtype,
								elapsedMs: Math.round(performance.now() - startedAt),
							});
							return { engine: "kokoro" as const, instance: model };
						},
					),
				);
	const loaded = loading.then(
		synthesizer => {
			transport.send({
				type: "progress",
				id: requestId,
				event: { modelKey, status: "ready", task: TTS_TASK, model: spec.repo },
			});
			return synthesizer;
		},
		error => {
			models.delete(modelKey);
			throw error;
		},
	);
	models.set(modelKey, loaded);
	return loaded;
}

/**
 * Synthesize one text segment with the loaded engine. Kokoro returns a
 * transformers.js `RawAudio` (`audio`/`sampling_rate`); sherpa-onnx returns
 * `{samples, sampleRate}` natively.
 */
async function synthesizeSegment(
	synthesizer: TtsSynthesizer,
	spec: TtsLocalModelSpec,
	text: string,
	voice: string | undefined,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
	if (synthesizer.engine === "sherpa") {
		if (spec.engine !== "sherpa") throw new Error(`Model ${spec.key} is not a sherpa TTS tier`);
		// sherpa-onnx's node addon validates the request object strictly: a
		// missing `sid`/`speed` field throws "The argument object should have a
		// field sid/speed" instead of defaulting (the pre-fix silent-TTS bug).
		const sid = resolveSherpaSpeakerId(spec, voice);
		const output = await synthesizer.instance.generateAsync({ text, sid, speed: spec.speed ?? 1 });
		if (!output.samples || output.samples.length === 0)
			throw new Error("sherpa TTS synthesis returned no audio samples");
		return { pcm: output.samples, sampleRate: output.sampleRate || spec.sampleRate };
	}
	const output = await synthesizer.instance.generate(text, { voice: resolveTtsVoice(spec.key, voice) });
	const audio = Array.isArray(output.audio) ? output.audio[0] : output.audio;
	if (!audio) throw new Error("Kokoro synthesis returned no audio samples");
	return { pcm: audio, sampleRate: output.sampling_rate || spec.sampleRate };
}

async function synthesize(
	transport: TtsTransport,
	requestId: string,
	modelKey: TtsLocalModelKey,
	text: string,
	voice: string | undefined,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
	// Route CJK text at an English-only model to the registered Chinese tier
	// (and vice versa) before loading, so a single request never crosses scripts.
	const routedKey = resolveTtsModelForText(modelKey, text);
	const spec = getTtsLocalModelSpec(routedKey);
	if (!spec) throw new Error(`Unknown local TTS model: ${routedKey}`);
	const synthesizer = await loadModel(routedKey, transport, requestId);
	return synthesizeSegment(synthesizer, spec, text, voice);
}

function enqueueRequest(
	transport: TtsTransport,
	request: Extract<TtsWorkerInbound, { type: "synthesize" | "download" }>,
): void {
	synthesizeQueue = synthesizeQueue.then(
		async () => {
			await handleQueuedRequest(transport, request);
		},
		async () => {
			await handleQueuedRequest(transport, request);
		},
	);
}

async function handleQueuedRequest(
	transport: TtsTransport,
	request: Extract<TtsWorkerInbound, { type: "synthesize" | "download" }>,
): Promise<void> {
	try {
		if (request.type === "download") {
			await loadModel(request.modelKey, transport, request.id);
			transport.send({ type: "downloaded", id: request.id });
			return;
		}
		const { pcm, sampleRate } = await synthesize(
			transport,
			request.id,
			request.modelKey,
			request.text,
			request.voice,
		);
		transport.send({ type: "audio", id: request.id, pcm, sampleRate });
	} catch (error) {
		transport.send({ type: "error", id: request.id, error: errorText(error) });
	}
}

/**
 * Drive one streaming session to completion: load the model, then synthesize
 * each queued segment in arrival order — one `audio-chunk` per segment,
 * followed by a single `stream-done`. Chunk sends are drained before the next
 * segment's inference (see the comment at the send site). Serialized through
 * {@link synthesizeQueue} so it never interleaves model access with a batch
 * synthesize/download.
 */
async function runStreamSession(transport: TtsTransport, id: string, session: StreamSession): Promise<void> {
	try {
		if (session.cancelled) return;
		// Prime the session's requested tier up front so the first chunk doesn't
		// pay the load cost; per-segment routing below may still load the other
		// engine when the stream mixes scripts (zh/en).
		await loadModel(session.modelKey, transport, id);
		if (session.cancelled) return;
		let index = 0;
		while (!session.cancelled) {
			const segment = session.queue.shift();
			if (segment === undefined) {
				if (session.ended) break;
				const { promise, resolve } = Promise.withResolvers<void>();
				session.wake = resolve;
				// Re-check after arming: a push/end/cancel racing the empty shift.
				if (session.queue.length > 0 || session.ended || session.cancelled) {
					session.wake = null;
					resolve();
				}
				await promise;
				continue;
			}
			const routedKey = resolveTtsModelForText(session.modelKey, segment);
			const spec = getTtsLocalModelSpec(routedKey);
			if (!spec) continue;
			const synthesizer = await loadModel(routedKey, transport, id);
			if (session.cancelled) break;
			const { pcm, sampleRate } = await synthesizeSegment(synthesizer, spec, segment, session.voice);
			if (session.cancelled) break;
			// Drain the IPC write before the next segment's inference: ONNX
			// blocks this event loop for seconds at a time, so a fire-and-forget
			// send would sit in the pipe queue until the session ends and every
			// chunk would arrive in one burst (long silence, then all segments
			// at once) instead of streaming per-segment.
			await transport.sendAndFlush({
				type: "audio-chunk",
				id,
				index: index++,
				text: segment,
				pcm,
				sampleRate,
			});
		}
		if (!session.cancelled) transport.send({ type: "stream-done", id });
	} catch (error) {
		if (!session.cancelled) transport.send({ type: "error", id, error: errorText(error) });
	} finally {
		streamSessions.delete(id);
	}
}

function startStreamSession(
	transport: TtsTransport,
	message: Extract<TtsWorkerInbound, { type: "stream-start" }>,
): void {
	const session: StreamSession = {
		modelKey: message.modelKey,
		voice: message.voice,
		queue: [],
		wake: null,
		ended: false,
		cancelled: false,
	};
	streamSessions.set(message.id, session);
	synthesizeQueue = synthesizeQueue.then(
		() => runStreamSession(transport, message.id, session),
		() => runStreamSession(transport, message.id, session),
	);
}

/** Wake the session's run loop if it is parked on an empty queue. */
function wakeStreamSession(session: StreamSession): void {
	const wake = session.wake;
	session.wake = null;
	wake?.();
}

function pushToStreamSession(id: string, text: string): void {
	const session = streamSessions.get(id);
	if (!session || session.cancelled) return;
	session.queue.push(text);
	wakeStreamSession(session);
}

function endStreamSession(id: string): void {
	const session = streamSessions.get(id);
	if (!session || session.cancelled) return;
	session.ended = true;
	wakeStreamSession(session);
}

function cancelStreamSession(id: string): void {
	const session = streamSessions.get(id);
	if (!session) return;
	session.cancelled = true;
	session.queue.length = 0;
	wakeStreamSession(session);
	streamSessions.delete(id);
}

export function startTtsWorker(transport: TtsTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "stream-start":
				startStreamSession(transport, message);
				return;
			case "stream-push":
				pushToStreamSession(message.id, message.text);
				return;
			case "stream-end":
				endStreamSession(message.id);
				return;
			case "stream-cancel":
				cancelStreamSession(message.id);
				return;
			default:
				enqueueRequest(transport, message);
				return;
		}
	});
}
