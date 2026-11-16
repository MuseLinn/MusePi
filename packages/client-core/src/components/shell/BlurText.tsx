/**
 * Character-by-character blur-in text (reactbits BlurText parity,
 * zero-dependency): each char starts blurred/faded/dropped and settles in
 * sequence — see docs/gui-design.md §3. Plays once on mount; the
 * `gui-motion-off` class disables it wholesale (prefers-reduced-motion parity).
 *
 * Timing is CSS-only (a per-char `animation-delay`). The previous JS interval
 * never fired while the HarmonyOS ability was launching — ArkWeb throttles
 * timers in that window — so the brand name stayed at opacity 0. Touch shells
 * skip the animation entirely (shell.css), because a decorative reveal must
 * never gate text on a timer.
 */
import type React from "react";

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
	return (
		<span className={`gui-blur-text${className ? ` ${className}` : ""}`} aria-label={text} role="text">
			{text.split("").map((ch, i) => (
				<span key={i} className="gui-blur-char" style={{ animationDelay: `${i * stepMs}ms` }}>
					{ch}
				</span>
			))}
		</span>
	);
}
