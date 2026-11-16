/**
 * Origin of the containing block that `position: fixed` resolves against.
 *
 * A `fixed` box normally positions against the viewport, so `top: 120px` means
 * 120px from the window's top. A few ancestor properties replace that with the
 * ancestor's own padding box: `transform`, `filter`, `backdrop-filter`,
 * `perspective`, `contain: paint`, and `will-change` naming any of those.
 *
 * Only those establish a containing block for `fixed`. `will-change` naming
 * something else (e.g. `opacity`) does NOT, and neither does `contain` without
 * `paint`/`layout`/`strict`/`content` — treating those as containing blocks
 * over-corrects and pushes a seam off by the ancestor's origin (measured: a
 * seam that belongs at 745.4 was written as 421.4, exactly −324).
 *
 * Returns `{x, y}` in viewport coordinates; `{x: 0, y: 0}` when the viewport
 * itself is the containing block, which is the common case.
 */
const WILL_CHANGE_PROPS = ["transform", "filter", "backdrop-filter", "perspective"];

export function containingBlockOrigin(element: Element): { x: number; y: number } {
	let node: Element | null = element.parentElement;
	while (node && node !== document.documentElement) {
		const style = getComputedStyle(node);
		const willChange = style.willChange ?? "";
		const establishes =
			(style.transform && style.transform !== "none") ||
			(style.filter && style.filter !== "none") ||
			(style.backdropFilter && style.backdropFilter !== "none") ||
			(style.perspective && style.perspective !== "none") ||
			/paint|layout|strict|content/.test(style.contain ?? "") ||
			WILL_CHANGE_PROPS.some(prop => willChange.includes(prop));
		if (establishes) {
			const rect = node.getBoundingClientRect();
			return { x: rect.left, y: rect.top };
		}
		node = node.parentElement;
	}
	return { x: 0, y: 0 };
}
