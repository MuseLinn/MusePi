import type { TinyModelDtype } from "../tiny/dtype";

/**
 * Voice exposed by a local TTS model. Kokoro ships a fixed catalog of named
 * voices; a sherpa-onnx VITS model (MeloTTS-zh) has fixed speaker ids. A voice
 * is just a stable id plus a display label. Selection is purely on-device —
 * generating with a different voice needs no extra network fetch once the
 * model weights are cached.
 */
export interface TtsLocalVoiceSpec {
	id: string;
	label: string;
}

/** Engine that loads a given local TTS model's weights. */
export type TtsEngine = "kokoro" | "sherpa";

interface TtsLocalModelBase {
	key: string;
	repo: string;
	/** PCM sample rate the model emits; fallback only — the worker uses the value the runtime reports. */
	sampleRate: number;
	label: string;
	description: string;
	/** First entry is the model's default voice. */
	voices: readonly TtsLocalVoiceSpec[];
	/** BCP-47-ish languages the model speaks well (UI hint + auto-routing). */
	languages?: readonly string[];
}

/**
 * A Kokoro-82M repo loaded through `kokoro-js` (`KokoroTTS.from_pretrained`),
 * which runs on the same `@huggingface/transformers` + `onnxruntime` runtime
 * as the rest of the tiny-model stack and bundles the misaki/espeak phonemizer
 * Kokoro needs. `dtype` is the default ONNX precision (overridable via
 * `providers.tinyModelDtype`/`PI_TINY_DTYPE`). English-only in practice.
 */
export interface KokoroTtsLocalModelSpec extends TtsLocalModelBase {
	engine: "kokoro";
	dtype: TinyModelDtype;
}

/**
 * A sherpa-onnx offline VITS TTS model (e.g. MeloTTS-zh) loaded natively via
 * `sherpa-onnx-node`'s `OfflineTts` — the same native package the STT worker
 * already installs, so a Chinese TTS tier adds no new runtime dependency.
 */
export interface SherpaTtsLocalModelSpec extends TtsLocalModelBase {
	engine: "sherpa";
	/** sherpa-onnx offline TTS family (currently only `vits`). */
	modelType: "vits";
	/** Model files (relative to the repo root) fetched into the local cache. */
	files: { model: string; tokens: string; lexicon: string };
}

export type TtsLocalModelSpec = KokoroTtsLocalModelSpec | SherpaTtsLocalModelSpec;

/**
 * Curated Kokoro-82M voice catalog. Kokoro ships ~28 voices; we surface the
 * higher-graded ones across American/British × female/male so the picker stays
 * useful without listing every D/F-grade sample. `af_heart` (grade A) leads and
 * is the default voice. Grades are Kokoro's own `overallGrade` ratings.
 */
export const KOKORO_VOICES: readonly TtsLocalVoiceSpec[] = [
	{ id: "af_heart", label: "Heart (American female)" },
	{ id: "af_bella", label: "Bella (American female)" },
	{ id: "af_nicole", label: "Nicole (American female)" },
	{ id: "af_aoede", label: "Aoede (American female)" },
	{ id: "af_kore", label: "Kore (American female)" },
	{ id: "af_sarah", label: "Sarah (American female)" },
	{ id: "am_michael", label: "Michael (American male)" },
	{ id: "am_fenrir", label: "Fenrir (American male)" },
	{ id: "am_puck", label: "Puck (American male)" },
	{ id: "bf_emma", label: "Emma (British female)" },
	{ id: "bm_george", label: "George (British male)" },
	{ id: "bm_fable", label: "Fable (British male)" },
] as const;

/** Default voice within the default model — Kokoro's flagship grade-A voice. */
export const DEFAULT_TTS_VOICE = "af_heart";

/** Default local TTS model used when `tts.localModel` is unset. */
export const DEFAULT_TTS_LOCAL_MODEL_KEY = "kokoro";

/**
 * Local TTS model registry. Kokoro-82M is the on-device SoTA tiny TTS for
 * English (tops the TTS Arena leaderboard); the `onnx-community` ONNX export
 * runs through `kokoro-js` on the shared transformers.js/onnxruntime worker.
 * MeloTTS-zh is the Chinese tier: sherpa-onnx's official vits-melo-tts-zh_en
 * export (MeloTTS-Chinese, single speaker, handles mixed zh/en), loaded by
 * the native sherpa-onnx stack the STT worker already ships.
 */
export const TTS_LOCAL_MODELS = [
	{
		key: "kokoro",
		engine: "kokoro",
		repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
		dtype: "q8",
		sampleRate: 24_000,
		label: "Kokoro-82M",
		description: "Kokoro-82M neural TTS — SoTA on-device quality, multi-voice, fully local (English-first)",
		voices: KOKORO_VOICES,
		languages: ["en"],
	},
	{
		key: "melotts-zh",
		engine: "sherpa",
		// sherpa-onnx official MeloTTS-zh export (from myshell-ai/MeloTTS-Chinese).
		// File layout verified against the k2-fsa sherpa-onnx docs: model.onnx
		// (~163 MB), tokens.txt, lexicon.txt — built-in word segmentation, no
		// external dict dir needed.
		repo: "csukuangfj/vits-melo-tts-zh_en",
		modelType: "vits",
		files: {
			model: "model.onnx",
			tokens: "tokens.txt",
			lexicon: "lexicon.txt",
		},
		sampleRate: 44_100,
		label: "MeloTTS 中文",
		description:
			"MeloTTS Chinese neural TTS (sherpa-onnx VITS) — Mandarin + mixed zh/en, single speaker, fully local",
		voices: [{ id: "default", label: "MeloTTS 中文女声" }],
		languages: ["zh", "en"],
	},
] as const satisfies readonly TtsLocalModelSpec[];

export type TtsLocalModelKey = (typeof TTS_LOCAL_MODELS)[number]["key"];

export const TTS_LOCAL_MODEL_VALUES = ["kokoro", "melotts-zh"] as const;

type MissingTtsModelValue = Exclude<TtsLocalModelKey, (typeof TTS_LOCAL_MODEL_VALUES)[number]>;
type ExtraTtsModelValue = Exclude<(typeof TTS_LOCAL_MODEL_VALUES)[number], TtsLocalModelKey>;
const TTS_LOCAL_MODEL_VALUES_MATCH_REGISTRY: MissingTtsModelValue extends never
	? ExtraTtsModelValue extends never
		? true
		: never
	: never = true;
void TTS_LOCAL_MODEL_VALUES_MATCH_REGISTRY;

export const TTS_LOCAL_MODEL_OPTIONS = [
	{
		value: "kokoro",
		label: "Kokoro-82M",
		description: "Kokoro-82M neural TTS — SoTA on-device quality, multi-voice, fully local (English-first)",
	},
	{
		value: "melotts-zh",
		label: "MeloTTS 中文",
		description:
			"MeloTTS Chinese neural TTS (sherpa-onnx VITS) — Mandarin + mixed zh/en, single speaker, fully local",
	},
] as const satisfies ReadonlyArray<{ value: TtsLocalModelKey; label: string; description: string }>;

/** Voice options for the `tts.localVoice` setting picker: the union of every registered model's catalog. */
export const TTS_LOCAL_VOICE_OPTIONS = TTS_LOCAL_MODELS.flatMap(model =>
	model.voices.map(voice => ({ value: voice.id, label: voice.label })),
) as ReadonlyArray<{ value: string; label: string }>;

/** Accepted `tts.localVoice` values (union of all model catalogs) for schema validation. */
export const TTS_LOCAL_VOICE_VALUES = TTS_LOCAL_MODELS.flatMap(model => model.voices.map(voice => voice.id));

export function getTtsLocalModelSpec(key: string): TtsLocalModelSpec | undefined {
	return TTS_LOCAL_MODELS.find(model => model.key === key);
}

export function isTtsLocalModelKey(value: string): value is TtsLocalModelKey {
	return getTtsLocalModelSpec(value) !== undefined;
}

/** Resolve a model key (or the default) to its registry spec. */
export function resolveTtsModelSpec(modelKey: string | undefined): TtsLocalModelSpec {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY);
	if (!spec) throw new Error(`No local TTS model registered for key: ${modelKey ?? DEFAULT_TTS_LOCAL_MODEL_KEY}`);
	return spec;
}

/** Resolve a model key (or the default) to its Hugging Face repo id. */
export function resolveTtsRepo(modelKey: string | undefined): string {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY);
	if (!spec) throw new Error(`No local TTS model registered for key: ${modelKey ?? DEFAULT_TTS_LOCAL_MODEL_KEY}`);
	return spec.repo;
}

/**
 * Resolve a requested voice id to a concrete voice the model supports, falling
 * back to the model's default voice (first entry) when the id is unknown or the
 * legacy `"default"` sentinel. The returned id is always valid for the model.
 */
export function resolveTtsVoice(modelKey: string | undefined, voice: string | undefined): string {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY);
	const fallback = spec?.voices[0]?.id ?? DEFAULT_TTS_VOICE;
	if (!spec || !voice) return fallback;
	const match = spec.voices.find(v => v.id === voice);
	return match ? match.id : fallback;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_RE = /[A-Za-z]/;

/**
 * Whether the text is predominantly CJK script (Chinese/Japanese/Korean). Kokoro
 * is English-only — feeding it Chinese produces phonetic gibberish — while
 * MeloTTS-zh reads Mandarin and mixed zh/en. Mixed-script text counts as CJK
 * when CJK characters outnumber Latin letters.
 */
export function isPredominantlyCjkText(text: string): boolean {
	let cjk = 0;
	let latin = 0;
	for (const ch of text) {
		if (CJK_RE.test(ch)) cjk += 1;
		else if (LATIN_RE.test(ch)) latin += 1;
	}
	return cjk > 0 && cjk >= latin;
}

/**
 * Whether a model's declared language list includes `lang`. Declared as a
 * plain `readonly string[]` parameter because the registry's `as const`
 * narrows each entry to its literal tuple, whose `includes` rejects other
 * string literals at the type level.
 */
function speaksLanguage(languages: readonly string[] | undefined, lang: string): boolean {
	return languages?.includes(lang) ?? false;
}

/**
 * Pick the concrete model that should synthesize `text` for a requested tier.
 * Explicit picks win unless the model cannot speak the text's script: CJK text
 * routed at Kokoro (English-only) falls back to the registered Chinese tier, so
 * callers don't have to know which model covers which language.
 */
export function resolveTtsModelForText(modelKey: string | undefined, text: string): TtsLocalModelKey {
	const requestedKey = modelKey && isTtsLocalModelKey(modelKey) ? modelKey : DEFAULT_TTS_LOCAL_MODEL_KEY;
	const requested = getTtsLocalModelSpec(requestedKey)!;
	if (!isPredominantlyCjkText(text)) return requestedKey;
	if (speaksLanguage(requested.languages, "zh")) return requestedKey;
	const chineseTier = TTS_LOCAL_MODELS.find(model => speaksLanguage(model.languages, "zh"));
	return chineseTier ? chineseTier.key : requestedKey;
}
