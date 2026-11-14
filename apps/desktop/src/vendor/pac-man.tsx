import type { ReactNode } from "react";

/**
 * Pac-man glyph — a true vector pac-man: a yellow disc with the mouth CUT
 * OUT (transparent, showing whatever is behind it), plus one eye placed
 * clear of the mouth cone. Renders crisp at any size; the mouth chomps via
 * a 3-frame sprite (three body paths alternating opacity — SVG paths can't
 * be interpolated by CSS without a registered `d`).
 *
 * Mouth frame selection:
 * - `mouth` 0..1 drives the static body cutout (TurnRail hover states).
 * - `animating` renders the three chomp frames instead of the rest body;
 *   the `.pac-chomp` class cycles them (open → mid → closed → …).
 */
export function PacMan({
	size,
	side = "right",
	mouth = 0.5,
	animating = false,
	className,
}: {
	size: number;
	/** Which way the mouth faces. */
	side?: "left" | "right" | "down";
	/** 0 (closed) .. 1 (fully open). */
	mouth?: number;
	/** Animate the chomping cycle. */
	animating?: boolean;
	className?: string;
}): ReactNode {
	// Pac body in a 24x24 viewBox (r=10 disc at 12,12). `halfAngle` is half
	// the mouth opening in radians: the path runs from the lower rim point
	// (+halfAngle) the LONG way round (through the left side) to the upper
	// rim point (-halfAngle), so the yellow keeps its round profile and the
	// missing sector is the mouth — transparent, not painted dark. A dark
	// wedge painted on top of a full disc (the previous render) read as a
	// muddy blob at 12px; the cutout reads as pac-man at any size.
	const body = (halfAngle: number): string => {
		const x1 = 12 + 10 * Math.cos(halfAngle);
		const y1 = 12 + 10 * Math.sin(halfAngle);
		const x2 = 12 + 10 * Math.cos(-halfAngle);
		const y2 = 12 + 10 * Math.sin(-halfAngle);
		const a = `M12 12 L${x1.toFixed(2)} ${y1.toFixed(2)}`;
		const b = `A10 10 0 1 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
		return `${a} ${b}`;
	};
	// mouth 1 -> halfAngle about 1.0 rad (the classic wide open chomp);
	// mouth 0 -> a hairline 0.05 rad slit.
	const rest = body(0.02 + mouth * 0.98);
	const fOpen = body(1.0); // wide open
	const fMid = body(0.45); // half
	const fClosed = body(0.05); // nearly closed

	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			className={className}
			role="img"
			aria-hidden="true"
			style={
				side === "left"
					? { transform: "scaleX(-1)" }
					: side === "down"
						? { transform: "rotate(90deg)" }
						: undefined
			}
		>
			{animating ? (
				<>
					{/* Chomp frames — CSS cycles their opacity while .pac-chomp
					 * runs. The rest body is not rendered here: leaving it under
					 * the frames doubled the mouth edges and muddied the glyph. */}
					<path d={fOpen} className="pac-mouth pac-chomp pac-mouth-f0" fill="#ffd94d" />
					<path d={fMid} className="pac-mouth pac-chomp pac-mouth-f1" fill="#ffd94d" />
					<path d={fClosed} className="pac-mouth pac-chomp pac-mouth-f2" fill="#ffd94d" />
					{/* Eye stays clear of the wide-open mouth cone (rim reaches
					 * x about 17.4 at y about 3.6/20.4): centred on top. */}
					<circle cx="12" cy="6" r="2" fill="#201a14" />
				</>
			) : (
				<>
					<path d={rest} className="pac-mouth-rest" fill="#ffd94d" />
					<circle cx="12" cy="6" r="2" fill="#201a14" />
				</>
			)}
		</svg>
	);
}
