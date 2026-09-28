/*
 * Voice I/O: local STT/TTS via the daemon (sherpa-ONNX ASR + Kokoro TTS).
 * Extends the inherited exports (startDictation / speak / voiceAvailable /
 * VoiceActivity) with startDictationOpts (VAD auto-stop + device + language),
 * speak voice/rate options, enumerateMicDevices, and barge-in (duck/pause).
 */
import { getLocaleSnapshot, t } from "../i18n/index.js";
import type { RpcClient } from "./rpc";

/* ── 类型（沿用） ─────────────────────────────────────────────── */

/** RPC cap for stt.transcribe / tts.synthesize: first use downloads and loads
 *  a GB-scale local model inside the call (Whisper small q8 ≈ 190 MB), and
 *  CPU inference of a full 15 s window is itself slow — the default 15 s
 *  request cap turned exactly that into "request timeout: stt.transcribe". */
const SPEECH_RPC_TIMEOUT_MS = 180_000;
/** Preheat RPC returns immediately (progress rides the event stream). */
const PREHEAT_RPC_TIMEOUT_MS = 15_000;

export type VoiceActivity =
	| { phase: "recording"; seconds: number; level: number }
	| { phase: "transcribing" }
	| { phase: "speaking" }
	| { phase: "done" }
	| { phase: "stopped" }
	| { phase: "error"; message: string };

export interface DictateOptions {
	rpc: RpcClient | null;
	/** 透传给 stt.transcribe(language) */
	language?: string;
	/** 设备 id（来自 enumerateMicDevices） */
	deviceId?: string;
	/** VAD 静音判停（毫秒）；缺省则读设置 `stt.vadEndMs`，设置也不可用时用 15s 上限 */
	vadEndMs?: number;
	/** 打断已播放 TTS：duck(降到 25%) 或 pause */
	bargeIn?: "duck" | "pause";
	onFinal(text: string): void;
	onError(message: string): void;
	onState?(activity: VoiceActivity): void;
}

export interface SpeakOptions {
	/** Kokoro voice，如 af_heart（打通 voice 参数） */
	voice?: string;
	/** 语速 0.5–2.0 */
	rate?: number;
	/** 朗读内容模式 */
	mode?: "raw" | "sanitize" | "summarize";
}

/* ── 设备枚举 ─────────────────────────────────────────────────── */
export interface MicDevice {
	deviceId: string;
	label: string;
	kind: string;
}
export async function enumerateMicDevices(): Promise<MicDevice[]> {
	try {
		// 触发一次权限，否则 label 为空
		await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
		const d = await navigator.mediaDevices.enumerateDevices();
		return d
			.filter(x => x.kind === "audioinput")
			.map((x, i) => ({
				deviceId: x.deviceId,
				label: x.label || `麦克风 ${i + 1}`,
				kind: x.kind,
			}));
	} catch {
		return [];
	}
}

/* ── 录音（16kHz mono float PCM + 能量端点 VAD） ───────────────── */
// #9: recordPcm used to return the moment the mic opened, handing the
// caller a snapshot of an EMPTY chunk list — dictation transcribed
// nothing, and vadEndMs "did nothing" because nobody ever waited for the
// VAD/timer/stop path. The contract now: `done` resolves once recording
// actually FINISHES (VAD end, max-seconds timer, or an external stop)
// with the FULL buffer; `stop` lets a cancel button finish it early.
//
// #23: the desktop capture ran at the AudioContext's default rate (48 kHz on
// Windows) and shipped the raw floats, so Parakeet — which the daemon worker
// feeds at a hardcoded 16 kHz — heard 3× speed and usually returned an empty
// transcript, and a 15 s buffer blew the daemon's request cap (4 MiB at the
// time). Capture at 16 kHz like guest-client does, resample when the engine
// ignores the request, and quantise the payload so long recordings stay small.

/** 16 kHz mono — the format `stt.transcribe` expects (guest-client parity). */
export const TARGET_SAMPLE_RATE = 16_000;

/** Linear-interpolation resample to {@link TARGET_SAMPLE_RATE}; no-op when the
 *  capture already ran at 16 kHz (guest-client parity). */
export function resampleToTargetRate(input: Float32Array, fromRate: number): Float32Array {
	if (fromRate === TARGET_SAMPLE_RATE || input.length === 0) return input;
	const ratio = fromRate / TARGET_SAMPLE_RATE;
	const outLen = Math.floor(input.length / ratio);
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const left = Math.floor(pos);
		const right = Math.min(left + 1, input.length - 1);
		const frac = pos - left;
		out[i] = input[left]! * (1 - frac) + input[right]! * frac;
	}
	return out;
}

/** Wire-size guard for #23 C: `stt.transcribe` takes float JSON. The daemon
 *  cap is 16 MiB (2026-09-18), but float JSON prints ~20 bytes/sample — a
 *  minute of 16 kHz audio would be ~115 MB raw. 5 decimals keeps ~13 bits of
 *  mantissa (well inside what 16-bit ASR audio carries) at ~8 bytes/sample,
 *  so long recordings stay well inside the cap. */
export function quantiseForWire(pcm: Float32Array): number[] {
	return Array.from(pcm, v => Math.round(v * 1e5) / 1e5);
}

function recordPcm(opts: {
	maxSeconds?: number;
	deviceId?: string;
	vadEndMs?: number;
	onLevel?: (rms: number) => void;
	/** Polled after the mic opens and on every audio frame: a cancel that
	 *  raced ahead of getUserMedia still closes the stream immediately. */
	isCancelled?: () => boolean;
}): { done: Promise<{ pcm: Float32Array } | null>; stop(): void } {
	let requestStop: (() => void) | null = null;
	const done = (async (): Promise<{ pcm: Float32Array } | null> => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: opts.deviceId ? { deviceId: { exact: opts.deviceId } } : true,
			});
			// #23 B: ask for 16 kHz explicitly (Chromium honours it); engines that
			// ignore the request fall back to the default rate and are resampled
			// on finish, so the PCM that reaches the daemon is always 16 kHz.
			const Ctor = window.AudioContext;
			let ctx: AudioContext;
			try {
				ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
			} catch {
				ctx = new AudioContext();
			}
			const source = ctx.createMediaStreamSource(stream);
			const node = ctx.createScriptProcessor(4096, 1, 1);
			const chunks: Float32Array[] = [];
			// VAD：自适应噪声底 + 静音计数器
			let noiseFloor = 0.02;
			let silenceMs = 0;
			let lastVoiceAt = Date.now();
			// #23 A: the VAD path had never actually run (no caller passed
			// vadEndMs before), so its first real users would have hit this:
			// `silenceMs` accumulates from the very first frame, so a user who
			// takes a second to start talking got cut off before saying a word.
			// Silence may only END a recording once some speech was heard;
			// before that, the 15 s cap stays the only stop condition.
			let hasVoice = false;
			let finished = false;
			let resolve!: (value: { pcm: Float32Array }) => void;
			const finishedPromise = new Promise<{ pcm: Float32Array }>(res => {
				resolve = res;
			});

			const assemble = (): Float32Array => {
				const total = chunks.reduce((n, c) => n + c.length, 0);
				const out = new Float32Array(total);
				let off = 0;
				for (const c of chunks) {
					out.set(c, off);
					off += c.length;
				}
				// #23 B: whatever rate the engine actually ran at, hand the daemon 16 kHz.
				return resampleToTargetRate(out, ctx.sampleRate);
			};
			const finish = (): void => {
				if (finished) return;
				finished = true;
				node.onaudioprocess = null;
				node.disconnect();
				source.disconnect();
				sink.disconnect();
				stream.getTracks().forEach(t => t.stop());
				void ctx.close();
				requestStop = null;
				resolve({ pcm: assemble() });
			};

			node.onaudioprocess = e => {
				if (finished) return;
				if (opts.isCancelled?.()) {
					finish();
					return;
				}
				const data = e.inputBuffer.getChannelData(0);
				chunks.push(new Float32Array(data));
				let sum = 0;
				for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
				const rms = Math.min(1, Math.sqrt(sum / data.length) * 4);
				if (opts.onLevel) opts.onLevel(rms);
				const vadEndMs = opts.vadEndMs ?? 0;
				if (vadEndMs > 0) {
					// 短时能量低 → 视为静音；累计超过 vadEndMs 则自动结束
					if (rms < noiseFloor * 1.15) {
						silenceMs += (data.length / ctx.sampleRate) * 1000;
						if (hasVoice && silenceMs >= vadEndMs && Date.now() - lastVoiceAt >= 300) {
							finish();
							return;
						}
					} else {
						hasVoice = true;
						silenceMs = 0;
						lastVoiceAt = Date.now();
						// 缓慢抬升噪声底（背景缓慢变吵）
						noiseFloor = Math.max(0.01, Math.min(0.3, noiseFloor * 0.999 + rms * 0.001));
					}
				}
			};
			// #23 E: the processor only pulls while something consumes its output,
			// but `node.connect(ctx.destination)` played the mic straight back out
			// of the speakers — feedback that raises the noise floor and makes the
			// VAD's silence detection harder. Route through a zero-gain sink
			// (guest-client parity): the graph stays alive, nothing is audible.
			const sink = ctx.createGain();
			sink.gain.value = 0;
			source.connect(node);
			node.connect(sink);
			sink.connect(ctx.destination);
			void ctx.resume().catch(() => {});
			requestStop = finish;
			setTimeout(finish, (opts.maxSeconds ?? 15) * 1000);
			return await finishedPromise;
		} catch {
			return null;
		}
	})();
	return { done, stop: () => requestStop?.() };
}

/* ── 打断：记录当前活跃 TTS，口述时 duck / pause ───────────────── */
let activeTts: { duck(): void; pause(): void; resume(): void } | null = null;

/* ── 口述 ─────────────────────────────────────────────────────── */
export function startDictation(
	onFinal: (text: string) => void,
	onError: (message: string) => void,
	rpc: RpcClient | null,
	onState?: (activity: VoiceActivity) => void,
): (() => void) | null {
	// Pick up the microphone chosen in Settings → 语音 for EVERY dictation entry
	// point (composer, welcome composer, settings test): the plumbing accepted
	// `deviceId` from the start, but nothing ever supplied it, so the picker had
	// no effect. Callers that pass their own opts still win.
	return startDictationOpts({ rpc, onFinal, onError, onState, deviceId: getVoiceInputDevice() ?? undefined });
}

/** Chosen microphone (deviceId). localStorage, not a schema setting: the value
 *  is machine-local (a device id is meaningless on another host) and the
 *  picker lives next to the live mic test. */
const VOICE_INPUT_DEVICE_KEY = "musepi-voice-input-device";

export function getVoiceInputDevice(): string | null {
	try {
		return localStorage.getItem(VOICE_INPUT_DEVICE_KEY);
	} catch {
		return null;
	}
}

export function setVoiceInputDevice(deviceId: string | null): void {
	try {
		if (deviceId) localStorage.setItem(VOICE_INPUT_DEVICE_KEY, deviceId);
		else localStorage.removeItem(VOICE_INPUT_DEVICE_KEY);
	} catch {
		// storage unavailable — the default device stays in use
	}
}

export function startDictationOpts(opts: DictateOptions): (() => void) | null {
	const { rpc, onFinal, onError, onState } = opts;
	if (!rpc) return webSpeechFallback(onFinal, onError, opts.language);

	let cancelled = false;
	let rec: { stop(): void } | null = null;
	const startedAt = Date.now();
	let lastTick = 0;
	// Esc-to-cancel support: the module-level cancelActiveDictation() needs a
	// handle on the live session's flag + recorder.
	const session = {
		cancel(): void {
			cancelled = true;
			rec?.stop();
			activeDictation = null;
			onState?.({ phase: "stopped" });
		},
	};
	activeDictation = session;

	// barge-in：起口述前先 weak 掉 TTS
	if (opts.bargeIn) {
		if (opts.bargeIn === "duck") activeTts?.duck();
		else activeTts?.pause();
	}

	void (async () => {
		// #23 A: `stt.vadEndMs` was a dead setting — every entry point goes
		// through startDictation(), which only ever passed `deviceId`, so
		// recordPcm never saw a positive vadEndMs, the VAD auto-stop never
		// engaged and dictation always rode the full 15 s cap (the 0.4.30
		// changelog only held for callers that already passed a value). Resolve
		// it here — one place, every entry point — unless the caller overrode it.
		let vadEndMs = opts.vadEndMs;
		let configuredLanguage: string | undefined;
		let configuredModel: string | undefined;
		try {
			const v = await rpc.request<Record<string, unknown> | null>("settings.get", {
				keys: ["stt.vadEndMs", "stt.language", "stt.modelName"],
			});
			const parsed = Number(v?.["stt.vadEndMs"]);
			if (Number.isFinite(parsed) && parsed > 0) vadEndMs = parsed;
			const lang = typeof v?.["stt.language"] === "string" ? (v["stt.language"] as string).trim() : "";
			// "auto" (explicit) means let Whisper auto-detect; unset falls back to
			// the UI language. Forcing the old "en" default turned Chinese speech
			// into English mush, and pure auto-detect is unreliable on short
			// non-English utterances — so a zh UI seeds "zh" instead.
			if (lang && lang.toLowerCase() !== "auto") {
				configuredLanguage = lang;
			} else if (!lang && getLocaleSnapshot().toLowerCase().startsWith("zh")) {
				configuredLanguage = "zh";
			}
			configuredModel = typeof v?.["stt.modelName"] === "string" ? (v["stt.modelName"] as string) : undefined;
		} catch {
			// settings unavailable — keep the 15 s cap behaviour
		}
		if (cancelled) return;
		// Preheat: kick the model download/load NOW so it overlaps the
		// recording instead of being billed to the transcribe RPC. The daemon
		// dedupes per key (alreadyRunning) and the worker keeps the model warm,
		// so this is safe to fire on every mic press. modelKey mirrors the
		// daemon's resolveSttModelSpec fallback (settings unset → balanced).
		const preheatKey = configuredModel?.trim() || "balanced";
		void rpc
			.request("stt.modelDownload", { modelKey: preheatKey }, { timeoutMs: PREHEAT_RPC_TIMEOUT_MS })
			.catch(() => {
				/* preheat is best-effort: the transcribe path reports real failures */
			});
		const language = opts.language ?? configuredLanguage;
		// #9: `done` resolves when the recording FINISHES (VAD end / 15s cap /
		// stop button) — the transcribe call below now receives the full
		// buffer, and settings' vadEndMs actually gates the auto-stop.
		const recording = recordPcm({
			maxSeconds: 15,
			deviceId: opts.deviceId,
			vadEndMs,
			isCancelled: () => cancelled,
			onLevel: level => {
				if (cancelled) return;
				const now = Date.now();
				if (now - lastTick < 100) return;
				lastTick = now;
				onState?.({ phase: "recording", seconds: Math.round((now - startedAt) / 1000), level });
			},
		});
		// Register the cancel handle BEFORE awaiting: the composer's stop
		// button must be able to finish the recording while it runs.
		rec = recording;
		const recorded = await recording.done;
		if (cancelled) return;
		if (!recorded) {
			// The composer surfaces this inline (no toast); the Web Speech
			// fallback below still gets a chance to answer the utterance.
			onState?.({ phase: "error", message: friendlyDictationError("microphone unavailable") });
			const stop = webSpeechFallback(onFinal, onError, language);
			if (stop) rec = { stop };
			return;
		}
		onState?.({ phase: "transcribing" });
		try {
			const res = await rpc.request<{ text: string }>(
				"stt.transcribe",
				{
					audio: quantiseForWire(recorded.pcm),
					...(language ? { language } : {}),
				},
				{ timeoutMs: SPEECH_RPC_TIMEOUT_MS },
			);
			if (cancelled) return;
			if (res?.text) onFinal(res.text);
			else {
				const message = friendlyDictationError("empty transcript");
				onError(message);
				onState?.({ phase: "error", message });
			}
		} catch (err) {
			if (cancelled) return;
			const message = friendlyDictationError(err instanceof Error ? err.message : String(err));
			onError(message);
			onState?.({ phase: "error", message });
		}
	})();

	return () => {
		// #23 D: a second mic press used to set `cancelled` before stopping, so
		// the whole buffer was discarded and nothing was transcribed — a user
		// who stopped early lost everything they had said. `stop` already
		// resolves `done` with the full buffer (the #9 contract), so finish
		// early and let it transcribe. Only a stop racing ahead of the
		// recording start has nothing to submit and stays a cancel.
		if (rec) rec.stop();
		else cancelled = true;
	};
}

/* ── 取消当前口述（Esc）──────────────────────────────────────────
 * `stop`（点麦克风 / 再按一次）是"说完提前收工"：保留缓冲并转写。
 * Esc 语义是"丢弃"：置 cancelled 后停麦，转写路径看到 cancelled 直接退出。
 * 模块级单例与 activeTts 同一假设：同一时刻只有一场口述。 */
let activeDictation: { cancel(): void } | null = null;

/** Discard the in-flight dictation (Esc parity). Returns false when idle. */
export function cancelActiveDictation(): boolean {
	if (!activeDictation) return false;
	const session = activeDictation;
	activeDictation = null;
	session.cancel();
	return true;
}

/* ── 错误文案 ───────────────────────────────────────────────────
 * 原始错误串（"request timeout: stt.transcribe"）进全局「工具错误」toast
 * 既吓人又没用：已知失败源翻成可行动的一句话，未知原样透出。 */
function friendlyDictationError(message: string): string {
	const m = message ?? "";
	if (/request timeout|RPC timeout/i.test(m)) return t("voice error timeout");
	if (/empty transcript/i.test(m)) return t("voice error empty");
	if (/microphone|NotAllowedError|PermissionDenied/i.test(m)) return t("voice error mic");
	if (/not connected|connection closed|disconnect/i.test(m)) return t("voice error disconnected");
	return message;
}

/* ── 朗读 ─────────────────────────────────────────────────────── */
/**
 * Daemon-path read-aloud is SENTENCE-STREAMED, not one-shot: the sanitized
 * text is cut into sentence-sized segments (Chinese-aware — full-width 。！？
 * enders abut the next sentence with no whitespace), each segment is
 * synthesized with one `tts.synthesize` RPC, and playback starts the moment
 * the FIRST segment's PCM lands — segment N+1 synthesizes while segment N
 * plays. The old one-shot shape paid the whole-text synthesis cost up front
 * (a 600-char Chinese reply ≈ many seconds of MeloTTS CPU time) before any
 * sound, which was the reported "点击播放到出声很慢".
 *
 * Playback runs on one shared AudioContext: every segment decodes to an
 * AudioBuffer and schedules back-to-back on a single gain node with a tiny
 * click-guard gap (the sentence-final pause already lives inside each
 * segment's audio — MeloTTS renders 。！？ prosody — so no extra silence is
 * inserted). `rate` is a playbackRate on each source; duck lowers the shared
 * gain; barge-in "pause" suspends the context.
 */

/** Guard gap between scheduled segments (seconds); prevents click artifacts. */
const SEGMENT_GAP_SEC = 0.04;
/** Boundaries closer than this to the segment start are skipped (stub merge). */
const SEGMENT_MIN_CHARS = 4;
/** A segment never exceeds this; longer sentences split at clause punctuation. */
const SEGMENT_MAX_CHARS = 180;

/** "https://github.com/foo/bar?x#y" → "github.com" (daemon speakable parity). */
function speakableHost(url: string): string {
	return url
		.replace(/^[a-z][\w+.-]*:\/\//i, "")
		.replace(/^www\./i, "")
		.replace(/[/?#].*$/, "");
}

/** Chinese closing brackets that may trail a sentence ender. */
const ZH_CLOSER_RE = /[」』》”’）]/;
/** ASCII closers that may trail an ASCII sentence ender. */
const ASCII_CLOSER_RE = /[)\]"'»”’]/;
/** Abbreviations whose trailing dot must not end a segment (daemon parity). */
const ABBREVIATION_TAIL_RE = /(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|No)\.$/i;
/** Clause punctuation for the oversize-segment fallback split. */
const CLAUSE_CHAR_RE = /[,，、;；:：]/;

/**
 * Cut sanitized text into synthesis-sized segments. Contract: every sentence
 * ender (full-width 。！？ without whitespace, ASCII .!?… with whitespace or
 * end) stays ATTACHED to its segment — MeloTTS derives the sentence-final
 * pause from that punctuation, so a segment cut before the ender would sound
 * like a comma-stop. Decimals ("3.14"), "…" runs, mid-word dots
 * ("example.com") and abbreviations ("e.g.") never split. Segments longer
 * than {@link SEGMENT_MAX_CHARS} split at the last clause punctuation before
 * the cap. Pure, exported for contract tests.
 */
export function splitSpeakableSentences(text: string): string[] {
	const segments: string[] = [];
	const n = text.length;
	let start = 0;
	let i = 0;
	while (i < n) {
		const ch = text[i]!;
		let end = -1;
		if (ch === "。" || ch === "！" || ch === "？") {
			// Full-width enders abut the next sentence — no whitespace needed.
			end = i + 1;
			while (end < n && ZH_CLOSER_RE.test(text[end]!)) end += 1;
		} else if (ch === "." || ch === "!" || ch === "?") {
			// ASCII enders require trailing whitespace (or end of text) so
			// decimals and mid-word dots do not split; "…"/"..." runs only
			// end at their last dot.
			const prev = i > 0 ? text[i - 1]! : "";
			const next = i + 1 < n ? text[i + 1]! : "";
			if (ch !== "." || !/\d/.test(prev) || !/\d/.test(next)) {
				const head = text.slice(start, i + 1);
				let e = i + 1;
				while (e < n && ASCII_CLOSER_RE.test(text[e]!)) e += 1;
				if (!ABBREVIATION_TAIL_RE.test(head) && (e >= n || /\s/.test(text[e]!))) end = e;
			}
		} else if (ch === "…") {
			// An ellipsis run only ends a segment at end-of-text or before
			// whitespace ("他说……然后走了" keeps the sentence whole).
			let e = i + 1;
			while (e < n && text[e] === "…") e += 1;
			if (e >= n || /\s/.test(text[e]!)) end = e;
		}
		if (end !== -1 && end - start >= SEGMENT_MIN_CHARS) {
			segments.push(text.slice(start, end));
			start = end;
			i = end;
			continue;
		}
		i += 1;
	}
	if (start < n) segments.push(text.slice(start));
	// Oversize fallback: split at the last clause punctuation before the cap.
	const out: string[] = [];
	for (const segment of segments) {
		let rest = segment.trim();
		while (rest.length > SEGMENT_MAX_CHARS) {
			const window = rest.slice(0, SEGMENT_MAX_CHARS + 1);
			let cut = -1;
			for (let j = window.length - 1; j > 0; j--) {
				if (CLAUSE_CHAR_RE.test(window[j]!)) {
					cut = j + 1;
					break;
				}
			}
			if (cut <= 0) cut = SEGMENT_MAX_CHARS;
			out.push(rest.slice(0, cut).trimEnd());
			rest = rest.slice(cut).trimStart();
		}
		if (rest) out.push(rest);
	}
	return out.filter(segment => /[\p{L}\p{N}]/u.test(segment));
}

/** Shared playback graph — one AudioContext for the app's whole read-aloud. */
let speakCtx: AudioContext | null = null;
let speakGain: GainNode | null = null;

function speakGraph(): { ctx: AudioContext; gain: GainNode } {
	if (!speakCtx || !speakGain) {
		speakCtx = new AudioContext();
		speakGain = speakCtx.createGain();
		speakGain.connect(speakCtx.destination);
	}
	return { ctx: speakCtx, gain: speakGain };
}

/** Map a synthesis failure onto an actionable, localized one-liner. */
function friendlySpeakError(raw: string | undefined): string {
	const message = raw ?? "";
	if (/request timeout|RPC timeout/i.test(message)) return t("voice error timeout");
	if (!message) return t("voice error tts synthesis");
	// Worker text is already actionable ("Failed to download model.onnx …");
	// pass it through so e.g. a missing model names the real failure.
	return message;
}

export function speak(
	text: string,
	rpc: RpcClient | null,
	options?: SpeakOptions,
	onState?: (activity: VoiceActivity) => void,
): () => void {
	const clean = sanitizeForSpeech(text, options?.mode ?? "sanitize");
	if (rpc) {
		const segments = splitSpeakableSentences(clean);
		if (segments.length === 0) {
			onState?.({ phase: "error", message: t("voice error tts empty") });
			return () => {};
		}
		let stopped = false;
		let graph: { ctx: AudioContext; gain: GainNode } | null = null;
		let cursor = 0;
		const liveSources = new Set<AudioBufferSourceNode>();
		const synthesize = (index: number): Promise<{ audio: number[] | null; sampleRate: number; error?: string }> =>
			rpc
				.request<{ audio: number[] | null; sampleRate: number; error?: string }>(
					"tts.synthesize",
					{
						text: segments[index],
						...(options?.voice ? { voice: options.voice } : {}),
					},
					// First use warms the model inside the call — same class as stt.transcribe.
					{ timeoutMs: SPEECH_RPC_TIMEOUT_MS },
				)
				.catch((err: unknown) => ({
					audio: null,
					sampleRate: 0,
					error: err instanceof Error ? err.message : String(err),
				}));
		void (async (): Promise<void> => {
			try {
				let pending = synthesize(0);
				for (let i = 0; i < segments.length; i += 1) {
					const res = await pending;
					if (stopped) return;
					if (!res?.audio || res.audio.length === 0) {
						onState?.({ phase: "error", message: friendlySpeakError(res?.error) });
						return;
					}
					// Segment N+1 synthesizes while segment N plays.
					if (i + 1 < segments.length) pending = synthesize(i + 1);
					if (!graph) {
						graph = speakGraph();
						cursor = graph.ctx.currentTime;
						void graph.ctx.resume().catch(() => {});
						onState?.({ phase: "speaking" });
						activeTts = {
							duck: () => {
								if (speakGain) speakGain.gain.value = 0.25;
							},
							pause: () => {
								void speakCtx?.suspend().catch(() => {});
							},
							resume: () => {
								if (speakGain) speakGain.gain.value = 1;
								void speakCtx?.resume().catch(() => {});
							},
						};
					}
					const wav = pcmToWav(res.audio, res.sampleRate || 24_000);
					const buffer = await graph.ctx.decodeAudioData(wav.buffer as ArrayBuffer);
					if (stopped) return;
					const source = graph.ctx.createBufferSource();
					source.buffer = buffer;
					const rate = options?.rate && options.rate > 0 ? options.rate : 1;
					if (rate !== 1) source.playbackRate.value = rate;
					source.connect(graph.gain);
					source.onended = () => liveSources.delete(source);
					liveSources.add(source);
					const startAt = Math.max(cursor, graph.ctx.currentTime + SEGMENT_GAP_SEC);
					source.start(startAt);
					cursor = startAt + buffer.duration / rate;
				}
				// Drain: wait until the last scheduled sample has played out.
				// `graph` is non-null whenever a segment played (segments.length
				// > 0 guarantees at least one loop iteration).
				const played = graph;
				if (played) {
					const drainMs = Math.max(0, (cursor - played.ctx.currentTime) * 1000) + 80;
					await new Promise<void>(resolve => setTimeout(resolve, drainMs));
				}
				if (!stopped) {
					activeTts = null;
					onState?.({ phase: "done" });
				}
			} catch (err) {
				if (!stopped) {
					activeTts = null;
					onState?.({
						phase: "error",
						message: friendlySpeakError(err instanceof Error ? err.message : String(err)),
					});
				}
			}
		})();
		return () => {
			stopped = true;
			for (const source of liveSources) {
				try {
					source.stop();
				} catch {
					// Already ended.
				}
			}
			liveSources.clear();
			activeTts = null;
			onState?.({ phase: "stopped" });
		};
	}
	try {
		const u = new SpeechSynthesisUtterance(clean);
		u.lang = (options?.voice ?? "").startsWith("am") || (options?.voice ?? "").startsWith("bm") ? "en-US" : "en-US";
		if (options?.rate) u.rate = options.rate;
		u.onend = () => onState?.({ phase: "done" });
		u.onerror = () => onState?.({ phase: "error", message: "speech synthesis failed" });
		speechSynthesis.cancel();
		onState?.({ phase: "speaking" });
		speechSynthesis.speak(u);
		return () => {
			speechSynthesis.cancel();
			onState?.({ phase: "stopped" });
		};
	} catch (err) {
		onState?.({ phase: "error", message: String(err) });
		return () => {};
	}
}

export function voiceAvailable(): boolean {
	const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
	return !!w.SpeechRecognition || !!w.webkitSpeechRecognition || typeof speechSynthesis !== "undefined";
}

export function stopAllTtsAndResume(): void {
	activeTts?.resume();
	activeTts = null;
}

/* ── 口述提交判定（TUI stt.submitTrigger parity）────────────────
 * Renderer-side copy of packages/coding-agent/src/stt/submit-trigger.ts —
 * the GUI cannot import from @musepi/coding-agent (no dependency edge),
 * so keep this in lockstep with the daemon original when changing it. */
export const STT_SUBMIT_TRIGGERS = ["never", "release", "release-complete", "say-submit"] as const;
export type SttSubmitTrigger = (typeof STT_SUBMIT_TRIGGERS)[number];

export function evaluateSubmitTrigger(
	utterance: string,
	trigger: SttSubmitTrigger,
): { submit: boolean; trimTrailing: number } {
	const trimmed = utterance.trim();
	if (!trimmed || trigger === "never") return { submit: false, trimTrailing: 0 };
	if (trigger === "release") {
		return { submit: trimmed.split(/\s+/).filter(Boolean).length >= 2, trimTrailing: 0 };
	}
	if (trigger === "release-complete") {
		return { submit: /[.?!…。？！]\s*$/.test(trimmed), trimTrailing: 0 };
	}
	// say-submit: a trailing word containing "submit" is stripped before sending.
	const match = utterance.match(/(?:^|\s+)(\S*submit\S*)[.?!…。？！]*\s*$/i);
	if (match && match.index !== undefined) {
		return { submit: true, trimTrailing: utterance.length - match.index };
	}
	return { submit: false, trimTrailing: 0 };
}

/* ── 净化（朗读前的 markdown → 自然语言文本） ─────────────────────
 * 行级结构逐行处理（标题/列表/引用/表格分隔行/分隔线），行内结构正则
 * 替换（链接读 label、URL 读域名、行内代码去反引号留内容、强调记号
 * 成对剥掉——snake_case 的中间下划线不再被误删）。代码块整体替换为
 * 本地化占位词（"代码块"），与 daemon speakable 流的"跳过代码"语义
 * 对齐但保留一个口语路标，听者不会困惑句子为什么跳了一段。 */

/**
 * Prepare assistant markdown for speech. `sanitize` strips markdown structure
 * (headings, list markers, blockquotes, tables, emphasis) and rewrites code
 * and links into spoken form; `raw` keeps the text but still replaces fenced
 * code with the placeholder; `summarize` keeps the first two sentences
 * (Chinese enders included). Pure, exported for contract tests.
 */
export function sanitizeForSpeech(text: string, mode: "raw" | "sanitize" | "summarize"): string {
	const codeBlock = t("speech placeholder code block");
	let s = text.replace(/```[\s\S]*?(?:```|$)/g, ` ${codeBlock} `).replace(/~~~[\s\S]*?(?:~~~|$)/g, ` ${codeBlock} `);
	if (mode === "raw") return s.replace(/\s+/g, " ").trim().slice(0, 600);
	s = s
		.split("\n")
		.map(line => {
			// Table separator rows and horizontal rules carry no spoken content.
			if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("|")) return " ";
			if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return " ";
			let l = line;
			l = l.replace(/^\s{0,3}#{1,6}\s+/, ""); // heading marker
			l = l.replace(/^\s*>\s?/, ""); // blockquote marker
			l = l.replace(/^\s*[-*+]\s+/, ""); // bullet marker
			l = l.replace(/^\s*(\d{1,3})[.)]\s+/, "$1, "); // numbered: "1. " → "1, "
			if (/^\s*\|/.test(l)) {
				// Table row: read the cells, joined (separator rows dropped above).
				const cells = l
					.split("|")
					.map(cell => cell.trim())
					.filter(Boolean);
				return cells.join("，");
			}
			return l;
		})
		.join("\n")
		.replace(/!\[([^\]]*)\]\([^()]*\)/g, "$1") // image → its alt
		.replace(/\[([^\]]+)\]\([^()]*\)/g, "$1") // link → its label
		.replace(/<((?:https?:\/\/|www\.)[^\s>。！？，、；：]+)>/g, (_match, url: string) => speakableHost(url))
		.replace(
			/\bhttps?:\/\/[^\s<>()"'\]。！？，、；：]+|\bwww\.[\w-]+(?:\.[\w-]+)+[^\s<>()"'\]。！？，、；：]*/g,
			match => speakableHost(match),
		)
		.replace(/`+([^`]+)`+/g, "$1") // inline code: keep the identifier, drop ticks
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/<\/?[a-zA-Z][^<>]*>/g, " ") // HTML tags
		.replace(/(^|[\s("'`])((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+){2,}\/?)/g, (_m, lead: string, p: string) => {
			// "packages/coding-agent/src/tts/vocalizer.ts" → "vocalizer.ts"
			const parts = p.split("/").filter(part => part.length > 0);
			return lead + (parts[parts.length - 1] ?? p);
		})
		// Stray markdown residue never carries meaning in prose (unlike _, #, []).
		.replace(/[*~|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (mode === "summarize") {
		// 轻量蒸馏：保留前两句（中英文句末都算）
		const sentences = s.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [s];
		s = sentences.slice(0, 2).join("") + (sentences.length > 2 ? "…" : "");
	}
	return s.slice(0, 600);
}

/* ── Web Speech 兜底 ──────────────────────────────────────────── */
interface SpeechRecognitionLike {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((e: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
	onerror: ((e: { error?: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
type SRCtor = new () => SpeechRecognitionLike;
function recognitionCtor(): SRCtor | null {
	const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
function webSpeechFallback(
	onFinal: (text: string) => void,
	onError: (m: string) => void,
	lang?: string,
): (() => void) | null {
	const Ctor = recognitionCtor();
	if (!Ctor) {
		onError("speech recognition unavailable");
		return null;
	}
	const rec = new Ctor();
	rec.lang = lang ?? (navigator.language.startsWith("zh") ? "zh-CN" : "en-US");
	rec.continuous = false;
	rec.interimResults = false;
	rec.onresult = e => {
		const last = e.results[e.results.length - 1];
		if (last?.[0]?.transcript) onFinal(last[0].transcript);
	};
	rec.onerror = e => onError(e.error ?? "speech error");
	try {
		rec.start();
	} catch {
		onError("could not start recognition");
		return null;
	}
	return () => {
		try {
			rec.stop();
		} catch {
			/* already stopped */
		}
	};
}

/* ── PCM → WAV ────────────────────────────────────────────────── */
function pcmToWav(pcm: number[], sampleRate: number): Uint8Array {
	const n = pcm.length;
	const buf = new ArrayBuffer(44 + n * 2);
	const view = new DataView(buf);
	const ws = (o: number, s: string): void => {
		for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
	};
	ws(0, "RIFF");
	view.setUint32(4, 36 + n * 2, true);
	ws(8, "WAVE");
	ws(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ws(36, "data");
	view.setUint32(40, n * 2, true);
	let off = 44;
	for (let i = 0; i < n; i++) {
		const s = Math.max(-1, Math.min(1, pcm[i]));
		view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		off += 2;
	}
	return new Uint8Array(buf);
}
