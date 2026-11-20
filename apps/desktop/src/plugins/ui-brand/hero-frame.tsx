import type { ReactNode } from "react";
import { WelcomeBackdrop } from "../../lib/welcome-backdrop";

/**
 * `conversation.hero.frame` occupant (hoc seat): it paints the dot-matrix
 * brand animation behind the hero and renders the host content untouched, so
 * the fragment adds no box and the hero keeps its own layout.
 *
 * The fragment adds no box, so the hero's own flex layout keeps the children
 * as direct flex items. A contribution that dropped `children` would blank the
 * whole welcome surface — the seat contract requires rendering it as-is.
 */
export default function HeroFrame({ children }: { children?: ReactNode }): React.JSX.Element {
	return (
		<>
			<WelcomeBackdrop />
			{children}
		</>
	);
}
