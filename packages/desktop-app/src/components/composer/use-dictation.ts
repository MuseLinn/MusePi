import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { cancelActiveDictation, evaluateSubmitTrigger, type SttSubmitTrigger, startDictation } from "../../lib/voice";

/**
 * Dictation lifecycle: idle → recording → transcribing → (insert | error).
 *
 * ONE phase state owns the whole flow. It replaces the old
 * `dictating` + `transcribing` boolean pair, which desynced at exactly the
 * spot users noticed: pressing the mic to stop the recording cleared BOTH
 * flags while the transcribe RPC was only just starting, so the entire
 * transcription wait rendered as an idle composer and the transcript popped
 * in seconds later with no feedback in between. With the phase model the
 * same press lands in "transcribing" and the composer shows the live strip
 * until the text actually arrives.
 *
 * Phase semantics (mic press = keep & transcribe, Esc = discard):
 * - recording → mic press → transcribing (buffer is kept, voice.ts contract)
 * - transcribing → mic press / Esc → idle + CANCELLED (the old code here
 *   only cleared the UI and let the transcript still land later — a state
 *   machine leak this hook closes)
 * - unmount while active → cancelled, so a session switch can never have a
 *   finished transcript land in a dead composer's draft
 */
export type DictationPhase = "idle" | "recording" | "transcribing";

export interface DictationController {
	phase: DictationPhase;
	/** Recording clock (seconds); live during the recording phase only. */
	seconds: number;
	/** Mic RMS level (0..1); live during the recording phase only. */
	level: number;
	/** Last dictation failure (friendly copy); auto-dismisses after 6 s. */
	error: string | null;
	toggle(): void;
	dismissError(): void;
}

export function useDictation(opts: {
	rpc: RpcClient | null;
	sttSubmitTrigger: SttSubmitTrigger;
	/** stt.enabled daemon gate (TUI parity): false blocks starting a NEW
	 *  dictation; in-flight phases still settle/cancel normally. */
	enabled?: boolean;
	/** Transcript matched the submit trigger — auto-send path (sliced). */
	onSubmit(text: string): void;
	/** Transcript for the draft box (submit trigger not matched). */
	onInsert(text: string): void;
}): DictationController {
	const { rpc } = opts;
	// Latest-ref: the toggle closure below starts the dictation once and its
	// callbacks must always read the caller's CURRENT callbacks and trigger
	// setting, without re-arming the session on every render.
	const optsRef = useRef(opts);
	useEffect(() => {
		optsRef.current = opts;
	});
	const [phase, setPhase] = useState<DictationPhase>("idle");
	// Mirror for handlers that must not depend on `phase` (unmount cleanup,
	// the toggle closure itself) — event-time state, not render-time.
	const phaseRef = useRef(phase);
	useEffect(() => {
		phaseRef.current = phase;
	}, [phase]);
	const [seconds, setSeconds] = useState(0);
	const [level, setLevel] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const errorTimer = useRef<number | null>(null);
	const stopRef = useRef<(() => void) | null>(null);

	const showError = useCallback((message: string): void => {
		setError(message);
		if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
		errorTimer.current = window.setTimeout(() => setError(null), 6000);
	}, []);

	// Settle: drop the live handle and return to idle (idempotent — voice.ts
	// may report both onError and an error onState for the same failure).
	const settle = useCallback((): void => {
		stopRef.current = null;
		setPhase("idle");
	}, []);

	const toggle = useCallback((): void => {
		// stt.enabled gate (TUI parity): a disabled setting never starts a
		// session — but an in-flight dictation may still be stopped/cancelled.
		if (optsRef.current.enabled === false && phaseRef.current === "idle") return;
		if (phaseRef.current === "recording") {
			// Mic press while recording = finish early and transcribe (voice.ts
			// keeps the buffer). Optimistically show the transcribing phase;
			// the onState callback confirms it when the recorder resolves.
			stopRef.current?.();
			setPhase("transcribing");
			return;
		}
		if (phaseRef.current === "transcribing") {
			cancelActiveDictation();
			settle();
			return;
		}
		setSeconds(0);
		setLevel(0);
		const stop = startDictation(
			transcript => {
				const { submit, trimTrailing } = evaluateSubmitTrigger(transcript, optsRef.current.sttSubmitTrigger);
				if (submit) optsRef.current.onSubmit(transcript.slice(0, transcript.length - trimTrailing));
				else optsRef.current.onInsert(transcript);
				settle();
			},
			message => {
				settle();
				showError(message);
			},
			rpc,
			activity => {
				if (activity.phase === "recording") {
					setPhase("recording");
					setSeconds(activity.seconds);
					setLevel(activity.level);
				} else if (activity.phase === "transcribing") {
					setPhase("transcribing");
				} else if (activity.phase === "stopped") {
					// cancelActiveDictation() path (Esc / mic-during-transcribe / unmount).
					settle();
				} else if (activity.phase === "error") {
					settle();
					showError(activity.message);
				}
			},
		);
		stopRef.current = stop ?? null;
		if (stop) setPhase("recording");
	}, [rpc, settle, showError]);

	// Esc discards an in-flight dictation at ANY phase — the recording buffer
	// or the already-submitted transcribe RPC alike (capture phase, so the
	// composer behind never sees it).
	useEffect(() => {
		if (phase === "idle") return;
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			cancelActiveDictation();
			stopRef.current = null;
			setPhase("idle");
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [phase]);

	// Switching scenes unmounts the composer mid-dictation: drop the session
	// so a finished transcript can never land in a dead component's draft.
	// phaseRef guards against cancelling another composer's live session.
	useEffect(
		() => () => {
			if (phaseRef.current !== "idle") cancelActiveDictation();
			if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
		},
		[],
	);

	const dismissError = useCallback((): void => {
		if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
		setError(null);
	}, []);

	return { phase, seconds, level, error, toggle, dismissError };
}
