import { useEffect, useRef, useState } from "react";

/**
 * TextMorph (motion-primitives text-morph parity, zero-dependency): when
 * `text` changes, the outgoing text rolls up character-by-character while
 * the incoming text rolls in beneath it (CSS animations, no motion/react —
 * see docs/gui-design.md §3 for the 240ms/160ms motion convention). A
 * character that is identical in both layers keeps its grid position, so a
 * word like Send→Sending reads as a continuation, not a hard swap. The
 * `gui-motion-off` class disables it wholesale (prefers-reduced-motion
 * parity, same as BlurText).
 */
export function TextMorph({
	text,
	className,
	stepMs = 24,
	durationMs = 240,
}: {
	text: string;
	className?: string;
	/** Per-char stagger between adjacent characters, ms. */
	stepMs?: number;
	/** Per-char roll duration, ms. */
	durationMs?: number;
}): React.ReactNode {
	const [display, setDisplay] = useState(text);
	const [leaving, setLeaving] = useState<string | null>(null);
	// Track the last committed text so the effect doesn't re-run on
	// unrelated renders (text is the only dependency).
	const lastRef = useRef(text);
	useEffect(() => {
		if (text === lastRef.current) return;
		lastRef.current = text;
		setLeaving(display);
		setDisplay(text);
		const total = durationMs + stepMs * Math.max(display.length, text.length);
		const timer = window.setTimeout(() => setLeaving(null), total);
		return () => window.clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text]);

	const chars = (s: string): React.ReactNode =>
		s.split("").map((ch, i) => (
			<span
				key={`${i}:${ch}`}
				className="gui-text-morph__char"
				style={{ animationDelay: `${i * stepMs}ms`, animationDuration: `${durationMs}ms` }}
			>
				{ch === " " ? "\u00A0" : ch}
			</span>
		));

	return (
		<span className={`gui-text-morph${className ? ` ${className}` : ""}`} aria-label={text} role="text">
			{leaving !== null && (
				<span className="gui-text-morph__layer gui-text-morph__layer--out" aria-hidden="true">
					{chars(leaving)}
				</span>
			)}
			<span className="gui-text-morph__layer gui-text-morph__layer--in">{chars(display)}</span>
		</span>
	);
}
