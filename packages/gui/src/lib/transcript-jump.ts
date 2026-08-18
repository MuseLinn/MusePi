/**
 * Transcript scroll-to-entry jump (shared by MessageTree rows and the
 * ContextPanel trajectory tree): entries render with `title=<timestamp>`,
 * so a querySelector by escaped timestamp scrolls the matching row into
 * view. Windowed history means the row may not be mounted — then scroll to
 * the top (the oldest mounted spacer).
 */
export function scrollToEntry(scroller: HTMLElement | null, timestamp: string): boolean {
	if (!scroller) return false;
	const el = scroller.querySelector<HTMLElement>(`[title="${CSS.escape(timestamp)}"]`);
	if (el) {
		el.scrollIntoView({ block: "start", behavior: "smooth" });
		return true;
	}
	scroller.scrollTo({ top: 0, behavior: "smooth" });
	return false;
}
