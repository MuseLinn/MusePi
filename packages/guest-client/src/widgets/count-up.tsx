import { useEffect, useRef, useState } from "react";

/**
 * Number-roll counter (reactbits CountUp parity, zero-dependency): when
 * `value` changes the displayed number eases from the previous value over
 * `duration` ms (ease-out cubic). `format` owns the localized rendering —
 * the same formatter the caller used for static text, so a plain value
 * swap and a rolled value never disagree. Callers render the "empty"
 * placeholder themselves when the value is null.
 */
export function CountUp({
	value,
	format,
	duration = 500,
}: {
	value: number;
	format(n: number): string;
	duration?: number;
}): React.ReactNode {
	const [display, setDisplay] = useState<number>(value);
	const prevRef = useRef<number>(value);

	useEffect(() => {
		const prev = prevRef.current;
		prevRef.current = value;
		if (prev === value) {
			setDisplay(value);
			return;
		}
		const start = performance.now();
		let raf = 0;
		const step = (t: number): void => {
			const k = Math.min(1, (t - start) / duration);
			const eased = 1 - (1 - k) ** 3; // easeOutCubic
			setDisplay(prev + (value - prev) * eased);
			if (k < 1) raf = requestAnimationFrame(step);
			else setDisplay(value);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [value, duration]);

	return <>{format(Math.round(display))}</>;
}
