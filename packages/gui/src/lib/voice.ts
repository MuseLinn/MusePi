/**
 * Voice I/O (TUI parity): the daemon's stt/tts RPCs reuse the exact local
 * workers the TUI uses (sherpa-ONNX ASR + Kokoro-82M TTS) — no Google web
 * service dependency. The renderer records 16 kHz mono PCM, sends it to
 * `stt.transcribe`, and plays `tts.synthesize` PCM back. Web Speech APIs
 * remain as offline-unavailable fallbacks.
 */
import type { RpcClient } from "./rpc";

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

/** Record ~N seconds of 16 kHz mono float PCM via getUserMedia. */
async function recordPcm(
	maxSeconds = 15,
	onLevel?: (rms: number) => void,
): Promise<{ pcm: Float32Array; stop(): void } | null> {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const ctx = new AudioContext();
		const source = ctx.createMediaStreamSource(stream);
		const node = ctx.createScriptProcessor(4096, 1, 1);
		const chunks: Float32Array[] = [];
		let stopped = false;
		const stop = (): void => {
			if (stopped) return;
			stopped = true;
			node.disconnect();
			source.disconnect();
			stream.getTracks().forEach(t => {
				t.stop();
			});
			void ctx.close();
		};
		node.onaudioprocess = e => {
			if (stopped) return;
			const data = e.inputBuffer.getChannelData(0);
			chunks.push(new Float32Array(data));
			// 实时音量(RMS,0..1)供录音视觉反馈
			if (onLevel) {
				let sum = 0;
				for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
				onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
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
				for (const c of chunks) {
					out.set(c, off);
					off += c.length;
				}
				return out;
			})(),
			stop,
		};
	} catch {
		return null;
	}
}

function webSpeechFallback(onFinal: (text: string) => void, onError: (m: string) => void): (() => void) | null {
	const Ctor = recognitionCtor();
	if (!Ctor) {
		onError("speech recognition unavailable");
		return null;
	}
	const rec = new Ctor();
	rec.lang = navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
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
			// already stopped
		}
	};
}

/** 语音 I/O 状态(UI 视觉反馈;openchamber Voice Mode parity)。 */
export type VoiceActivity =
	| { phase: "recording"; seconds: number; level: number }
	| { phase: "transcribing" }
	| { phase: "speaking" }
	| { phase: "done" }
	| { phase: "stopped" }
	| { phase: "error"; message: string };

/** Dictate: records then transcribes via the daemon (TUI-parity local
 *  worker); falls back to Web Speech when the daemon/RPC is unavailable.
 *  onState 每 ~100ms 推送录音活动(秒数 + 音量),UI 据此渲染录音反馈。 */
export function startDictation(
	onFinal: (text: string) => void,
	onError: (message: string) => void,
	rpc: RpcClient | null,
	onState?: (activity: VoiceActivity) => void,
): (() => void) | null {
	if (!rpc) return webSpeechFallback(onFinal, onError);
	let cancelled = false;
	let rec: { stop(): void } | null = null;
	const startedAt = Date.now();
	let lastTick = 0;
	void (async () => {
		const recorded = await recordPcm(15, level => {
			if (cancelled) return;
			// 节流到 ~100ms,报秒数 + 音量
			const now = Date.now();
			if (now - lastTick < 100) return;
			lastTick = now;
			onState?.({ phase: "recording", seconds: Math.round((now - startedAt) / 1000), level });
		});
		if (!recorded) {
			// Mic blocked — try Web Speech as a last resort.
			onState?.({ phase: "error", message: "microphone unavailable" });
			const stop = webSpeechFallback(onFinal, onError);
			if (stop) rec = { stop };
			return;
		}
		rec = recorded;
		if (cancelled) {
			recorded.stop();
			return;
		}
		onState?.({ phase: "transcribing" });
		try {
			const res = await rpc.request<{ text: string }>("stt.transcribe", {
				audio: Array.from(recorded.pcm),
			});
			if (cancelled) return;
			if (res?.text) onFinal(res.text);
			else onError("empty transcript");
		} catch (err) {
			if (cancelled) return;
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			recorded.stop();
		}
	})();
	return () => {
		cancelled = true;
		rec?.stop();
	};
}

/** Speak via the daemon's Kokoro TTS; falls back to speechSynthesis.
 *  onState 报告 speaking/done/stopped/error,供 read-aloud 播放状态反馈。 */
export function speak(text: string, rpc: RpcClient | null, onState?: (activity: VoiceActivity) => void): () => void {
	const clean = text.replace(/```[\s\S]*?```/g, " code block ").slice(0, 600);
	if (rpc) {
		let audio: HTMLAudioElement | null = null;
		let stopped = false;
		void rpc
			.request<{ audio: number[] | null; sampleRate: number }>("tts.synthesize", { text: clean })
			.then(res => {
				if (stopped || !res?.audio || res.audio.length === 0) return;
				const wav = pcmToWav(res.audio, res.sampleRate || 24000);
				audio = new Audio(URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" })));
				audio.onended = () => onState?.({ phase: "done" });
				audio.onerror = () => onState?.({ phase: "error", message: "tts playback failed" });
				onState?.({ phase: "speaking" });
				audio.play().catch(() => onState?.({ phase: "error", message: "tts playback failed" }));
			})
			.catch(err => onState?.({ phase: "error", message: err instanceof Error ? err.message : String(err) }));
		return () => {
			stopped = true;
			audio?.pause();
			onState?.({ phase: "stopped" });
		};
	}
	try {
		const u = new SpeechSynthesisUtterance(clean);
		u.lang = navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
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
	return !!recognitionCtor() || typeof speechSynthesis !== "undefined";
}

/** Float32 PCM → 16-bit WAV bytes. */
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
