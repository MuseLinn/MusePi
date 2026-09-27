import type { TinyModelDtype } from "../tiny/dtype";

/**
 * On-device speech-to-text model registry. Each tier maps a stable settings key
 * onto a locally-runnable ASR model and the engine that loads it:
 *
 * - `transformers` — a transformers.js / ONNX Whisper repo, loaded by the
 *   `@huggingface/transformers` `automatic-speech-recognition` pipeline.
 * - `sherpa` — a sherpa-onnx (Next-gen Kaldi) offline model, loaded by the
 *   native `sherpa-onnx-node` addon. Used for NVIDIA Parakeet, the Open ASR
 *   Leaderboard accuracy/speed leader.
 *
 * The worker resolves the spec by key and loads the model lazily (kept warm
 * afterwards). Both engines run inside the hard-killed subprocess worker.
 */

/** ASR runtime that loads a given tier's model. */
export type SttEngine = "transformers" | "sherpa";

interface SttModelBase {
	/** Stable key persisted in `stt.modelName` and sent over the worker protocol. */
	key: string;
	engine: SttEngine;
	/** Hugging Face repo id (transformers.js ONNX repo, or sherpa-onnx model repo). */
	repo: string;
	/** English-only checkpoint: rejects a configured source `language`. */
	englishOnly: boolean;
	label: string;
	description: string;
	/** Approximate on-disk download size for the shipped weights (UI hint). */
	sizeHint: string;
	/** BCP-47-ish language codes the checkpoint handles (`auto` = auto-detect). */
	languages?: readonly string[];
}

/** A Whisper-family tier loaded via the transformers.js ASR pipeline. */
export interface TransformersSttModelSpec extends SttModelBase {
	engine: "transformers";
	/** ONNX precision used unless overridden by `PI_TINY_DTYPE` / `providers.tinyModelDtype`. */
	dtype: TinyModelDtype;
}

/** A sherpa-onnx transducer tier (e.g. NeMo Parakeet) loaded natively. */
export interface SherpaTransducerSttModelSpec extends SttModelBase {
	engine: "sherpa";
	/** sherpa-onnx offline model family (e.g. `nemo_transducer`). */
	modelType: "nemo_transducer";
	/** Model files (relative to the repo root) fetched into the local cache. */
	files: { encoder: string; decoder: string; joiner: string; tokens: string };
}

/** A sherpa-onnx non-autoregressive single-file tier (FunAudioLLM SenseVoice). */
export interface SherpaSenseVoiceSttModelSpec extends SttModelBase {
	engine: "sherpa";
	/** sherpa-onnx offline model family; selects the `senseVoice` config branch. */
	modelType: "sense_voice";
	/** Model files (relative to the repo root) fetched into the local cache. */
	files: { model: string; tokens: string };
}

export type SherpaSttModelSpec = SherpaTransducerSttModelSpec | SherpaSenseVoiceSttModelSpec;

export type SttModelSpec = TransformersSttModelSpec | SherpaSttModelSpec;

/**
 * Speech model tiers, ordered light → SoTA. Defaults to {@link DEFAULT_STT_MODEL_KEY}.
 * `fast`/`balanced`/`turbo` are multilingual Whisper checkpoints on transformers.js;
 * `parakeet` is NVIDIA Parakeet TDT 0.6B v3 on sherpa-onnx — the Open ASR
 * Leaderboard accuracy/speed leader for English/European speech;
 * `sensevoice` is FunAudioLLM SenseVoiceSmall (INT8) on sherpa-onnx — the
 * Chinese-optimized tier (zh first; zh/en mixed speech is its home turf).
 */
export const STT_MODELS = [
	{
		key: "fast",
		engine: "transformers",
		repo: "onnx-community/whisper-base",
		dtype: "q8",
		englishOnly: false,
		label: "Fast (Whisper base)",
		description: "Whisper base, multilingual. Smallest + fastest; lowest accuracy. Best for low-resource machines.",
		sizeHint: "~60 MB",
	},
	{
		key: "balanced",
		engine: "transformers",
		repo: "onnx-community/whisper-small",
		dtype: "q8",
		englishOnly: false,
		label: "Balanced (Whisper small)",
		description:
			"Whisper small, multilingual (Chinese/Japanese/Korean ready). Default tier — more accurate than Fast, still light on CPU/RAM.",
		sizeHint: "~190 MB",
	},
	{
		key: "turbo",
		engine: "transformers",
		repo: "onnx-community/whisper-large-v3-turbo",
		dtype: "q4",
		englishOnly: false,
		label: "Turbo (Whisper large-v3)",
		description: "Whisper large-v3-turbo, 99 languages. Widest language coverage; large download, slower.",
		sizeHint: "~600 MB",
	},
	{
		key: "parakeet",
		engine: "sherpa",
		repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
		modelType: "nemo_transducer",
		files: {
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		},
		englishOnly: false,
		label: "Parakeet TDT v3 (SoTA)",
		description:
			"NVIDIA Parakeet TDT 0.6B v3 — 25 European languages only (no Chinese/Japanese/Korean; the worker ignores `language`, so CJK speech transcribes to empty). Open ASR Leaderboard leader for accuracy and speed; pick it for English/European dictation.",
		sizeHint: "~680 MB",
	},
	{
		key: "sensevoice",
		engine: "sherpa",
		// FunAudioLLM SenseVoiceSmall (sherpa-onnx official export, INT8).
		// Verified against deepseek-harness runtime/assets.json: repo revision
		// 2365bae…, model.int8.onnx = 239,233,841 B, tokens.txt = 315,894 B.
		repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
		modelType: "sense_voice",
		files: {
			model: "model.int8.onnx",
			tokens: "tokens.txt",
		},
		englishOnly: false,
		languages: ["auto", "zh", "en", "yue", "ja", "ko"],
		label: "SenseVoiceSmall (INT8)",
		description:
			"FunAudioLLM SenseVoiceSmall — Chinese-optimized non-autoregressive model: Mandarin, Cantonese (yue), mixed zh/en speech, plus ja/ko. Faster and smaller than Whisper small with strong Chinese accuracy; INT8 quant keeps the download at ~239 MB. Auto language detect when no source language is set.",
		sizeHint: "~239 MB",
	},
] as const satisfies readonly SttModelSpec[];

/**
 * Default tier: Whisper small (multilingual). Was the SoTA Parakeet — but
 * Parakeet TDT v3's 25 languages are all European and the sherpa worker
 * cannot switch language, so Chinese (the app's primary audience) silently
 * transcribed to empty text. English-first users who want the leaderboard
 * leader can still pick Parakeet in settings (downloaded on first use).
 */
export const DEFAULT_STT_MODEL_KEY = "balanced";

export type SttModelKey = (typeof STT_MODELS)[number]["key"];

/** A concrete entry from {@link STT_MODELS}; `key` is the literal tier union. */
export type SttModel = (typeof STT_MODELS)[number];

export const STT_MODEL_VALUES = [
	"fast",
	"balanced",
	"turbo",
	"parakeet",
	"sensevoice",
] as const satisfies readonly SttModelKey[];

type MissingSttModelValue = Exclude<SttModelKey, (typeof STT_MODEL_VALUES)[number]>;
type ExtraSttModelValue = Exclude<(typeof STT_MODEL_VALUES)[number], SttModelKey>;
const STT_MODEL_VALUES_MATCH_REGISTRY: MissingSttModelValue extends never
	? ExtraSttModelValue extends never
		? true
		: never
	: never = true;
void STT_MODEL_VALUES_MATCH_REGISTRY;

export const STT_MODEL_OPTIONS = STT_MODELS.map(({ key, label, description }) => ({
	value: key,
	label,
	description,
})) satisfies ReadonlyArray<{ value: SttModelKey; label: string; description: string }>;

export function isSttModelKey(value: string): value is SttModelKey {
	return STT_MODELS.some(model => model.key === value);
}

export function getSttModelSpec(key: string): SttModel | undefined {
	return STT_MODELS.find(model => model.key === key);
}

/**
 * Resolve a (possibly stale or legacy) `stt.modelName` value onto a concrete
 * spec, falling back to the SoTA default when the key is unknown.
 */
export function resolveSttModelSpec(key: string | undefined): SttModel {
	return (key !== undefined ? getSttModelSpec(key) : undefined) ?? getSttModelSpec(DEFAULT_STT_MODEL_KEY)!;
}
