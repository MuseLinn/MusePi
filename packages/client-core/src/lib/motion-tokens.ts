/**
 * The one-take motion pair, read from the CSS tokens so WAAPI animations and
 * stylesheet transitions cannot drift apart.
 *
 * Web Animations cannot resolve a CSS custom property in its options, so the
 * values are read once per call; the fallback is the documented pair, used on
 * hosts without styles (tests, plain DOM fixtures).
 */
export interface OneTakeMotion {
	durationMs: number;
	easing: string;
}

const FALLBACK: OneTakeMotion = { durationMs: 280, easing: "cubic-bezier(0.2, 0, 0.2, 1)" };

export function oneTakeMotion(): OneTakeMotion {
	if (typeof document === "undefined") return FALLBACK;
	const style = getComputedStyle(document.documentElement);
	const parsed = Number.parseFloat(style.getPropertyValue("--duration-one-take"));
	return {
		durationMs: Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK.durationMs,
		easing: style.getPropertyValue("--ease-one-take").trim() || FALLBACK.easing,
	};
}
/** The exit curve for chrome that leaves; mirrors `--ease-dismiss`. */
export function dismissEasing(): string {
	if (typeof document === "undefined") return "cubic-bezier(0.8, 0, 0.4, 1)";
	return (
		getComputedStyle(document.documentElement).getPropertyValue("--ease-dismiss").trim() ||
		"cubic-bezier(0.8, 0, 0.4, 1)"
	);
}
