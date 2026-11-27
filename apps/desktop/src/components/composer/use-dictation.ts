import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import {
	cancelActiveDictation,
	evaluateSubmitTrigger,
	getVoiceInputDevice,
	type SttSubmitTrigger,
	startDictationOpts,
} from "../../lib/voice";

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
	/** The composer editor. Dictation writes its text THROUGH this handle so the
	 *  preview and each committed segment share one region: a preview painted at
	 *  the caret while commits were appended to the draft's end scattered the
	 *  words of a continuous utterance. */
	editor?: {
		current: {
			writeDictation(committed: string, hypothesis: string, restart: boolean): void;
			cancelDictation(): void;
		} | null;
	};
	/** Transcript matched the submit trigger — auto-send path (sliced).
	 *  The draft itself is written through `editor`, never appended here: a
	 *  second writer is what scattered a continuous utterance. */
	onSubmit(text: string): void;
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
	// The words stay: dictation wrote them into the draft, and both the finished
	// and the failed paths keep whatever was actually recognized.
	const settle = useCallback((): void => {
		stopRef.current = null;
		setPhase("idle");
	}, []);

	// Discard: the user withdrew the utterance, so the draft must go back to
	// what it was before dictation wrote anything.
	const discard = useCallback((): void => {
		stopRef.current = null;
		optsRef.current.editor?.current?.cancelDictation();
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
			// Mic pressed again while transcribing = withdraw this utterance.
			cancelActiveDictation();
			discard();
			return;
		}
		setSeconds(0);
		setLevel(0);
		// The anchored region this dictation owns: committed words plus the run
		// still being recognized. Kept here (not in the editor) because the editor
		// only needs "write this composed text", while the split between committed
		// and provisional is a transcription concept.
		const spoken: { committed: string; hypothesis: string } = { committed: "", hypothesis: "" };
		// One region, rewritten in place. `restart` is true only for the first
		// write of a dictation: later writes must keep the origin it frozen, or
		// the region would slide and a phrase could land inside other text.
		let started = false;
		const write = (): void => {
			optsRef.current.editor?.current?.writeDictation(spoken.committed, spoken.hypothesis, !started);
			started = true;
		};
		const stop = startDictationOpts({
			rpc,
			deviceId: getVoiceInputDevice() ?? undefined,
			streaming: true,
			onPartial: text => {
				// The in-progress run replaces itself in place, so the phrase never
				// jumps ahead of the committed words it follows.
				spoken.hypothesis = text;
				write();
			},
			onSegment: text => {
				// A finished run joins the committed text and clears the provisional
				// copy — one region, rewritten once, never appended to the draft.
				spoken.committed = `${spoken.committed}${text}`;
				spoken.hypothesis = "";
				write();
			},
			onReview: transcript => {
				// Uncertain speaker match: keep it as a draft, no auto-send.
				if (!spoken.committed) {
					spoken.committed = transcript;
					write();
				}
				settle();
			},
			onFinal: transcript => {
				// The whole utterance is what was spoken — not just this last
				// transcript — so the submit decision and the sent text both use it.
				const utterance = spoken.committed + spoken.hypothesis || transcript;
				const { submit, trimTrailing } = evaluateSubmitTrigger(utterance, optsRef.current.sttSubmitTrigger);
				if (submit) {
					optsRef.current.onSubmit(utterance.slice(0, utterance.length - trimTrailing));
				} else if (!spoken.committed) {
					spoken.committed = transcript;
					write();
				}
				settle();
			},
			onEmpty: settle,
			onError: message => {
				settle();
				showError(message);
			},
			onState: activity => {
				if (activity.phase === "recording") {
					setPhase("recording");
					setSeconds(activity.seconds);
					setLevel(activity.level);
				} else if (activity.phase === "transcribing") {
					setPhase("transcribing");
				} else if (activity.phase === "stopped") {
					// cancelActiveDictation() path (Esc / mic-during-transcribe / unmount).
					discard();
				} else if (activity.phase === "error") {
					settle();
					showError(activity.message);
				}
			},
		});
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
			optsRef.current.editor?.current?.cancelDictation();
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
