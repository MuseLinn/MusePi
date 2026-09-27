import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureRuntimeInstalled,
	getTinyModelsCacheDir,
	isCompiledBinary,
	type RuntimeInstallPhase,
	resolveRuntimeModule,
} from "@musepi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };

const SHERPA_PACKAGE = "sherpa-onnx-node";

interface SherpaOfflineResult {
	text?: string;
}

interface SherpaOfflineStream {
	acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void;
}

/** sherpa-onnx transducer model branch (encoder/decoder/joiner triple). */
interface SherpaTransducerConfig {
	encoder: string;
	decoder: string;
	joiner: string;
}

/** sherpa-onnx SenseVoice branch: single model file + language hint. */
interface SherpaSenseVoiceConfig {
	model: string;
	/** auto / zh / en / yue / ja / ko. */
	language: string;
	useInverseTextNormalization: number;
}

export interface SherpaOfflineConfig {
	modelConfig: {
		transducer?: SherpaTransducerConfig;
		senseVoice?: SherpaSenseVoiceConfig;
		tokens: string;
		modelType: string;
		numThreads: number;
		provider: string;
		debug: number;
	};
	decodingMethod: string;
}

/** A sherpa-onnx recognizer instance used by the STT worker. */
export interface SherpaOfflineRecognizer {
	createStream(): SherpaOfflineStream;
	/** Apply a mutated config in place (e.g. switch the SenseVoice language hint). */
	setConfig(config: SherpaOfflineConfig): void;
	decodeAsync(stream: SherpaOfflineStream): Promise<SherpaOfflineResult>;
}

/** Config for a sherpa-onnx offline VITS TTS model (e.g. MeloTTS-zh). */
export interface SherpaOfflineTtsConfig {
	model: {
		vits: {
			model: string;
			tokens: string;
			lexicon: string;
			/** MeloTTS needs no external dict dir — built-in word segmentation. */
			dictDir?: string;
		};
		numThreads: number;
		provider: string;
		debug: number;
	};
	maxNumSentences: number;
}

/** Synthesized audio returned by `OfflineTts.generate`. */
export interface SherpaGeneratedAudio {
	samples: Float32Array;
	sampleRate: number;
}

/** A sherpa-onnx TTS instance used by the TTS worker. */
export interface SherpaOfflineTts {
	readonly sampleRate: number;
	generate(request: { text: string; sid?: number; speed?: number }): SherpaGeneratedAudio;
	generateAsync(request: { text: string; sid?: number; speed?: number }): Promise<SherpaGeneratedAudio>;
}

/** The native sherpa-onnx module surface used by the speech workers. */
export interface SherpaRuntime {
	OfflineRecognizer: {
		createAsync(config: SherpaOfflineConfig): Promise<SherpaOfflineRecognizer>;
	};
	OfflineTts: {
		createAsync(config: SherpaOfflineTtsConfig): Promise<SherpaOfflineTts>;
	};
}

/** Loads the nearest working source-workspace sherpa wrapper, including hoisted fallbacks. */
export function loadSourceSherpaRuntime(sourceUrl: string): SherpaRuntime {
	const sourceRequire = createRequire(sourceUrl);
	const nearestEntry = sourceRequire.resolve(SHERPA_PACKAGE);
	try {
		return createRequire(nearestEntry)(nearestEntry);
	} catch (error) {
		if (!(error instanceof Error && error.message.startsWith("Could not find sherpa-onnx-node. Tried"))) {
			throw error;
		}
		const platform = os.platform();
		const platformPackage = `sherpa-onnx-${platform === "win32" ? "win" : platform}-${os.arch()}`;
		for (const nodeModules of sourceRequire.resolve.paths(SHERPA_PACKAGE) ?? []) {
			if (!resolveRuntimeModule(nodeModules, platformPackage)) continue;
			const entry = resolveRuntimeModule(nodeModules, SHERPA_PACKAGE);
			if (!entry || entry === nearestEntry) continue;
			try {
				return createRequire(entry)(entry);
			} catch (candidateError) {
				if (
					!(
						candidateError instanceof Error &&
						candidateError.message.startsWith("Could not find sherpa-onnx-node. Tried")
					)
				) {
					throw candidateError;
				}
			}
		}
		throw error;
	}
}

let cachedSherpaVersionSpec: string | undefined;

function resolveSherpaVersionSpec(): string {
	const manifest = packageJson as {
		optionalDependencies?: Record<string, string>;
		dependencies?: Record<string, string>;
	};
	const versionSpec = manifest.optionalDependencies?.[SHERPA_PACKAGE] ?? manifest.dependencies?.[SHERPA_PACKAGE];
	if (!versionSpec) throw new Error(`${SHERPA_PACKAGE} is missing from package.json optionalDependencies`);
	return versionSpec;
}

/** Version spec of the native `sherpa-onnx-node` package (worker protocol + runtime dir key). */
export function getSherpaVersionSpec(): string {
	cachedSherpaVersionSpec ??= resolveSherpaVersionSpec();
	return cachedSherpaVersionSpec;
}

/**
 * Side runtime dir for the native sherpa-onnx addon in compiled binaries.
 * Shared by the STT and TTS workers — same package version, same install.
 */
export function getSherpaRuntimeDir(): string {
	const key = getSherpaVersionSpec().replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(path.dirname(getTinyModelsCacheDir()), "stt-runtime", `sherpa-${key}`);
}

/**
 * Resolve the native `sherpa-onnx-node` module for either worker. In a compiled
 * binary the addon (plus its per-platform prebuilt `sherpa-onnx.node` + bundled
 * onnxruntime dylibs) is installed into a side runtime dir; the addon resolves
 * its native library relative to its own location, so a plain `createRequire`
 * of the entry is enough. Each worker wraps this in its own `MemoizedRuntime`.
 */
export async function installSherpaRuntime(onPhase: (phase: RuntimeInstallPhase) => void): Promise<SherpaRuntime> {
	if (!isCompiledBinary()) return loadSourceSherpaRuntime(import.meta.url);
	const runtimeDir = await ensureRuntimeInstalled({
		runtimeDir: getSherpaRuntimeDir(),
		install: { dependencies: { [SHERPA_PACKAGE]: getSherpaVersionSpec() } },
		probePackage: SHERPA_PACKAGE,
		onPhase,
	});
	const nodeModules = path.join(runtimeDir, "node_modules");
	const entry = resolveRuntimeModule(nodeModules, SHERPA_PACKAGE);
	if (!entry) throw new Error(`Unable to resolve ${SHERPA_PACKAGE} in compiled runtime at ${nodeModules}`);
	return createRequire(entry)(entry);
}
