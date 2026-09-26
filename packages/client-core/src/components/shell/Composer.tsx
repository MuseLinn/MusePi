import { isSttDownloadEvent, type SttModelStatusResponse } from "@musepi/pi-wire";
import {
	Brain,
	Camera,
	Check,
	ChevronDown,
	Images,
	Mic,
	MicOff,
	Plus,
	SendHorizontal,
	Square,
	Volume2,
	X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { useBackLayer } from "../../lib/back-stack";
import type { SessionClient } from "../../lib/client";
import { haptic } from "../../lib/haptics";
import type { PendingAttachment } from "../../lib/image";
import { processImageFile, revokePreviews, toImageContent } from "../../lib/image";
import { type NativeRecognition, nativeVoiceSupport, startNativeRecognition } from "../../lib/native-voice";
import type { TtsSnapshot } from "../../lib/tts";
import { readSttLangPref, useTts, useTtsSnapshot } from "../../lib/tts";
import { useGuestSelector } from "../../lib/use-guest";
import type { VoiceCapture } from "../../lib/voice";
import { startVoiceCapture, transcribeAudio } from "../../lib/voice";
import { shouldShowChatLoading } from "../transcript/render-units";
import { ContextRing } from "./ContextRing";
import { MatrixLoader } from "./MatrixLoader";
import { SuggestionChips } from "./SuggestionChips";

/** Thinking ladder, display order (TUI `--thinking` parity; labels reuse the
 *  transcript-domain "thinking *" keys). `auto` = session sentinel. */
const THINKING_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
type ThinkingLadder = (typeof THINKING_LADDER)[number];
const THINKING_KEY: Record<ThinkingLadder, Parameters<typeof t>[0]> = {
	off: "thinking off",
	minimal: "thinking minimal",
	low: "thinking low",
	medium: "thinking medium",
	high: "thinking high",
	xhigh: "thinking xhigh",
	max: "thinking max",
	auto: "thinking auto",
};

export interface ComposerProps {
	client: SessionClient;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

// ── Voice input (daemon `stt.transcribe`; design frames 「录音中/转写回填/引导态」) ──

/** Voice-input UI state. `guide` = collab-direct host without `stt.*` RPCs.
 *  `native` marks an on-device Web Speech capture (fallback path).
 *  `setup` = first use with the recognition model still uncached — the
 *  guided-install card (A3 guest/mobile parity of the desktop gate). */
type VoiceUi =
	| { kind: "idle" }
	| { kind: "recording"; seconds: number; native?: boolean }
	| { kind: "transcribing" }
	| { kind: "error"; message: string }
	| { kind: "guide" }
	| {
			kind: "setup";
			modelKey: string;
			label: string;
			size: string;
			phase: "prompt" | "downloading" | "error";
			percent: number;
			loaded: number;
			total: number;
			error: string | null;
	  };

const VOICE_WAVE_BARS = 13;
/** The collab host is expected to answer (or reject) every RPC; the timeout
 * only covers a host that silently drops unknown methods. */
const STT_TIMEOUT_MS = 20_000;

/** Sticky per page-load: once the daemon transport proved to have no
 * `stt.*`, later mic taps go straight to the device's own recognizer. */
let preferNativeStt = false;

/** Sticky per page-load mirror: once the stt.modelStatus probe proved the
 *  default model is cached (or the host cannot answer status at all), later
 *  mic taps skip the round-trip and capture straight away.
 *  Size hints mirror stt/models.ts `sizeHint` — keep in sync with
 *  settings voice TIER_META and desktop-app voice-setup SIZE_HINTS. */
let sttModelCached = false;
const STT_SIZE_HINTS: Record<string, string> = {
	fast: "~60 MB",
	balanced: "~190 MB",
	turbo: "~600 MB",
	parakeet: "~680 MB",
};

function withTimeout<T>(promise: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("stt timeout")), STT_TIMEOUT_MS);
		promise.then(
			value => {
				clearTimeout(timer);
				resolve(value);
			},
			err => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/**
 * Composer voice input state machine: mic capture → daemon transcription →
 * text insertion. Every settle path bumps an epoch so a late `stt.transcribe`
 * round-trip can never insert text after the user cancelled or discarded.
 * `onInterrupt` fires when capture actually starts — TTS barge-in ("口述打断").
 */
function useVoiceInput(
	client: SessionClient,
	onText: (text: string) => void,
	onInterrupt?: () => void,
): {
	voice: VoiceUi;
	start(): void;
	stop(): void;
	cancel(): void;
	discard(): void;
	dismiss(): void;
	/** Guide-card escape hatch: switch to the device's own recognizer. */
	retryNative(): void;
	/** First-use gate (A3): kick the guided model install for `modelKey`. */
	installModel(modelKey: string): void;
} {
	const [voice, setVoice] = useState<VoiceUi>({ kind: "idle" });
	const captureRef = useRef<VoiceCapture | null>(null);
	/** Live Web Speech recognition (native fallback capture). */
	const nativeRef = useRef<NativeRecognition | null>(null);
	const epochRef = useRef(0);
	const onTextRef = useRef(onText);
	onTextRef.current = onText;
	const onInterruptRef = useRef(onInterrupt);
	onInterruptRef.current = onInterrupt;

	// ── First-use gate (A3 mobile parity) ──────────────────────────────
	// Sticky per page-load mirrors preferNativeStt: once the status probe
	// proved the default model is cached, later mic taps skip the round-trip.
	// (Backing store lives at module level — a render-local `let` would reset
	//  on every re-render and re-probe forever.)

	/** Open the mic for real — shared by the plain path and the setup card's
	 *  "download done → honor the original tap" auto-start. */
	const beginCapture = useCallback((): void => {
		const epoch = ++epochRef.current;
		startVoiceCapture()
			.then(capture => {
				if (epoch !== epochRef.current) {
					capture.abort();
					return;
				}
				captureRef.current = capture;
				onInterruptRef.current?.();
				setVoice({ kind: "recording", seconds: 0 });
				haptic(15);
			})
			.catch((err: unknown) => {
				const reason = err instanceof Error ? err.message : String(err);
				setVoice({ kind: "error", message: t("voice failed: {reason}", { reason }) });
				haptic(30);
			});
	}, []);

	/** Guided install: fire-and-forget download kick + local progress via the
	 *  daemon's global stt.download* events (subscribed in the effect below). */
	const installModel = useCallback(
		(modelKey: string): void => {
			setVoice(prev => (prev.kind === "setup" ? { ...prev, phase: "downloading", percent: 0, error: null } : prev));
			void client.rpc("stt.modelDownload", { modelKey }).catch((err: unknown) => {
				setVoice(prev =>
					prev.kind === "setup"
						? {
								...prev,
								phase: "error",
								error: err instanceof Error ? err.message : String(err),
							}
						: prev,
				);
			});
		},
		[client],
	);

	// Global download events: while the setup card is open, progress advances
	// its bar; done closes the card and starts the capture the user originally
	// asked for; error flips the card to retry. Same event channel as the
	// settings voice page — first subscriber issues events.subscribe.
	useEffect(() => {
		return client.onDaemonEvent(payload => {
			if (!isSttDownloadEvent(payload)) return;
			setVoice(prev => {
				if (prev.kind !== "setup" || payload.modelKey !== prev.modelKey) return prev;
				if (payload.type === "stt.downloadProgress") {
					return {
						...prev,
						phase: "downloading",
						percent: payload.percent,
						loaded: payload.loaded ?? 0,
						total: payload.total ?? 0,
					};
				}
				if (payload.type === "stt.downloadDone") {
					// Paint 100% briefly, then honor the tap that opened the card.
					window.setTimeout(() => {
						setVoice({ kind: "idle" });
						beginCapture();
					}, 450);
					return { ...prev, phase: "downloading", percent: 100, loaded: prev.total, total: prev.total };
				}
				return { ...prev, phase: "error", error: payload.message ?? t("voice setup download failed") };
			});
		});
	}, [client, beginCapture]);

	/** Device-native capture (Web Speech API): the recognizer owns the mic
	 *  and reports its transcript through callbacks. Declared before `start`
	 *  because `start`'s dependency array references it. */
	const nativeStart = useCallback((): boolean => {
		if (!nativeVoiceSupport().recognition) return false;
		const epoch = ++epochRef.current;
		const rec = startNativeRecognition({
			lang: readSttLangPref() || undefined,
			onFinal: text => {
				nativeRef.current = null;
				if (epoch !== epochRef.current) return;
				onTextRef.current(text);
				setVoice({ kind: "idle" });
				haptic(8);
			},
			onError: message => {
				nativeRef.current = null;
				if (epoch !== epochRef.current) return;
				setVoice({ kind: "error", message: t("voice failed: {reason}", { reason: message }) });
				haptic(30);
			},
		});
		if (!rec) return false;
		nativeRef.current = rec;
		captureRef.current = null;
		onInterruptRef.current?.();
		setVoice({ kind: "recording", seconds: 0, native: true });
		haptic(15);
		return true;
	}, []);

	const start = useCallback((): void => {
		if (captureRef.current || nativeRef.current) return;
		if (preferNativeStt && nativeStart()) return;
		// First-use gate: the daemon may answer stt.modelStatus (daemon hosts)
		// or reject it (collab-direct). Cached ⇒ capture straight away; missing
		// ⇒ setup card. An unreadable status (older daemon) falls through to
		// capture so transcribe's own error mapping keeps owning that case.
		if (!sttModelCached) {
			const epoch = epochRef.current;
			void withTimeout(client.rpc<SttModelStatusResponse>("stt.modelStatus", {}))
				.then(status => {
					if (epoch !== epochRef.current) return;
					sttModelCached = true;
					const defaultKey = status.defaultKey ?? status.models[0]?.key;
					const row = status.models.find(m => m.key === defaultKey);
					const cached = row?.cached ?? status.defaultCached ?? false;
					if (cached || !defaultKey) {
						beginCapture();
						return;
					}
					setVoice({
						kind: "setup",
						modelKey: defaultKey,
						label: row?.label ?? defaultKey,
						size: STT_SIZE_HINTS[defaultKey] ?? "",
						phase: status.downloads?.includes(defaultKey) ? "downloading" : "prompt",
						percent: 0,
						loaded: 0,
						total: 0,
						error: null,
					});
				})
				.catch(() => {
					if (epoch !== epochRef.current) return;
					sttModelCached = true; // don't re-probe every tap on a rejecting host
					beginCapture();
				});
			return;
		}
		beginCapture();
	}, [client, nativeStart, beginCapture]);

	// Recording timer (0:07 style, mono tabular).
	useEffect(() => {
		if (voice.kind !== "recording") return;
		const startedAt = Date.now();
		const timer = window.setInterval(() => {
			setVoice(v =>
				v.kind === "recording"
					? { kind: "recording", seconds: Math.floor((Date.now() - startedAt) / 1000), native: v.native }
					: v,
			);
		}, 500);
		return () => window.clearInterval(timer);
	}, [voice.kind]);

	const stop = useCallback((): void => {
		// Native capture: `stop()` asks the recognizer to finish; its
		// transcript arrives via onFinal/onError (mapped to transcribing UI).
		const native = nativeRef.current;
		if (native) {
			setVoice({ kind: "transcribing" });
			native.stop();
			return;
		}
		const capture = captureRef.current;
		if (!capture) return;
		const epoch = epochRef.current;
		setVoice({ kind: "transcribing" });
		capture
			.stop()
			.then(audio => withTimeout(transcribeAudio(client, audio, readSttLangPref() || undefined)))
			.then(text => {
				captureRef.current = null;
				if (epoch !== epochRef.current) return;
				if (text.trim()) {
					onTextRef.current(text.trim());
					haptic(8);
				}
				setVoice({ kind: "idle" });
			})
			.catch((err: unknown) => {
				captureRef.current = null;
				if (epoch !== epochRef.current) return;
				const msg = err instanceof Error ? err.message : String(err);
				// `stt.*` is daemon-transport only — a collab-direct host rejects
				// with the generic "rpc failed" (or our own timeout fires). Real
				// daemon errors (model not ready, …) carry a readable message:
				// show it instead of the generic guide.
				if (msg === "rpc failed" || msg === "stt timeout") {
					setVoice({ kind: "guide" });
				} else {
					setVoice({ kind: "error", message: t("voice failed: {reason}", { reason: msg }) });
				}
				haptic(30);
			});
	}, [client]);

	const cancel = useCallback((): void => {
		epochRef.current++;
		captureRef.current?.abort();
		captureRef.current = null;
		nativeRef.current?.abort();
		nativeRef.current = null;
		setVoice({ kind: "idle" });
		haptic(8);
	}, []);

	/** Abandon an in-flight transcription — the late result is dropped. */
	const discard = useCallback((): void => {
		epochRef.current++;
		captureRef.current?.abort();
		captureRef.current = null;
		nativeRef.current?.abort();
		nativeRef.current = null;
		setVoice({ kind: "idle" });
	}, []);

	const dismiss = useCallback((): void => {
		epochRef.current++;
		setVoice({ kind: "idle" });
	}, []);

	/** Guide-card escape hatch: switch to the device's own recognizer
	 *  (openchamber parity) and stick to it for the rest of the page load. */
	const retryNative = useCallback((): void => {
		if (nativeStart()) {
			preferNativeStt = true;
			dismiss();
		}
	}, [nativeStart, dismiss]);

	// Unmount safety: never leave the mic open (either capture path).
	useEffect(
		() => () => {
			captureRef.current?.abort();
			nativeRef.current?.abort();
		},
		[],
	);

	return { voice, start, stop, cancel, discard, dismiss, retryNative, installModel };
}

/** Recording / transcribing / error bar — replaces the textarea in the composer card. */
function VoiceBar({
	voice,
	onStop,
	onCancel,
	onDiscard,
}: {
	voice: VoiceUi;
	onStop(): void;
	onCancel(): void;
	onDiscard(): void;
}): ReactNode {
	if (voice.kind === "recording") {
		const mm = Math.floor(voice.seconds / 60);
		const ss = String(voice.seconds % 60).padStart(2, "0");
		return (
			<div className="sh-voice sh-voice--recording" role="status" aria-label={t("recording…")}>
				<span className="sh-voice-pulse" aria-hidden>
					<Mic size={14} />
				</span>
				<span className="sh-voice-wave" aria-hidden>
					{Array.from({ length: VOICE_WAVE_BARS }, (_, i) => (
						<span
							key={i}
							style={{ animationDelay: `${(i % 5) * 0.12}s`, animationDuration: `${0.9 + (i % 3) * 0.18}s` }}
						/>
					))}
				</span>
				<span className="sh-voice-timer">
					{mm}:{ss}
				</span>
				{voice.native && <span className="sh-voice-native">{t("voice native badge")}</span>}
				<span className="sh-voice-flex" aria-hidden />
				<button
					type="button"
					className="sh-voice-btn sh-voice-btn--danger"
					onClick={onCancel}
					title={t("voice discard")}
					aria-label={t("voice discard")}
				>
					<X size={13} />
				</button>
				<button type="button" className="sh-voice-stop" onClick={onStop} title={t("voice recording stop")}>
					<Square size={9} /> <span>{t("voice done")}</span>
				</button>
			</div>
		);
	}
	if (voice.kind === "transcribing") {
		return (
			<div className="sh-voice sh-voice--transcribing" role="status">
				<span className="sh-voice-spinner" aria-hidden />
				<span className="sh-voice-label">{t("voice transcribing")}</span>
				<span className="sh-voice-flex" aria-hidden />
				<button
					type="button"
					className="sh-voice-btn sh-voice-btn--muted"
					onClick={onDiscard}
					title={t("voice discard")}
					aria-label={t("voice discard")}
				>
					<X size={13} />
				</button>
			</div>
		);
	}
	if (voice.kind === "error") {
		return (
			<div className="sh-voice sh-voice--error" role="alert">
				<span className="sh-voice-label sh-voice-err">{voice.message}</span>
				<span className="sh-voice-flex" aria-hidden />
				<button
					type="button"
					className="sh-voice-btn sh-voice-btn--muted"
					onClick={onCancel}
					title={t("close")}
					aria-label={t("close")}
				>
					<X size={13} />
				</button>
			</div>
		);
	}
	return null;
}

/** collab-direct guide card (design frame 「引导态」): no fake mic, explain the daemon requirement.
 *  `onRetry` — offered when the device has its own speech recognizer: skips
 *  the daemon entirely (openchamber Web Speech parity). */
function VoiceGuide({ onDismiss, onRetry }: { onDismiss(): void; onRetry?: () => void }): ReactNode {
	return (
		<div className="sh-voice-guide" role="alertdialog" aria-label={t("voice needs daemon backend")}>
			<MicOff size={20} aria-hidden />
			<p className="sh-voice-guide-title">{t("voice needs daemon backend")}</p>
			<p className="sh-voice-guide-sub">{t("voice needs daemon body")}</p>
			<div className="sh-voice-guide-actions">
				{onRetry && (
					<button type="button" className="sh-voice-guide-btn" onClick={onRetry}>
						{t("voice guide native retry")}
					</button>
				)}
				<button type="button" className="sh-voice-guide-btn" onClick={onDismiss}>
					{t("voice guide ok")}
				</button>
			</div>
		</div>
	);
}

/** First-use install card (A3): the daemon hosts the recognition model, so
 *  the first mic tap with an uncached default model opens this card instead
 *  of dead-ending in a bare `stt.transcribe` error. Liquid-glass sibling of
 *  the desktop dialog (same wire flow: modelStatus → modelDownload →
 *  stt.download* events → auto-start the capture the tap asked for). */
function VoiceSetupCard({
	state,
	onInstall,
	onRetry,
	onDismiss,
	onNative,
}: {
	state: Extract<VoiceUi, { kind: "setup" }>;
	onInstall(): void;
	onRetry(): void;
	onDismiss(): void;
	onNative?(): void;
}): ReactNode {
	return (
		<div className="sh-voice-guide sh-voice-setup" role="alertdialog" aria-label={t("voice setup title")}>
			<p className="sh-voice-guide-title">{t("voice setup title")}</p>
			{state.phase === "prompt" && (
				<>
					<p className="sh-voice-guide-sub">{t("voice setup desc", { model: state.label, size: state.size })}</p>
					<p className="sh-voice-setup-note">{t("voice setup note")}</p>
				</>
			)}
			{state.phase === "downloading" && (
				<>
					<div
						className="sh-voice-setup-bar"
						role="progressbar"
						aria-valuenow={state.percent}
						aria-valuemin={0}
						aria-valuemax={100}
					>
						<div className="sh-voice-setup-bar-fill" style={{ width: `${state.percent}%` }} />
					</div>
					<p className="sh-voice-setup-note">
						{state.label} · {state.percent > 0 ? `${state.percent}%` : t("voice setup preparing")}
					</p>
				</>
			)}
			{state.phase === "error" && <p className="sh-voice-guide-sub sh-voice-err">{state.error}</p>}
			<div className="sh-voice-guide-actions">
				<button type="button" className="sh-voice-guide-btn" onClick={onDismiss}>
					{t("later")}
				</button>
				{state.phase === "prompt" && (
					<button type="button" className="sh-voice-guide-btn sh-voice-guide-btn--primary" onClick={onInstall}>
						{t("voice setup install")}
					</button>
				)}
				{state.phase === "error" && (
					<button type="button" className="sh-voice-guide-btn sh-voice-guide-btn--primary" onClick={onRetry}>
						{t("retry")}
					</button>
				)}
			</div>
			{state.phase === "prompt" && onNative && (
				<button type="button" className="sh-voice-setup-native" onClick={onNative}>
					{t("voice guide native retry")}
				</button>
			)}
		</div>
	);
}

/**
 * Voice-output strip above the composer (design frames 「迷你播放器/合成中/打断降级」):
 * loading spinner → playing mini-player (progress + elapsed + stop) → guide /
 * error states. Shares the TtsController with the transcript's speak buttons,
 * so a stop here and a highlight there are always the same truth.
 */
function TtsBar({ snap, tts }: { snap: TtsSnapshot; tts: ReturnType<typeof useTts> }): ReactNode {
	if (snap.guide) {
		return (
			<div className="sh-tts sh-tts--guide" role="status">
				<MicOff size={14} aria-hidden />
				<span className="sh-tts-label sh-tts-label--muted">{t("tts needs daemon backend")}</span>
				<span className="sh-voice-flex" aria-hidden />
				<button type="button" className="sh-voice-guide-btn" onClick={() => tts.dismissGuide()}>
					{t("voice guide ok")}
				</button>
			</div>
		);
	}
	if (snap.error !== null) {
		return (
			<div className="sh-tts sh-tts--error" role="alert">
				<span className="sh-voice-label sh-voice-err">
					{t("voice output unavailable")} — {snap.error}
				</span>
				<span className="sh-voice-flex" aria-hidden />
				<button
					type="button"
					className="sh-voice-btn sh-voice-btn--muted"
					onClick={() => tts.dismissError()}
					title={t("close")}
					aria-label={t("close")}
				>
					<X size={13} />
				</button>
			</div>
		);
	}
	if (snap.phase === "loading") {
		return (
			<div className="sh-tts" role="status">
				<span className="sh-voice-spinner" aria-hidden />
				<span className="sh-tts-label">{t("voice output testing…")}</span>
				<span className="sh-voice-flex" aria-hidden />
				<button
					type="button"
					className="sh-voice-btn sh-voice-btn--muted"
					onClick={() => tts.stop()}
					title={t("read aloud stop")}
					aria-label={t("read aloud stop")}
				>
					<X size={13} />
				</button>
			</div>
		);
	}
	if (snap.phase === "playing") {
		const mm = Math.floor(snap.elapsedSec / 60);
		const ss = String(snap.elapsedSec % 60).padStart(2, "0");
		return (
			<div className="sh-tts sh-tts--playing" role="status" aria-label={t("read aloud")}>
				<span className="sh-tts-chip sh-tts-chip--pulse" aria-hidden>
					<Volume2 size={14} />
				</span>
				{/* Native playback reports no duration — elapsed-only, no track. */}
				{snap.totalSec > 0 && (
					<span className="sh-tts-track" aria-hidden>
						<span className="sh-tts-fill" style={{ width: `${Math.round(snap.progress * 100)}%` }} />
					</span>
				)}
				<span className="sh-tts-time">
					{mm}:{ss}
				</span>
				<button
					type="button"
					className="sh-tts-btn-stop"
					onClick={() => tts.stop()}
					title={t("read aloud stop")}
					aria-label={t("read aloud stop")}
				>
					<Square size={9} />
				</button>
			</div>
		);
	}
	return null;
}

interface AskEditorProps {
	prefill: string | undefined;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, []);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder={t("type your response…")}
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={() => onSubmit(draft)}
					title={t("submit response")}
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">{t("Submit")}</span>
				</button>
			</div>
		</div>
	);
}

export function Composer({ client }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	// Pending image attachments (protocol `prompt.images` — host-side
	// #handlePrompt already consumes them). Previews are object URLs; every
	// exit path (send / remove / unmount) revokes them.
	const [pending, setPending] = useState<PendingAttachment[]>([]);
	const [attachOpen, setAttachOpen] = useState(false);
	// model/thinking capsule (design 二期 F1/F2): model is read-only (the host
	// session owns it); thinking selection goes out as a `config` frame and
	// the UI updates only when the state broadcast round-trips.
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const galleryRef = useRef<HTMLInputElement | null>(null);
	const cameraRef = useRef<HTMLInputElement | null>(null);
	const pendingRef = useRef<PendingAttachment[]>([]);
	useEffect(() => {
		pendingRef.current = pending;
	}, [pending]);
	useEffect(() => () => revokePreviews(pendingRef.current), []);

	// Field-level subscriptions: input state and turn liveness only — never
	// re-rendered on transcript or notice frames.
	const live = useGuestSelector(client, s => s.phase) === "live";
	const readOnly = useGuestSelector(client, s => s.readOnly);
	const uiRequest = useGuestSelector(client, s => s.uiRequest);
	// True while a multi-select (checkbox) answer awaits the host's re-issue
	// after an option toggle — the dialog stays mounted but options are
	// disabled until the follow-up frame replaces it (no double-submit).
	const uiRequestPending = useGuestSelector(client, s => s.uiRequestPending);
	const busy = useGuestSelector(client, s => s.working);
	/** Design doc §B (M1.2): the animated "working" pill is a MODEL-liveness
	 *  signal — while a blocking card owns the wait (host tool approval,
	 *  pending `ask` question, auto-compaction, goal verifier), it must not
	 *  also claim progress. Each flag is snapshot state; the combination is
	 *  the unit-tested shouldShowChatLoading truth table. */
	const approvalPending = useGuestSelector(client, s => s.approvalRequest !== null);
	const askPending = useGuestSelector(client, s => s.uiRequest !== null);
	const compacting = useGuestSelector(client, s => s.compacting);
	const showWorking = shouldShowChatLoading({ working: busy, approvalPending, askPending, compacting });
	const queued = useGuestSelector(client, s => s.state?.queuedMessageCount ?? 0);
	// Empty-state draft suggestions (openchamber parity): show only while the
	// session is live, editable and has nothing to show yet.
	const empty = useGuestSelector(client, s => s.entries.length === 0 && s.stream === null && !s.working);
	const model = useGuestSelector(client, s => s.state?.model ?? null);
	const thinking = useGuestSelector(client, s => s.state?.thinkingLevel ?? null);
	const canPrompt = live && !readOnly;
	// Voice input (daemon `stt.transcribe`; design 「语音四帧」): recognized
	// text lands in the textarea draft, editable before sending. The voice
	// slot replaces the textarea while recording/transcribing.
	const tts = useTts(client);
	const ttsSnap = useTtsSnapshot(tts);
	const onVoiceText = useCallback((recognized: string): void => {
		setText(prev => (prev ? `${prev} ${recognized}` : recognized));
		taRef.current?.focus();
	}, []);
	// Barge-in ("口述打断"): speaking the mic command stops playback first.
	const voiceCtl = useVoiceInput(client, onVoiceText, () => tts.stop());
	const voice = voiceCtl.voice;
	const voiceBusy = voice.kind === "recording" || voice.kind === "transcribing";
	// editor-draft mode keeps submit enabled even for whitespace-only prefill;
	// image-only prompts (no caption) are also submittable. Voice capture owns
	// the input slot while active — sending mid-recording would be surprising.
	const canSend =
		canPrompt &&
		voice.kind === "idle" &&
		(text.trim().length > 0 || pending.length > 0 || uiRequest?.kind === "editor");

	useLayoutEffect(() => {
		autosize(taRef.current);
	}, []);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!live || readOnly) return;
		if (!trimmed && pending.length === 0) return;
		client.sendPrompt(trimmed, toImageContent(pending));
		revokePreviews(pending);
		setPending([]);
		setText("");
		haptic(8);
	}, [client, live, readOnly, text, pending]);

	/** Encodes picked image files into pending attachments (queued behind the
	 * current state; failures reject individually without blocking the batch). */
	const addFiles = useCallback(async (files: FileList | null): Promise<void> => {
		if (!files || files.length === 0) return;
		const picked = Array.from(files).filter(f => f.type.startsWith("image/"));
		if (picked.length === 0) return;
		const encoded: PendingAttachment[] = [];
		for (const file of picked) {
			try {
				encoded.push(await processImageFile(file));
			} catch {
				// Undecodable image — skip it rather than failing the batch.
			}
		}
		if (encoded.length === 0) return;
		setPending(current => [...current, ...encoded]);
		haptic(8);
	}, []);

	const removePending = useCallback((id: string): void => {
		setPending(current => {
			const target = current.find(p => p.id === id);
			if (target) URL.revokeObjectURL(target.previewUrl);
			return current.filter(p => p.id !== id);
		});
		haptic(8);
	}, []);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	if (uiRequest && canPrompt) {
		// Multi-select (checkbox) questions: the host runs a toggle loop and
		// re-issues the request after each option tap. While the re-issue is
		// in flight (uiRequestPending) the options lock so a double-tap can't
		// send the same label twice.
		const multi = uiRequest.kind === "select" && uiRequest.selectionMarker === "checkbox";
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<div className="sh-ask-options">
						{uiRequest.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = uiRequest.checkedIndices?.includes(index) ?? false;
							const locked = multi && uiRequestPending;
							return (
								<button
									key={`${uiRequest.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
									disabled={locked}
									onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
								>
									<span className="sh-ask-option-marker">
										{multi ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
								</button>
							);
						})}
						{multi && uiRequest.helpText && (
							<p className="sh-ask-hint" role="status">
								{t("select multiple — choose each option, then pick Next")}
							</p>
						)}
					</div>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						prefill={uiRequest.prefill}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={multi && uiRequestPending}
						onClick={() => client.sendUiResponse(uiRequest.reqId, "Next →")}
					>
						{t("Next")}
					</button>
					<button type="button" className="sh-btn" onClick={() => client.sendUiResponse(uiRequest.reqId)}>
						{t("cancel ask")}
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => {
								client.sendAbort();
								haptic(15);
							}}
							disabled={!live}
							title={t("stop the current turn")}
						>
							<Square size={11} /> <span className="sh-btn-label">{t("Stop")}</span>
						</button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			{canPrompt && empty && (
				<div className="sh-composer-suggest">
					<SuggestionChips
						onPick={prompt => {
							setText(prompt);
							taRef.current?.focus();
							haptic(8);
						}}
					/>
				</div>
			)}
			{canPrompt && pending.length > 0 && (
				<div className="sh-attach-chips" role="list" aria-label={t("add images")}>
					{pending.map(p => (
						<div key={p.id} className="sh-attach-chip" role="listitem">
							<img src={p.previewUrl} alt={p.name} className="sh-attach-thumb" />
							<button
								type="button"
								className="sh-attach-remove"
								onClick={() => removePending(p.id)}
								title={t("remove attachment")}
								aria-label={`${t("remove attachment")}: ${p.name}`}
							>
								<X size={9} />
							</button>
						</div>
					))}
				</div>
			)}
			{(ttsSnap.phase !== "idle" || ttsSnap.guide || ttsSnap.error !== null) && <TtsBar snap={ttsSnap} tts={tts} />}
			<div className="sh-composer-inner">
				{voice.kind === "guide" ? (
					<VoiceGuide
						onDismiss={voiceCtl.dismiss}
						onRetry={nativeVoiceSupport().recognition ? voiceCtl.retryNative : undefined}
					/>
				) : voice.kind === "setup" ? (
					<VoiceSetupCard
						state={voice}
						onInstall={() => voiceCtl.installModel(voice.modelKey)}
						onRetry={() => voiceCtl.installModel(voice.modelKey)}
						onDismiss={voiceCtl.dismiss}
						onNative={nativeVoiceSupport().recognition ? voiceCtl.retryNative : undefined}
					/>
				) : voiceBusy || voice.kind === "error" ? (
					<VoiceBar voice={voice} onStop={voiceCtl.stop} onCancel={voiceCtl.cancel} onDiscard={voiceCtl.discard} />
				) : (
					<textarea
						ref={taRef}
						className="sh-composer-input"
						value={text}
						onChange={e => setText(e.target.value)}
						onKeyDown={onKeyDown}
						onCompositionStart={onCompositionStart}
						onCompositionEnd={onCompositionEnd}
						placeholder={
							readOnly
								? t("read-only session — watching only")
								: live
									? t("ask anything, / for commands, @ for context…")
									: t("waiting for session…")
						}
						disabled={!canPrompt}
						rows={1}
						spellCheck={false}
					/>
				)}
				<div className="sh-composer-actions">
					{canPrompt && voice.kind === "idle" && (
						<button
							type="button"
							className="sh-btn sh-attach-btn"
							onClick={voiceCtl.start}
							title={t("voice input")}
							aria-label={t("voice input")}
						>
							<Mic size={15} />
						</button>
					)}
					{canPrompt && (
						<button
							type="button"
							className={`sh-btn sh-attach-btn${ttsSnap.autoRead ? " sh-tts-toggle--on" : ""}`}
							onClick={() => tts.toggleAutoRead()}
							aria-pressed={ttsSnap.autoRead}
							title={t("voice output auto read")}
							aria-label={t("voice output auto read")}
						>
							<Volume2 size={15} />
						</button>
					)}
					{canPrompt && (
						<button
							type="button"
							className="sh-btn sh-attach-btn"
							onClick={() => setAttachOpen(true)}
							title={t("add images")}
							aria-label={t("add images")}
						>
							<Plus size={15} />
						</button>
					)}
					{canPrompt && (model || thinking) && (
						<div className="sh-mt-capsule" role="group" aria-label={t("model & thinking")}>
							{model && (
								<button
									type="button"
									className="sh-mt-seg"
									onClick={() => {
										setModelSheetOpen(true);
										haptic(8);
									}}
									title={model.name}
								>
									<span className="sh-mt-model">{model.name}</span>
									<ChevronDown size={11} className="sh-mt-caret" aria-hidden />
								</button>
							)}
							{model && thinking ? <span className="sh-mt-sep" aria-hidden /> : null}
							<button
								type="button"
								className="sh-mt-seg"
								onClick={() => {
									setModelSheetOpen(true);
									haptic(8);
								}}
								title={t("thinking level")}
							>
								<Brain size={13} aria-hidden />
								<span>
									{
										THINKING_KEY[
											(THINKING_LADDER as readonly string[]).includes(thinking ?? "")
												? (thinking as ThinkingLadder)
												: "auto"
										]
									}
								</span>
							</button>
						</div>
					)}
					<ContextRing client={client} />
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">{t("queued")} </span>×{queued}
						</span>
					)}
					{busy && !readOnly ? (
						showWorking ? (
							/* 三合一 send control (desktop GUI parity): the same button
							 * that sends becomes the live working display — accent pill
							 * with the dot-matrix bloom; tap aborts the turn. */
							<button
								type="button"
								className="sh-btn sh-btn-send-work"
								onClick={() => {
									client.sendAbort();
									haptic(15);
								}}
								disabled={!live}
								title={t("stop the current turn")}
								aria-label={t("stop the current turn")}
							>
								<span className="sh-send-work">
									<MatrixLoader className="sh-send-matrix" />
									<span className="sh-send-label">{t("working active")}</span>
								</span>
							</button>
						) : (
							/* Suppressed states (design doc §B): a blocking card owns
							 * the wait feedback, so the animated pill stays hidden —
							 * but abort must remain reachable, hence a quiet ghost
							 * stop instead of the matrix bloom. */
							<button
								type="button"
								className="sh-btn sh-btn-send-wait"
								onClick={() => {
									client.sendAbort();
									haptic(15);
								}}
								disabled={!live}
								title={t("stop the current turn")}
								aria-label={t("stop the current turn")}
							>
								<Square size={12} />
							</button>
						)
					) : (
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={send}
							disabled={!canSend}
							title={t("send (Enter)")}
						>
							<SendHorizontal size={12} /> <span className="sh-btn-label">{t("Send")}</span>
						</button>
					)}
				</div>
			</div>
			{/* Hidden pickers: refs stay mounted at the composer root so the
			 * attach sheet can trigger them and unmount freely. */}
			<input
				ref={galleryRef}
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={e => {
					void addFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<input
				ref={cameraRef}
				type="file"
				accept="image/*"
				capture="environment"
				hidden
				onChange={e => {
					void addFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<AttachSheet
				open={attachOpen}
				onClose={() => setAttachOpen(false)}
				onCamera={() => cameraRef.current?.click()}
				onLibrary={() => galleryRef.current?.click()}
			/>
			<ModelThinkingSheet client={client} open={modelSheetOpen} onClose={() => setModelSheetOpen(false)} />
		</div>
	);
}

/**
 * Bottom action sheet choosing an attachment source (design frame
 * 「Session 附件流」): camera capture vs library picker. Reuses the
 * sessions-sheet visual language (`ss-*` frosted floating card + grabber).
 * The sheet itself never touches files — it just triggers the hidden inputs
 * owned by the composer, so selection state survives sheet unmount.
 */
function AttachSheet({
	open,
	onClose,
	onCamera,
	onLibrary,
}: {
	open: boolean;
	onClose(): void;
	onCamera(): void;
	onLibrary(): void;
}): ReactNode {
	// Always mounted; the visible/closing stage drives the CSS animations so
	// a close never pops the card off screen (SessionsSheet convention).
	const [stage, setStage] = useState<"hidden" | "open" | "closing">(open ? "open" : "hidden");
	useEffect(() => {
		setStage(prev => (open ? "open" : prev === "open" ? "closing" : "hidden"));
	}, [open]);
	useEffect(() => {
		if (!open) return;
		// DOM KeyboardEvent (React's type is shadowed by the react import
		// above, so the listener callback relies on inference instead).
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);
	// Android back key closes the sheet (below the sessions sheet's 90).
	useBackLayer(
		85,
		open,
		useCallback(() => {
			onClose();
			return true;
		}, [onClose]),
	);
	useEffect(() => {
		if (stage !== "closing") return;
		// ss-card exit is ~280ms; timer fallback covers swallowed animationend.
		const timer = setTimeout(() => setStage("hidden"), 280);
		return () => clearTimeout(timer);
	}, [stage]);

	if (stage === "hidden") return null;
	const closing = stage === "closing";

	return (
		<div className={`ss-backdrop${closing ? " ss-closing" : ""}`} role="presentation" onClick={onClose}>
			<div
				className={`ss-card sh-attach-card${closing ? " ss-closing" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-label={t("add images")}
				onClick={e => e.stopPropagation()}
				onAnimationEnd={() => {
					if (closing) setStage("hidden");
				}}
			>
				<div className="ss-grabber" aria-hidden />
				<div className="ss-card-head">
					<h2 className="ss-card-title">{t("add images")}</h2>
					<button type="button" className="ss-close" onClick={onClose} title={t("close")}>
						<X size={16} />
					</button>
				</div>
				<div className="sh-attach-options">
					<button
						type="button"
						className="sh-attach-option"
						onClick={() => {
							onClose();
							onCamera();
						}}
					>
						<Camera size={18} />
						<span>{t("take photo")}</span>
					</button>
					<button
						type="button"
						className="sh-attach-option"
						onClick={() => {
							onClose();
							onLibrary();
						}}
					>
						<Images size={18} />
						<span>{t("choose from library")}</span>
					</button>
				</div>
				<p className="sh-attach-hint">{t("attach images hint")}</p>
			</div>
		</div>
	);
}

/**
 * Model info + thinking-level picker sheet (design frames 「Model·思考 Sheet」).
 * The model row is display-only — the host session owns model selection —
 * while the thinking ladder writes out via `client.sendThinkingLevel`; the
 * capsule re-renders from the state broadcast once the host applies it.
 * Reuses the sessions-sheet visual language (`ss-*`).
 */
function ModelThinkingSheet({
	client,
	open,
	onClose,
}: {
	client: SessionClient;
	open: boolean;
	onClose(): void;
}): ReactNode {
	const [stage, setStage] = useState<"hidden" | "open" | "closing">(open ? "open" : "hidden");
	const model = useGuestSelector(client, s => s.state?.model ?? null);
	const thinking = useGuestSelector(client, s => s.state?.thinkingLevel ?? null);
	const current: ThinkingLadder = (THINKING_LADDER as readonly string[]).includes(thinking ?? "")
		? (thinking as ThinkingLadder)
		: "auto";
	useEffect(() => {
		setStage(prev => (open ? "open" : prev === "open" ? "closing" : "hidden"));
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);
	useBackLayer(
		84,
		open,
		useCallback(() => {
			onClose();
			return true;
		}, [onClose]),
	);
	useEffect(() => {
		if (stage !== "closing") return;
		const timer = setTimeout(() => setStage("hidden"), 280);
		return () => clearTimeout(timer);
	}, [stage]);

	if (stage === "hidden") return null;
	const closing = stage === "closing";

	return (
		<div className={`ss-backdrop${closing ? " ss-closing" : ""}`} role="presentation" onClick={onClose}>
			<div
				className={`ss-card${closing ? " ss-closing" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-label={t("model & thinking")}
				onClick={e => e.stopPropagation()}
				onAnimationEnd={() => {
					if (closing) setStage("hidden");
				}}
			>
				<div className="ss-grabber" aria-hidden />
				<div className="ss-card-head">
					<h2 className="ss-card-title">{t("model & thinking")}</h2>
					<button type="button" className="ss-close" onClick={onClose} title={t("close")}>
						<X size={16} />
					</button>
				</div>
				{model && (
					<div className="sh-mt-info">
						<span className="sh-mt-info-name">{model.name}</span>
						<span className="sh-mt-info-meta">
							{model.provider}
							{model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}K` : ""}
						</span>
					</div>
				)}
				<p className="sh-mt-divider">{t("thinking level")}</p>
				<div className="sh-mt-list" role="listbox" aria-label={t("thinking level")}>
					{THINKING_LADDER.map(level => (
						<button
							key={level}
							type="button"
							role="option"
							aria-selected={level === current}
							className={`sh-mt-row${level === current ? " sh-mt-row--active" : ""}`}
							onClick={() => {
								client.sendThinkingLevel(level);
								onClose();
								haptic(12);
							}}
						>
							<span>{t(THINKING_KEY[level])}</span>
							{level === current ? <Check size={14} aria-hidden /> : null}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
