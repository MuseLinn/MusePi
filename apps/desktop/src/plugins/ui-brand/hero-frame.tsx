import type { ReactNode } from "react";
import { WelcomeBackdrop } from "../../lib/welcome-backdrop";

/**
 * `conversation.hero.frame` occupant (hoc seat, dsh `conversation.hero.frame`
 * parity): the official whale there paints behind the home content and plays
 * on blank clicks; this one paints the dot-matrix brand animation behind the
 * hero and renders the host content untouched.
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