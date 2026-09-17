/*
 * Voice I/O: local STT/TTS via the daemon (sherpa-ONNX ASR + Kokoro TTS).
 * Extends the inherited exports (startDictation / speak / voiceAvailable /
 * VoiceActivity) with startDictationOpts (VAD auto-stop + device + language),
 * speak voice/rate options, enumerateMicDevices, and barge-in (duck/pause).
 */
import type { RpcClient } from "./rpc";

/* ── 类型（沿用） ─────────────────────────────────────────────── */

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
// transcript, and a 15 s buffer blew the daemon's 4 MiB request cap. Capture
// at 16 kHz like guest-client does, resample when the engine ignores the
// request, and quantise the payload so it always fits the wire limit.

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

/** Wire-size guard for #23 C: `stt.transcribe` takes float JSON, and the daemon
 *  rejects requests over 4 MiB. A 15 s buffer at 16 kHz is ~240 k samples, which
 *  fits only if each sample prints short — 5 decimals keeps ~13 bits of
 *  mantissa (well inside what 16-bit ASR audio carries) at ~8 bytes/sample. */
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
		if (vadEndMs === undefined) {
			try {
				const v = await rpc.request<Record<string, unknown> | null>("settings.get", {
					keys: ["stt.vadEndMs"],
				});
				const parsed = Number(v?.["stt.vadEndMs"]);
				if (Number.isFinite(parsed) && parsed > 0) vadEndMs = parsed;
			} catch {
				// settings unavailable — keep the 15 s cap behaviour
			}
		}
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
		if (!recorded) {
			onState?.({ phase: "error", message: "microphone unavailable" });
			const stop = webSpeechFallback(onFinal, onError, opts.language);
			if (stop) rec = { stop };
			return;
		}
		if (cancelled) return;
		onState?.({ phase: "transcribing" });
		try {
			const res = await rpc.request<{ text: string }>("stt.transcribe", {
				audio: quantiseForWire(recorded.pcm),
				...(opts.language ? { language: opts.language } : {}),
			});
			if (cancelled) return;
			if (res?.text) onFinal(res.text);
			else onError("empty transcript");
		} catch (err) {
			if (cancelled) return;
			onError(err instanceof Error ? err.message : String(err));
			onState?.({ phase: "error", message: err instanceof Error ? err.message : String(err) });
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

/* ── 朗读 ─────────────────────────────────────────────────────── */
export function speak(
	text: string,
	rpc: RpcClient | null,
	options?: SpeakOptions,
	onState?: (activity: VoiceActivity) => void,
): () => void {
	const clean = sanitize(text, options?.mode ?? "sanitize");
	if (rpc) {
		let audio: HTMLAudioElement | null = null;
		let stopped = false;
		void rpc
			.request<{ audio: number[] | null; sampleRate: number }>("tts.synthesize", {
				text: clean,
				...(options?.voice ? { voice: options.voice } : {}),
			})
			.then(res => {
				if (stopped || !res?.audio || res.audio.length === 0) return;
				const wav = pcmToWav(res.audio, res.sampleRate || 24000);
				audio = new Audio(URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" })));
				audio.volume = 1;
				// Rate is a playback-side concern: HTMLMediaElement time-stretches
				// with pitch preservation (Chromium), so the daemon's Kokoro PCM
				// needs no resampling — the slider just works.
				if (options?.rate) {
					audio.playbackRate = options.rate;
					audio.preservesPitch = true;
				}
				audio.onended = () => {
					onState?.({ phase: "done" });
					activeTts = null;
				};
				audio.onerror = () => onState?.({ phase: "error", message: "tts playback failed" });
				onState?.({ phase: "speaking" });
				audio.play().catch(() => onState?.({ phase: "error", message: "tts playback failed" }));
				activeTts = {
					duck: () => {
						if (audio) audio.volume = 0.25;
					},
					pause: () => audio?.pause(),
					resume: () => {
						if (audio) {
							audio.volume = 1;
							void audio.play().catch(() => {});
						}
					},
				};
			})
			.catch(err => onState?.({ phase: "error", message: err instanceof Error ? err.message : String(err) }));
		return () => {
			stopped = true;
			audio?.pause();
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

/* ── 净化/摘要（OpenChamber 模式；摘要走 tts 净化的稳定子集） ─────── */
function sanitize(text: string, mode: "raw" | "sanitize" | "summarize"): string {
	let s = text
		.replace(/```[\s\S]*?```/g, " code block ")
		.replace(/`[^`]+`/g, " code ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "a link")
		.replace(/(?:[A-Za-z]:)?\/[\w./-]+/g, "path")
		.replace(/[*_#{}>~|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (mode === "raw") return text.replace(/```[\s\S]*?```/g, " code block ").slice(0, 600);
	if (mode === "summarize") {
		// 摘要：保留首句 + 关键句的轻量蒸馏（真实实现走 daemon summarizeText）
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
