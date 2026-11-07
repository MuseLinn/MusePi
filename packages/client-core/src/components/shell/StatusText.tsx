import { type ReactNode, useEffect, useRef, useState } from "react";

/** The two motion-off sources, matching BlurText's runtime check. A disabled
 *  host must swap copy instantly: with `animation:none` there is no
 *  animationend to retire a leaving layer, so JS has to skip it entirely. */
function motionOff(): boolean {
	if (typeof document === "undefined") return false;
	return (
		document.documentElement.classList.contains("gui-motion-off") ||
		(typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true)
	);
}

/**
 * One status line that cross-fades when its copy changes. The outgoing and
 * incoming strings share a single grid cell, so a state change never moves
 * the surrounding layout. Durations read the §3 motion tokens and the
 * `gui-motion-off` / `prefers-reduced-motion` paths swap with no frames.
 *
 * `role="status"` sits on the wrapper and the leaving copy is `aria-hidden`,
 * so assistive tech announces each state exactly once. `text: null` clears
 * the line while its previous copy still fades out.
 */
export function StatusText({ text, className }: { text: string | null; className?: string }): ReactNode {
	const [current, setCurrent] = useState(text);
	const [leaving, setLeaving] = useState<string | null>(null);
	const previous = useRef(text);

	useEffect(() => {
		if (previous.current === text) return;
		const outgoing = previous.current;
		previous.current = text;
		if (motionOff()) {
			setLeaving(null);
			setCurrent(text);
			return;
		}
		setLeaving(outgoing);
		setCurrent(text);
	}, [text]);

	return (
		<span className={`gui-status-text${className ? ` ${className}` : ""}`} role="status" aria-live="polite">
			<span className="gui-status-text-stack">
				{leaving !== null && (
					<span
						key={leaving}
						className="gui-status-text-leaving"
						aria-hidden="true"
						onAnimationEnd={() => setLeaving(null)}
					>
						{leaving}
					</span>
				)}
				{current !== null && (
					<span key={current} className="gui-status-text-current">
						{current}
					</span>
				)}
			</span>
		</span>
	);
}
