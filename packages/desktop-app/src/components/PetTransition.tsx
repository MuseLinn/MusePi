/** The particle orb as a TRANSITION, never as the pet: it converges into the
 *  brand sphere when the window shows and scatters out of it before the
 *  window hides. Phases are driven by pet-main.tsx; the shell keeps the
 *  window on screen for the dissolve (electron/main.cjs PET_HIDE_DELAY_MS).
 *
 *  The layer is pointer-events: none and sits inside `.pet-window__pet`, so
 *  the pet stays hit-testable for the whole animation and the reported
 *  hitbox never moves. */
import type { ReactNode } from "react";
import { ThinkingOrb } from "../vendor/thinking-orbs";

/** Enter: the sphere's settle and the particle convergence share one beat. */
export const PET_ENTER_MS = 420;
/** Exit: the dissolve. The shell's hide delay is tuned to the same beat. */
export const PET_EXIT_MS = 280;

export type PetTransitionPhase = "idle" | "enter" | "leave";

export function PetTransition({ phase }: { phase: PetTransitionPhase }): ReactNode {
	if (phase === "idle") return null;
	return (
		<div className="pet-window__transition" aria-hidden="true">
			{/* ThinkingOrb only ships 64/32/20 tunings; the pet box is ~104px,
			 *  so the canvas is stretched to the layer by CSS (the drawing is
			 *  a soft particle cloud — the upscale reads as glow). */}
			<ThinkingOrb state="working" size={64} style={{ width: "100%", height: "100%" }} />
		</div>
	);
}
