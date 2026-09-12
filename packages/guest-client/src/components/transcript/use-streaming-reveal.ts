import { useEffect, useRef, useState } from "react";
import { BlockUnitCounter, nextDrainPosition, nextRevealPosition } from "./reveal";

/**
 * Character-level reveal for a streaming text block (the 平滑流式渲染
 * setting). Returns the prefix of `text` to display right now.
 *
 * - Mounting reveals nothing: the block starts at the end of the text it was
 *   mounted with. A block that mounts settled (history message, session
 *   switch) shows in full — it was never animated text from this component's
 *   point of view — and one that mounts mid-stream shows its current text in
 *   full, animating only what arrives afterwards.
 * - `text` grows as model chunks arrive → the counter re-segments only the
 *   appended tail and the reveal catches up over ~8 rAF frames (proportional
 *   drain — a token burst is absorbed smoothly, never popped whole, and a
 *   slow model advances one grapheme per frame).
 * - `streaming` false → the message settled. The remaining backlog DRAINS at a
 *   fixed rate rather than appearing at once: the old instant reveal made the
 *   tail pop (smooth mid-stream, then everything in one frame).
 * - `enabled` false → the setting is off, show everything immediately
 *   (checked on every tick, so toggling mid-stream applies on the next frame).
 * - `resetKey` change → reveal restarts from 0 (preview loops).
 */
export function useStreamingReveal(text: string, streaming: boolean, enabled: boolean, resetKey = 0): string {
	const counterRef = useRef<BlockUnitCounter | null>(null);
	if (counterRef.current === null) counterRef.current = new BlockUnitCounter();
	// Mount starts at the END of this block's text. The text existed before the
	// component did — a history message, or a live message re-mounted by a
	// session switch — so revealing from 0 re-types text the user has already
	// read, and the settle drain below then treats the whole committed message
	// as backlog. Only text that GROWS after mount animates; previews still
	// replay from 0 via `resetKey`.
	const [revealed, setRevealed] = useState(() => counterRef.current!.count(0, text));
	const revealedRef = useRef(revealed);
	const textRef = useRef(text);
	const streamingRef = useRef(streaming);
	const enabledRef = useRef(enabled);
	const rafRef = useRef<number | null>(null);
	/** Producer stopped but the tail is still draining (fixed-rate settle). */
	const drainingRef = useRef(false);
	const [draining, setDraining] = useState(false);

	streamingRef.current = streaming;
	enabledRef.current = enabled;

	const stopRaf = () => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
	};

	// Restart on a resetKey CHANGE (preview loops). The effect's first run is the
	// mount itself — resetting there would undo the mount rule above and re-type
	// the whole block, so only a real key change restarts the reveal.
	const resetKeyRef = useRef(resetKey);
	useEffect(() => {
		if (resetKeyRef.current === resetKey) return;
		resetKeyRef.current = resetKey;
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
		if (!enabledRef.current) {
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
				if (!enabledRef.current || revealedRef.current >= tot) {
					revealedRef.current = tot;
					setRevealed(tot);
					rafRef.current = null;
					return;
				}
				// Producer running → proportional catch-up; producer stopped →
				// fixed-rate drain so the tail keeps the reading cadence instead
				// of snapping (see reveal.ts nextDrainPosition).
				revealedRef.current = streamingRef.current
					? nextRevealPosition(revealedRef.current, tot)
					: nextDrainPosition(revealedRef.current, tot);
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

	// Message settled: drain what is left instead of snapping to the end. The
	// loop keeps running (now on the fixed-rate step) until it catches up.
	useEffect(() => {
		if (streaming) return;
		const counter = counterRef.current!;
		const total = counter.count(0, textRef.current);
		if (revealedRef.current >= total) {
			drainingRef.current = false;
			setDraining(false);
			stopRaf();
			return;
		}
		if (!enabledRef.current || typeof requestAnimationFrame !== "function") {
			revealedRef.current = total;
			setRevealed(total);
			stopRaf();
			return;
		}
		drainingRef.current = true;
		setDraining(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [streaming]);

	// Clear the draining flag once the loop has caught up.
	useEffect(() => {
		if (!draining) return;
		const counter = counterRef.current!;
		if (revealed >= counter.count(0, textRef.current)) {
			drainingRef.current = false;
			setDraining(false);
		}
	}, [revealed, draining]);

	useEffect(() => stopRaf, []);

	const counter = counterRef.current;
	const total = counter.count(0, text);
	// Render-time short-circuit: settled text (or the reveal disabled) shows
	// everything immediately — EXCEPT while a settle drain is still running, or
	// the tail would pop. Effects don't run during SSR, so a settled message's
	// first server render still returns the full text (transcript SSR tests
	// caught that regression before).
	if (!enabled) return text;
	if (!streaming && !draining) return text;
	if (revealed >= total) return text;
	// Memoized slice: streaming blocks grow by appending and the reveal target
	// advances monotonically, so only the suffix beyond the previous boundary is
	// re-segmented. The stateless sliceGraphemes re-segmented the whole prefix
	// every frame.
	return counter.slice(0, text, revealed);
}
