import { DotMatrixMark, t } from "@musepi/client-core";
import { useEffect, useState } from "react";

/**
 * Welcome backdrop preference (设置 → 常规): the dot-matrix brand animation
 * behind the empty-state hero.
 *
 * The backdrop is a slot contribution (`conversation.hero.frame`), not a piece
 * of the hero layout: a brand plugin paints behind the home content. The host
 * keeps this component as the built-in occupant so disabling the plugin, or a
 * compile failure, cannot take the backdrop away with it.
 */
const WELCOME_BACKDROP_CHANGED_EVENT = "musepi-dotmatrix-changed";
const ON_KEY = "musepi-gui-dotmatrix";
const TEXT_KEY = "musepi-gui-dotmatrix-text";


interface WelcomeBackdropPreference {
	on: boolean;
	text: string;
}

function readWelcomeBackdrop(): WelcomeBackdropPreference {
	try {
		return {
			on: localStorage.getItem(ON_KEY) !== "0",
			text: localStorage.getItem(TEXT_KEY) || t("settings.musepi"),
		};
	} catch {
		return { on: true, text: t("settings.musepi") };
	}
}

/** Settings changes arrive as a custom event; another window's change as a
 *  `storage` event. Both refire the read, so the live preview stays honest. */
function subscribeWelcomeBackdrop(onChange: () => void): () => void {
	const onEvent = (event: Event): void => {
		if (
			event.type === "storage" &&
			(event as StorageEvent).key !== ON_KEY &&
			(event as StorageEvent).key !== TEXT_KEY
		) {
			return;
		}
		onChange();
	};
	window.addEventListener(WELCOME_BACKDROP_CHANGED_EVENT, onEvent);
	window.addEventListener("storage", onEvent);
	return () => {
		window.removeEventListener(WELCOME_BACKDROP_CHANGED_EVENT, onEvent);
		window.removeEventListener("storage", onEvent);
	};
}

/** The backdrop itself: a full-bleed dot grid behind the hero. It carries the
 *  hero's own stage class (`.gui-welcome-mark`, absolute inset 0), so it lands
 *  in the same box whether the host or a plugin renders it. */
export function WelcomeBackdrop(): React.JSX.Element | null {
	const [pref, setPref] = useState(readWelcomeBackdrop);
	useEffect(() => subscribeWelcomeBackdrop(() => setPref(readWelcomeBackdrop())), []);
	if (!pref.on) return null;
	return <DotMatrixMark text={pref.text} className="gui-welcome-mark" />;
}
