/**
 * Device-native speech via the Web Speech API (openchamber
 * `browserVoiceService` parity, trimmed to the guest client's push-to-talk +
 * read-aloud shape). The webview exposes the same system engines the mobile
 * OS ships — no daemon, no model download — which makes this the natural
 * fallback for collab-direct hosts that have no `stt.*` / `tts.*` RPCs.
 *
 * Behavior notes (from the openchamber implementation):
 * - `webkitSpeechRecognition` is the prefixed constructor on iOS Safari /
 *   WKWebView; Android Chromium exposes the standard one.
 * - Recognition is autonomous: it ends on silence and delivers its final
 *   result through `onresult` just before `onend`. A manual stop only asks
 *   it to finish — the transcript still arrives through the same callbacks,
 *   so the composer maps "stop → transcribing → text" onto the same UI
 *   states the daemon path uses.
 * - `speechSynthesis` needs a prior user gesture on iOS; when a speak is
 *   blocked we surface `not-allowed` and let the caller show the guide
 *   instead of looping on a dead engine.
 */

export interface NativeVoiceSupport {
	recognition: boolean;
	synthesis: boolean;
}

/** Feature-detect the two Web Speech halves (SSR-safe). */
export function nativeVoiceSupport(): NativeVoiceSupport {
	if (typeof window === "undefined") return { recognition: false, synthesis: false };
	const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
	return {
		recognition: Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition),
		synthesis: typeof window.speechSynthesis !== "undefined",
	};
}

interface SpeechRecognitionAlternativeLike {
	transcript: string;
}
interface SpeechRecognitionResultLike {
	isFinal: boolean;
	0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
	resultIndex: number;
	results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((e: SpeechRecognitionEventLike) => void) | null;
	onerror: ((e: { error?: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
type NativeRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): NativeRecognitionCtor | null {
	if (typeof window === "undefined") return null;
	const w = window as unknown as {
		SpeechRecognition?: NativeRecognitionCtor;
		webkitSpeechRecognition?: NativeRecognitionCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Map Web Speech error codes to readable one-liners (openchamber mapping). */
function recognitionError(code: string | undefined): string {
	switch (code) {
		case "no-speech":
			return "no speech detected";
		case "audio-capture":
			return "microphone unavailable";
		case "not-allowed":
			return "microphone permission denied";
		case "service-not-allowed":
			return "speech service unavailable";
		case "network":
			return "speech service network error";
		case "language-not-supported":
			return "language not supported";
		default:
			return `speech error: ${code ?? "unknown"}`;
	}
}

/** A live native recognition. `stop()` finishes and delivers the result;
 *  `abort()` discards it silently. */
export interface NativeRecognition {
	stop(): void;
	abort(): void;
}

export interface NativeRecognitionOptions {
	/** BCP 47 tag; defaults to the webview locale (zh → zh-CN). */
	lang?: string;
	onFinal(text: string): void;
	onError(message: string): void;
}

/** Start a push-to-talk recognition (non-continuous, interim ignored). */
export function startNativeRecognition(opts: NativeRecognitionOptions): NativeRecognition | null {
	const Ctor = recognitionCtor();
	if (!Ctor) return null;
	const rec = new Ctor();
	rec.lang =
		opts.lang ??
		(typeof navigator !== "undefined" && navigator.language?.startsWith("zh")
			? "zh-CN"
			: (navigator?.language ?? "en-US"));
	rec.continuous = false;
	rec.interimResults = false;

	let finalText = "";
	let aborted = false;

	rec.onresult = (e: SpeechRecognitionEventLike) => {
		for (let i = e.resultIndex; i < e.results.length; i++) {
			const result = e.results[i];
			if (result?.isFinal) finalText += result[0].transcript;
		}
	};
	rec.onerror = (e: { error?: string }) => {
		if (aborted || e.error === "aborted") return;
		// A natural end without speech reports "no-speech" then `onend`; let
		// onend decide (final text may still have landed) to avoid double
		// callbacks.
		if (e.error !== "no-speech") opts.onError(recognitionError(e.error));
	};
	rec.onend = () => {
		if (aborted) return;
		const text = finalText.trim();
		if (text) {
			opts.onFinal(text);
		} else {
			opts.onError("no speech detected");
		}
	};

	try {
		rec.start();
	} catch {
		return null;
	}
	return {
		stop(): void {
			// Async finish: the final result arrives via onresult just before
			// onend, which reports the transcript (or the no-speech error).
			try {
				rec.stop();
			} catch {
				// already stopped — onend still fires
			}
		},
		abort(): void {
			aborted = true;
			try {
				rec.abort();
			} catch {
				// already stopped
			}
		},
	};
}

// ── TTS ──────────────────────────────────────────────────────────────────────

function pickVoice(lang: string): SpeechSynthesisVoice | null {
	const voices = window.speechSynthesis.getVoices();
	if (voices.length === 0) return null;
	const base = lang.split("-")[0];
	return (
		voices.find(v => v.lang === lang) ??
		voices.find(v => v.lang.startsWith(base) && v.localService) ??
		voices.find(v => v.lang.startsWith(base)) ??
		voices.find(v => v.localService) ??
		null
	);
}

export interface NativeSpeakOptions {
	/** BCP 47 tag; defaults to the webview locale (zh → zh-CN). */
	lang?: string;
	/** System voice name (openchamber `voiceName` parity); falls back to a
	 *  language match when the name isn't installed. */
	voiceName?: string;
	/** 0.5–2.0, maps to `SpeechSynthesisUtterance.rate`. */
	rate?: number;
}

export interface NativeSpeakHandlers {
	onEnd?(): void;
	onError?(message: string): void;
}

/** Speak text through the system speech synthesis. Returns a stop function. */
export function speakNative(
	text: string,
	opts: NativeSpeakOptions = {},
	handlers: NativeSpeakHandlers = {},
): () => void {
	const onEnd = handlers.onEnd;
	const onError = handlers.onError;
	if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") {
		onError?.("speech synthesis unavailable");
		return () => {};
	}
	const lang =
		opts.lang ??
		(typeof navigator !== "undefined" && navigator.language?.startsWith("zh")
			? "zh-CN"
			: (navigator?.language ?? "en-US"));
	try {
		// Chrome loads voices lazily; cancel any in-flight utterance first so
		// a rapid speak-over never queues behind the old one.
		window.speechSynthesis.cancel();
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = lang;
		if (opts.rate && opts.rate !== 1) utterance.rate = opts.rate;
		const voices = window.speechSynthesis.getVoices();
		let voice: SpeechSynthesisVoice | null = opts.voiceName
			? (voices.find(v => v.name === opts.voiceName) ?? null)
			: null;
		voice ??= pickVoice(lang);
		if (voice) utterance.voice = voice;
		utterance.onend = () => onEnd?.();
		utterance.onerror = e => {
			// "interrupted"/"canceled" follow our own cancel() — not failures.
			if (e.error === "interrupted" || e.error === "canceled") return;
			onError?.(
				e.error === "not-allowed"
					? "audio blocked until first tap"
					: `speech synthesis error: ${e.error ?? "unknown"}`,
			);
		};
		window.speechSynthesis.speak(utterance);
	} catch (err) {
		onError?.(err instanceof Error ? err.message : String(err));
		return () => {};
	}
	return () => {
		try {
			window.speechSynthesis.cancel();
		} catch {
			// engine gone — nothing to cancel
		}
	};
}

/**
 * iOS/Safari autoplay unlock (openchamber parity): a silent WAV + a silent
 * utterance inside the current user gesture arm the synthesis engine for
 * later gesture-less calls (auto-read). No-op elsewhere.
 */
export function unlockNativeAudio(): void {
	if (typeof window === "undefined") return;
	try {
		if (typeof window.speechSynthesis !== "undefined") {
			const u = new SpeechSynthesisUtterance("");
			u.volume = 0;
			window.speechSynthesis.speak(u);
			window.speechSynthesis.cancel();
		}
		if (typeof window.AudioContext !== "undefined") {
			const ctx = new window.AudioContext();
			void ctx.resume();
			void ctx.close();
		}
	} catch {
		// unlock best-effort; the next real speak() reports failures itself
	}
}
