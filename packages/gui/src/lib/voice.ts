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
	/** VAD 静音判停（毫秒）；缺省则用 15s 上限 */
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
export interface MicDevice { deviceId: string; label: string; kind: string }
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
async function recordPcm(
	opts: { maxSeconds?: number; deviceId?: string; vadEndMs?: number; onLevel?: (rms: number) => void },
): Promise<{ pcm: Float32Array; stop(): void } | null> {
	const maxSeconds = opts.maxSeconds ?? 15;
	const vadEndMs = opts.vadEndMs ?? 0;
	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: opts.deviceId ? { deviceId: { exact: opts.deviceId } } : true,
		});
		const ctx = new AudioContext();
		const source = ctx.createMediaStreamSource(stream);
		const node = ctx.createScriptProcessor(4096, 1, 1);
		const chunks: Float32Array[] = [];
		let stopped = false;
		// VAD：自适应噪声底 + 静音计数器
		let noiseFloor = 0.02;
		let silenceMs = 0;
		let lastVoiceAt = Date.now();

		const stop = (): void => {
			if (stopped) return;
			stopped = true;
			node.disconnect(); source.disconnect();
			stream.getTracks().forEach(t => t.stop());
			void ctx.close();
		};

		node.onaudioprocess = e => {
			if (stopped) return;
			const data = e.inputBuffer.getChannelData(0);
			chunks.push(new Float32Array(data));
			let sum = 0;
			for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
			const rms = Math.min(1, Math.sqrt(sum / data.length) * 4);
			if (opts.onLevel) opts.onLevel(rms);
			if (vadEndMs > 0) {
				// 短时能量低 → 视为静音；累计超过 vadEndMs 则自动结束
				if (rms < noiseFloor * 1.15) {
					silenceMs += (data.length / ctx.sampleRate) * 1000;
					if (silenceMs >= vadEndMs && Date.now() - lastVoiceAt >= 300) { stop(); return; }
				} else {
					silenceMs = 0; lastVoiceAt = Date.now();
					// 缓慢抬升噪声底（背景缓慢变吵）
					noiseFloor = Math.max(0.01, Math.min(0.3, noiseFloor * 0.999 + rms * 0.001));
				}
			}
		};
		source.connect(node);
		node.connect(ctx.destination);
		setTimeout(stop, maxSeconds * 1000);
		return {
			pcm: (() => {
				const total = chunks.reduce((n, c) => n + c.length, 0);
				const out = new Float32Array(total);
				let off = 0;
				for (const c of chunks) { out.set(c, off); off += c.length; }
				return out;
			})(),
			stop,
		};
	} catch {
		return null;
	}
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
	return startDictationOpts({ rpc, onFinal, onError, onState });
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
		const recorded = await recordPcm({
			maxSeconds: 15,
			deviceId: opts.deviceId,
			vadEndMs: opts.vadEndMs,
			onLevel: level => {
				if (cancelled) return;
				const now = Date.now();
				if (now - lastTick < 100) return;
				lastTick = now;
				onState?.({ phase: "recording", seconds: Math.round((now - startedAt) / 1000), level });
			},
		});
		if (!recorded) {
			onState?.({ phase: "error", message: "microphone unavailable" });
			const stop = webSpeechFallback(onFinal, onError, opts.language);
			if (stop) rec = { stop };
			return;
		}
		rec = recorded;
		if (cancelled) { recorded.stop(); return; }
		onState?.({ phase: "transcribing" });
		try {
			const res = await rpc.request<{ text: string }>("stt.transcribe", {
				audio: Array.from(recorded.pcm),
				...(opts.language ? { language: opts.language } : {}),
			});
			if (cancelled) return;
			if (res?.text) onFinal(res.text); else onError("empty transcript");
		} catch (err) {
			if (cancelled) return;
			onError(err instanceof Error ? err.message : String(err));
			onState?.({ phase: "error", message: err instanceof Error ? err.message : String(err) });
		} finally {
			recorded.stop();
		}
	})();

	return () => {
		cancelled = true;
		rec?.stop();
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
				...(options?.rate ? { rate: options.rate } : {}),
			})
			.then(res => {
				if (stopped || !res?.audio || res.audio.length === 0) return;
				const wav = pcmToWav(res.audio, res.sampleRate || 24000);
				audio = new Audio(URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" })));
				audio.volume = 1;
				audio.onended = () => { onState?.({ phase: "done" }); activeTts = null; };
				audio.onerror = () => onState?.({ phase: "error", message: "tts playback failed" });
				onState?.({ phase: "speaking" });
				audio.play().catch(() => onState?.({ phase: "error", message: "tts playback failed" }));
				activeTts = {
					duck: () => { if (audio) audio.volume = 0.25; },
					pause: () => audio?.pause(),
					resume: () => { if (audio) { audio.volume = 1; void audio.play().catch(() => {}); } },
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
		u.lang = (options?.voice ?? "").startsWith("am") || (options?.voice ?? "").startsWith("bm")
			? "en-US" : "en-US";
		if (options?.rate) u.rate = options.rate;
		u.onend = () => onState?.({ phase: "done" });
		u.onerror = () => onState?.({ phase: "error", message: "speech synthesis failed" });
		speechSynthesis.cancel();
		onState?.({ phase: "speaking" });
		speechSynthesis.speak(u);
		return () => { speechSynthesis.cancel(); onState?.({ phase: "stopped" }); };
	} catch (err) {
		onState?.({ phase: "error", message: String(err) });
		return () => {};
	}
}

export function voiceAvailable(): boolean {
	const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
	return !!w.SpeechRecognition || !!w.webkitSpeechRecognition || typeof speechSynthesis !== "undefined";
}

export function stopAllTtsAndResume(): void { activeTts?.resume(); activeTts = null; }

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
	if (!Ctor) { onError("speech recognition unavailable"); return null; }
	const rec = new Ctor();
	rec.lang = lang ?? (navigator.language.startsWith("zh") ? "zh-CN" : "en-US");
	rec.continuous = false;
	rec.interimResults = false;
	rec.onresult = e => { const last = e.results[e.results.length - 1]; if (last?.[0]?.transcript) onFinal(last[0].transcript); };
	rec.onerror = e => onError(e.error ?? "speech error");
	try { rec.start(); } catch { onError("could not start recognition"); return null; }
	return () => { try { rec.stop(); } catch { /* already stopped */ } };
}

/* ── PCM → WAV ────────────────────────────────────────────────── */
function pcmToWav(pcm: number[], sampleRate: number): Uint8Array {
	const n = pcm.length;
	const buf = new ArrayBuffer(44 + n * 2);
	const view = new DataView(buf);
	const ws = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
	ws(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); ws(8, "WAVE");
	ws(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
	ws(36, "data"); view.setUint32(40, n * 2, true);
	let off = 44;
	for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
	return new Uint8Array(buf);
}
