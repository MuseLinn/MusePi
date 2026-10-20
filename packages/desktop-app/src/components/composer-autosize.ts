import { getComposerHeightLimit, isComposerContentCapped } from "./composer-height-limit";

const LINE_PX = 20;
const PAD_Y = 16;
/** Minimum textarea rows; shared with the session composer markup. */
export const MIN_ROWS = 2;
const MAX_ROWS = 8;

/**
 * Breathing room between the composer's top edge and the surface it floats
 * over — enough that the fade band reads as glass rather than as a cut.
 */
const BOUND_GAP_PX = 96;

/**
 * The height cap for this textarea, in px.
 *
 * The line cap is what keeps the input an input rather than a document. The
 * available-height cap is what keeps it from eating the conversation on a short
 * window: the composer now floats over the transcript, so eight rows of input on
 * a short pane would leave nothing to read.
 *
 * Resolved by walking up to the chat body rather than passed in, because every
 * autosize call site already holds the element and only some of them know the
 * layout. One extra layout read per autosize, which already measures twice.
 */
function heightCap(el: HTMLTextAreaElement): number {
	const lineCap = MAX_ROWS * LINE_PX + PAD_Y;
	const bound = el.closest<HTMLElement>(".gui-chat-body");
	if (!bound) return lineCap;
	const transcript = bound.querySelector<HTMLElement>(".gui-transcript");
	return getComposerHeightLimit({
		maxLinesHeight: lineCap,
		boundHeight: bound.clientHeight,
		surroundingHeight: transcript?.offsetHeight ?? 0,
		boundGapPx: BOUND_GAP_PX,
	});
}

/** Shared by the session and welcome composers. */
export function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	if (el.dataset.focused === "1") {
		// Focus mode: the flex layout fills the surface — don't fight it.
		el.style.height = "100%";
		el.style.overflowY = "auto";
		return;
	}
	const max = heightCap(el);
	// Measure the content height with transitions OFF. While a height
	// transition is running (fast typing, then clearing), the computed
	// height sits at its interpolated value and scrollHeight reads as
	// max(content, client) — the stale LARGE height — so shrinking never
	// fires. With the probe transition-free the computed height is really
	// 0 and scrollHeight reflects the content only.
	el.style.transition = "none";
	const from = el.getBoundingClientRect().height;
	el.style.height = "0px";
	void el.offsetHeight;
	const contentHeight = el.scrollHeight;
	const target = Math.max(MIN_ROWS * LINE_PX + PAD_Y, Math.min(contentHeight, max));
	// A scrollbar only when the content genuinely overflows: content that exactly
	// fits still reports a pixel or two (the drawn caret, font metrics,
	// rounding), and that sliver is a control that cannot scroll anywhere.
	el.style.overflowY = isComposerContentCapped(contentHeight, max, LINE_PX) ? "auto" : "hidden";
	if (Math.abs(target - from) < 1) {
		// No size change (same line count): restore the height while
		// transitions are still disabled AND commit it with a reflow —
		// re-enabling without it would animate from the probe's rendered
		// frame (0 + padding) to `from` on EVERY keystroke.
		el.style.height = `${from}px`;
		void el.offsetHeight;
		el.style.transition = "";
		return;
	}
	// Size change: still transition-free, back to the rendered height and
	// commit it, then re-enable the transition and set the target — ONE
	// from → target animation (the 0px probe never paints).
	el.style.height = `${from}px`;
	void el.offsetHeight;
	el.style.transition = "";
	el.style.height = `${target}px`;
}
