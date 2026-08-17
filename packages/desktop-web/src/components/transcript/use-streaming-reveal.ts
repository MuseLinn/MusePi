import { useEffect, useRef, useState } from "react";
import {
	BlockUnitCounter,
	nextRevealPosition,
	sliceGraphemes,
} from "./reveal";

/**
 * Character-level reveal for a streaming text block (the 平滑流式渲染
 * setting). Returns the prefix of `text` to display right now.
 *
 * - `text` grows as model chunks arrive → the counter re-segments only the
 *   appended tail and the reveal catches up over ~8 rAF frames (proportional
 *   drain — a token burst is absorbed smoothly, never popped whole, and a
 *   slow model advances one grapheme per frame).
 * - `streaming` false → the message settled, show everything immediately.
 * - `enabled` false → the setting is off, show everything immediately
 *   (checked on every tick, so toggling mid-stream applies on the next frame).
 * - `resetKey` change → reveal restarts from 0 (preview loops).
 */
export function useStreamingReveal(
	text: string,
	streaming: boolean,
	enabled: boolean,
	resetKey = 0,
): string {
	const [revealed, setRevealed] = useState(0);
	const counterRef = useRef<BlockUnitCounter | null>(null);
	if (counterRef.current === null) counterRef.current = new BlockUnitCounter();
	const revealedRef = useRef(0);
	const textRef = useRef(text);
	const streamingRef = useRef(streaming);
	const enabledRef = useRef(enabled);
	const rafRef = useRef<number | null>(null);

	streamingRef.current = streaming;
	enabledRef.current = enabled;

	const stopRaf = () => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
	};

	// Restart on resetKey (preview loop).
	useEffect(() => {
		revealedRef.current = 0;
		setRevealed(0);
		textRef.current = text;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [resetKey]);

	// Target grew (or reset): keep the monotonic prefix, resume the rAF loop.
	useEffect(() => {
		textRef.current = text;
		const counter = counterRef.current!;
		const total = counter.count(0, text);
		if (!enabledRef.current || !streamingRef.current) {
			revealedRef.current = total;
			setRevealed(total);
			return;
		}
		if (revealedRef.current > total) revealedRef.current = total;
		if (revealedRef.current < total && rafRef.current === null) {
			const tick = (): void => {
				const t = textRef.current;
				const c = counterRef.current!;
				const tot = c.count(0, t);
				if (!enabledRef.current || !streamingRef.current || revealedRef.current >= tot) {
					revealedRef.current = tot;
					setRevealed(tot);
					rafRef.current = null;
					return;
				}
				revealedRef.current = nextRevealPosition(revealedRef.current, tot);
				setRevealed(revealedRef.current);
				if (revealedRef.current >= tot) {
					rafRef.current = null;
				} else {
					rafRef.current = requestAnimationFrame(tick);
				}
			};
			rafRef.current = requestAnimationFrame(tick);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text, resetKey]);

	// Message settled: reveal everything and stop.
	useEffect(() => {
		if (!streaming) {
			const counter = counterRef.current!;
			const total = counter.count(0, textRef.current);
			revealedRef.current = total;
			setRevealed(total);
			stopRaf();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [streaming]);

	useEffect(() => stopRaf, []);

	const counter = counterRef.current;
	const total = counter.count(0, text);
	// Render-time short-circuit: settled text (or the reveal disabled)
	// shows everything immediately. Effects don't run during SSR, so
	// without this the first server render of a settled message would be
	// an empty prefix (transcript SSR tests caught this regression).
	if (!streaming || !enabled) return text;
	return revealed >= total ? text : sliceGraphemes(text, revealed);
}
