const LINE_PX = 20;
const PAD_Y = 16;
/** Minimum textarea rows; shared with the session composer markup. */
export const MIN_ROWS = 2;
const MAX_ROWS = 8;

/** Shared by the session and welcome composers. */
export function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	if (el.dataset.focused === "1") {
		// Focus mode: the flex layout fills the surface — don't fight it.
		el.style.height = "100%";
		el.style.overflowY = "auto";
		return;
	}
	const max = MAX_ROWS * LINE_PX + PAD_Y;
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
	const target = Math.max(MIN_ROWS * LINE_PX + PAD_Y, Math.min(el.scrollHeight, max));
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
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
