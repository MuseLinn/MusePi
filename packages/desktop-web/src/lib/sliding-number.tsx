import { useEffect, useRef } from "react";

/**
 * Sliding-number (motion-primitives sliding-number parity, zero-dependency):
 * each digit is a vertical 0-9 strip; a rAF spring drives translateY so the
 * target digit rolls into view (the same spring physics — stiffness 280 /
 * damping 18 / mass 0.3 — integrated by hand instead of motion/react).
 * Rows are 1em tall (line-height 1), so the strip offset is pure em and no
 * measuring pass is needed. Digit strips write transform directly on the
 * DOM via refs — a React state per frame would re-render the whole subtree
 * (10 rows × N digits) and defeat the purpose.
 */

const SPRING = { stiffness: 280, damping: 18, mass: 0.3 };
// Spring settle tolerance (digit units): within a hair of target + stopped.
const SETTLE_EPS = 0.0005;

function Digit({ value, place }: { value: number; place: number }): React.ReactNode {
	const target = Math.floor(value / place) % 10;
	const stripRef = useRef<HTMLSpanElement>(null);
	const animRef = useRef({ y: target, target, v: 0 });

	useEffect(() => {
		animRef.current.target = target;
	}, [target]);

	useEffect(() => {
		const strip = stripRef.current;
		if (!strip) return;
		// Seed the strip at the resting position so a value swap that leaves
		// this digit unchanged never flashes a roll.
		strip.style.transform = `translateY(${-animRef.current.y}em)`;
		let raf = 0;
		let last = performance.now();
		const tick = (t: number): void => {
			const a = animRef.current;
			const dt = Math.min(0.05, (t - last) / 1000);
			last = t;
			// Semi-implicit Euler integration of the damped spring.
			const k = SPRING.stiffness / SPRING.mass;
			const c = SPRING.damping / SPRING.mass;
			a.v += (a.target - a.y) * k * dt;
			a.v *= 1 - Math.min(1, c * dt);
			a.y += a.v * dt;
			if (stripRef.current) {
				stripRef.current.style.transform = `translateY(${-a.y}em)`;
			}
			if (Math.abs(a.target - a.y) < SETTLE_EPS && Math.abs(a.v) < SETTLE_EPS) {
				a.y = a.target;
				a.v = 0;
				return;
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);

	return (
		<span
			className="gui-sliding-digit"
			style={{
				position: "relative",
				display: "inline-block",
				width: "1ch",
				overflow: "hidden",
				verticalAlign: "baseline",
				lineHeight: 1,
				fontVariantNumeric: "tabular-nums",
			}}
		>
			{/* Invisible spacer pins the digit box height to one row. */}
			<span style={{ visibility: "hidden", display: "block", lineHeight: 1 }}>0</span>
			<span
				ref={stripRef}
				style={{
					position: "absolute",
					insetInlineStart: 0,
					top: 0,
					display: "flex",
					flexDirection: "column",
					willChange: "transform",
				}}
			>
				{Array.from({ length: 10 }, (_, i) => (
					<span key={i} style={{ display: "block", height: "1em", lineHeight: 1, textAlign: "center" }}>
						{i}
					</span>
				))}
			</span>
		</span>
	);
}

export function SlidingNumber({
	value,
	padStart = false,
	decimalSeparator = ".",
	decimals,
}: {
	value: number;
	/** Zero-pad integers below 10 to two digits (timer-style). */
	padStart?: boolean;
	decimalSeparator?: string;
	/** Fixed decimal places (toFixed semantics — keeps trailing zeros). */
	decimals?: number;
}): React.ReactNode {
	const abs = Math.abs(value);
	const fixed = decimals !== undefined ? abs.toFixed(decimals) : abs.toString();
	const [intPart, decPart] = fixed.split(".");
	const intValue = Number(intPart);
	const padded = padStart && intValue < 10 ? `0${intPart}` : intPart;
	const intPlaces = padded.split("").map((_, i) => 10 ** (padded.length - i - 1));
	return (
		<span
			className="gui-sliding-number"
			style={{ display: "inline-flex", alignItems: "baseline", fontVariantNumeric: "tabular-nums" }}
		>
			{value < 0 ? "-" : null}
			{intPlaces.map(p => (
				<Digit key={`i${p}`} value={intValue} place={p} />
			))}
			{decPart !== undefined && (
				<>
					<span>{decimalSeparator}</span>
					{decPart.split("").map((_, i) => (
						<Digit key={`d${i}`} value={Number(decPart)} place={10 ** (decPart.length - i - 1)} />
					))}
				</>
			)}
		</span>
	);
}
