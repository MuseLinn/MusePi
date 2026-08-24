import { useEffect, useState } from "react";

/**
 * Character-by-character blur-in text (reactbits BlurText parity,
 * zero-dependency): each char starts blurred/faded/dropped and settles in
 * sequence via CSS transitions (the 240ms/160ms motion convention — see
 * docs/gui-design.md §3). Plays once on mount; the `gui-motion-off` class
 * disables it wholesale (prefers-reduced-motion parity).
 */
export function BlurText({
	text,
	className,
	stepMs = 45,
}: {
	text: string;
	className?: string;
	/** Per-char stagger, ms. */
	stepMs?: number;
}): React.ReactNode {
	const [revealed, setRevealed] = useState(0);

	useEffect(() => {
		let i = 0;
		setRevealed(0);
		const id = window.setInterval(() => {
			i += 1;
			setRevealed(i);
			if (i >= text.length) window.clearInterval(id);
		}, stepMs);
		return () => window.clearInterval(id);
	}, [text, stepMs]);

	return (
		<span className={`gui-blur-text${className ? ` ${className}` : ""}`} aria-label={text} role="text">
			{text.split("").map((ch, i) => (
				<span key={i} className={`gui-blur-char${i < revealed ? " gui-blur-char--in" : ""}`}>
					{ch}
				</span>
			))}
		</span>
	);
}
