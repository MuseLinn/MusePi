import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Fill-wipe icon: the outline glyph stays put while a filled copy is
 * revealed by an expanding circular clip, so a state change reads as the
 * icon filling from its center outward. This is a geometry animation, not
 * a morphicons path morph — morphicons forces `fill:none` and only
 * interpolates stroke centerlines.
 *
 * `fill="center"` fills only the last `<circle>` (target-style glyphs);
 * filling the whole lucide Target would collapse the bullseye into a disc.
 * The rail reuses the same primitive through CSS hover/focus, no state.
 */
export function FillWipeIcon({
	icon: Icon,
	active = false,
	size = 14,
	className,
	fill = "all",
}: {
	icon: LucideIcon;
	active?: boolean;
	size?: number;
	className?: string;
	/** "all" fills the whole glyph; "center" fills only the last circle. */
	fill?: "all" | "center";
}): ReactNode {
	return (
		<span className={`gui-fill-wipe${active ? " gui-fill-wipe--on" : ""}${className ? ` ${className}` : ""}`}>
			<Icon size={size} className="gui-fill-wipe__outline" aria-hidden />
			<Icon
				size={size}
				className={`gui-fill-wipe__fill${fill === "center" ? " gui-fill-wipe__fill--center" : ""}`}
				aria-hidden
			/>
		</span>
	);
}
