import { WelcomeBackdrop } from "../../lib/welcome-backdrop";

/**
 * `conversation.hero.frame` occupant: the dot-matrix brand animation behind
 * the empty-state hero.
 *
 * The host renders this seat as a background layer (no `children` yet, so the
 * contribution is additive). A later revision can pass the hero body as
 * `children` and wrap it — the seat contract already declares `hoc` for that;
 * this component would then render the backdrop plus `children` untouched.
 */
export default function HeroFrame(): React.JSX.Element | null {
	return <WelcomeBackdrop />;
}
