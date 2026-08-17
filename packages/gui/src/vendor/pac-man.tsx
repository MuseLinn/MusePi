import type { ReactNode } from "react";

/**
 * Pac-man glyph — a proper vector pac-man (gummy-yellow disc, eye, and a
 * wedge mouth) replacing the CSS conic-gradient cut-outs that read as a
 * plain yellow bar at small sizes. Renders crisp at any size; the mouth
 * chomps via a 3-frame sprite (three wedge paths alternating opacity —
 * SVG paths can't be interpolated by CSS without registered `d`).
 *
 * Mouth frame selection:
 * - `mouth` 0..1 drives the static wedge angle (TurnRail hover states).
 * - `animating` adds the `.pac-chomp` class → the CSS animation cycles
 *   the three wedges (open → mid → closed → …) while it runs.
 */
export function PacMan({
	size,
	side = "right",
	mouth = 0.45,
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
	// Wedge geometry in a 24×24 viewBox (r=10 disc at 12,12). Each wedge is
	// a triangle from the centre to the disc rim; the wedge "openness" is
	// its rim chord. Precomputed for mouth=0.45 (rest) plus the 3 chomp
	// frames.
	const wedge = (halfChord: number): string => {
		const d = `M12 12 L${12 + halfChord} ${12 - halfChord} L${12 + halfChord} ${12 + halfChord} Z`;
		return d;
	};
	// halfChord at rim: wedge width = 2*halfChord, clamped to disc radius.
	// mouth 1 → chord ≈ 20 (nearly the full disc), mouth 0 → chord ≈ 2.
	const chord = 2 + mouth * 18;
	const rest = wedge(chord / 2);
	const f0 = wedge(10.2); // open
	const f1 = wedge(6.5); // mid
	const f2 = wedge(2.6); // closed

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
			<circle cx="16" cy="6.5" r="1.7" fill="#201a14" />
			{/* Static rest wedge (shown when not animating) */}
			<path d={rest} className="pac-mouth-rest" fill="#201a14" />
			{/* Chomp frames — CSS alternates their opacity while .pac-chomp runs */}
			<path d={f0} className={`${mouthClass} pac-mouth-f0`} fill="#201a14" />
			<path d={f1} className={`${mouthClass} pac-mouth-f1`} fill="#201a14" />
			<path d={f2} className={`${mouthClass} pac-mouth-f2`} fill="#201a14" />
		</svg>
	);
}
