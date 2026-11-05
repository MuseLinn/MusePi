/**
 * Highlights for quoted fragments inside the transcript, painted with the CSS
 * Custom Highlight API so the rendered markdown itself is never touched.
 *
 * Every chat quote that carries an anchor keeps its source fragment softly
 * marked. Clicking a quote card reveals it: the transcript jumps to the source
 * message through the existing entry jump, and this layer scrolls the fragment
 * into place and flashes it once. While the source row is unmounted (a
 * virtualized-away message, or history still paging in), the reveal is retried
 * for a bounded window; if the anchor never resolves, the jump still lands on
 * the message itself.
 *
 * Ranges are re-resolved from their anchors whenever a marked message mounts,
 * unmounts or re-renders, so streaming rewrites and windowing cannot leave a
 * stale highlight behind. Runtimes without `CSS.highlights` still jump, just
 * without the mark.
 */

import type { ChatQuoteAnchor } from "@musepi/pi-wire";
import { memo, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { type ChatQuoteMark, findQuoteRoot, resolveQuoteAnchor } from "./quote-anchor";

const MARK_HIGHLIGHT = "musepi-quote";
const FOCUS_HIGHLIGHT = "musepi-quote-focus";
const FLASH_MS = 1600;
/** Retry cadence while a revealed row is still paging/mounting in. */
const REVEAL_RETRY_MS = 120;
/** Give up anchoring after this long; the message-level jump already landed. */
const REVEAL_TIMEOUT_MS = 8000;
/** Room above the revealed fragment for the chat's top chrome. */
const REVEAL_TOP_INSET = 96;

type PaintOwner = symbol;

const paintedRanges = new Map<string, Map<PaintOwner, Range[]>>();

function supportsHighlights(): boolean {
	return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
}

function paint(name: string, owner: PaintOwner, ranges: Range[]): void {
	if (!supportsHighlights()) return;
	const owners = paintedRanges.get(name) ?? new Map<PaintOwner, Range[]>();
	if (ranges.length > 0) owners.set(owner, ranges);
	else owners.delete(owner);
	paintedRanges.set(name, owners);
	const all = [...owners.values()].flat();
	if (all.length === 0) {
		CSS.highlights.delete(name);
		return;
	}
	const highlight = new Highlight(...all);
	highlight.priority = name === FOCUS_HIGHLIGHT ? 1 : 0;
	CSS.highlights.set(name, highlight);
}

export interface QuoteReveal {
	/** Entry id of the quoted message. */
	entryId: string;
	anchor: ChatQuoteAnchor;
}

const revealSubscribers = new Set<(reveal: QuoteReveal) => void>();

/**
 * Ask every mounted transcript to reveal this anchored fragment. Called before
 * the message-level jump so the row mounts under the pending reveal.
 */
export function requestQuoteReveal(reveal: QuoteReveal): void {
	for (const subscriber of revealSubscribers) subscriber(reveal);
}

/** Scroll the fragment into view inside the transcript's own scroller. */
function scrollRangeIntoView(root: HTMLElement, range: Range): void {
	// SAFETY: a range boundary inside a rendered row is either an Element or a
	// Text node whose parent is one.
	const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
	if (!start) return;
	const scroller = root.closest<HTMLElement>(".gui-transcript") ?? root;
	const rect = start.getBoundingClientRect();
	const scrollerRect = scroller.getBoundingClientRect();
	const top = rect.top - scrollerRect.top + scroller.scrollTop - REVEAL_TOP_INSET;
	scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

export const QuoteHighlightLayer = memo(function QuoteHighlightLayer({
	rootRef,
	marks,
}: {
	rootRef: RefObject<HTMLElement | null>;
	marks: readonly ChatQuoteMark[];
}): null {
	const [root, setRoot] = useState<HTMLElement | null>(null);
	const [owner] = useState<PaintOwner>(() => Symbol("musepi-quote-layer"));
	const marksRef = useRef(marks);
	marksRef.current = marks;
	const flashTimerRef = useRef<number | null>(null);
	const retryTimerRef = useRef<number | null>(null);
	const pendingRef = useRef<(QuoteReveal & { deadline: number }) | null>(null);

	// The root's callback ref is attached before this component's effects run.
	useEffect(() => {
		setRoot(rootRef.current);
	}, [rootRef]);

	const flash = useCallback(
		(range: Range) => {
			if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
			paint(FOCUS_HIGHLIGHT, owner, [range]);
			flashTimerRef.current = window.setTimeout(() => {
				flashTimerRef.current = null;
				paint(FOCUS_HIGHLIGHT, owner, []);
			}, FLASH_MS);
		},
		[owner],
	);

	useEffect(() => {
		if (!root || marks.length === 0) return;
		let frame: number | null = null;
		const repaint = (): void => {
			frame = null;
			const ranges: Range[] = [];
			for (const mark of marksRef.current) {
				const body = findQuoteRoot(root, mark.entryId);
				const range = body ? resolveQuoteAnchor(body, mark.anchor) : null;
				if (range) ranges.push(range);
			}
			paint(MARK_HIGHLIGHT, owner, ranges);
		};
		// Streaming rewrites the live row continuously; coalesce to one paint per
		// frame instead of one per mutation record.
		const observer = new MutationObserver(() => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(repaint);
		});
		observer.observe(root, { childList: true, subtree: true, characterData: true });
		repaint();
		return () => {
			observer.disconnect();
			if (frame !== null) window.cancelAnimationFrame(frame);
			paint(MARK_HIGHLIGHT, owner, []);
		};
	}, [marks, owner, root]);

	useEffect(() => {
		if (!root) return;
		const attempt = (): void => {
			retryTimerRef.current = null;
			const pending = pendingRef.current;
			if (!pending) return;
			const body = findQuoteRoot(root, pending.entryId);
			const range = body ? resolveQuoteAnchor(body, pending.anchor) : null;
			if (range) {
				pendingRef.current = null;
				scrollRangeIntoView(root, range);
				flash(range);
				return;
			}
			if (Date.now() >= pending.deadline) {
				pendingRef.current = null;
				return;
			}
			retryTimerRef.current = window.setTimeout(attempt, REVEAL_RETRY_MS);
		};
		const onReveal = (reveal: QuoteReveal): void => {
			pendingRef.current = { ...reveal, deadline: Date.now() + REVEAL_TIMEOUT_MS };
			attempt();
		};
		revealSubscribers.add(onReveal);
		return () => {
			revealSubscribers.delete(onReveal);
			pendingRef.current = null;
			if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		};
	}, [flash, root]);

	useEffect(
		() => () => {
			if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
			paint(FOCUS_HIGHLIGHT, owner, []);
		},
		[owner],
	);

	return null;
});
