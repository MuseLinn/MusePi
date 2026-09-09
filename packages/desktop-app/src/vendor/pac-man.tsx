import type { ReactNode } from "react";

/**
 * Pac-man glyph — a classic vector pac-man: yellow disc, one big eye on
 * the mouth side, and a SECTOR mouth (an arc cut, not the previous wedge
 * triangle that read as a plain notch at small sizes). Renders crisp at
 * any size; the mouth chomps via a 3-frame sprite (three sector paths
 * alternating opacity — SVG paths can't be interpolated by CSS without a
 * registered `d`).
 *
 * Mouth frame selection:
 * - `mouth` 0..1 drives the static sector angle (TurnRail hover states).
 * - `animating` adds the `.pac-chomp` class → the CSS animation cycles
 *   the three sectors (open → mid → closed → …) while it runs.
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
	// Sector mouth in a 24×24 viewBox (r=10 disc at 12,12). `halfAngle` is
	// half the mouth opening in radians: the sector runs from the lower
	// rim point (12+halfAngle) to the upper rim point (−halfAngle) through
	// the right rim, so the disc keeps its round profile and the cut is a
	// true pac-man wedge with an arc edge.
	const sector = (halfAngle: number): string => {
		const x1 = 12 + 10 * Math.cos(halfAngle);
		const y1 = 12 + 10 * Math.sin(halfAngle);
		const x2 = 12 + 10 * Math.cos(-halfAngle);
		const y2 = 12 + 10 * Math.sin(-halfAngle);
		return `M12 12 L${x1.toFixed(2)} ${y1.toFixed(2)} A10 10 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
	};
	// mouth 1 → halfAngle ≈ 1.0 rad (~57°, the classic wide open chomp);
	// mouth 0 → a hairline 0.05 rad slit.
	const rest = sector(0.02 + mouth * 0.98);
	const fOpen = sector(1.0); // wide open
	const fMid = sector(0.45); // half
	const fClosed = sector(0.05); // nearly closed

	const mouthClass = `pac-mouth${animating ? " pac-chomp" : ""}`;
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
			<circle cx="12" cy="12" r="10" fill="#ffd94d" />
			{/* Classic eye: one black disc on the mouth side, above the
			 * opening — the wedge's arc edge frames it. */}
			<circle cx="15.8" cy="7.4" r="2.1" fill="#201a14" />
			{/* Static rest sector (shown when not animating) */}
			<path d={rest} className="pac-mouth-rest" fill="#201a14" />
			{/* Chomp frames — CSS alternates their opacity while .pac-chomp runs */}
			<path d={fOpen} className={`${mouthClass} pac-mouth-f0`} fill="#201a14" />
			<path d={fMid} className={`${mouthClass} pac-mouth-f1`} fill="#201a14" />
			<path d={fClosed} className={`${mouthClass} pac-mouth-f2`} fill="#201a14" />
		</svg>
	);
}
