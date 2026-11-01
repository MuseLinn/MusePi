import { useEffect, useState } from "react";

/** Shared width classes for native and browser shells. Compact also covers
 * short landscape viewports, where a persistent multi-column layout would
 * leave too little room for the transcript and software keyboard. */
export type ShellLayout = "compact" | "medium" | "wide";

export function shellLayoutForViewport(width: number, height: number): ShellLayout {
	if (width < 600 || (height < 480 && width < 1024)) return "compact";
	return width < 840 ? "medium" : "wide";
}

function readShellLayout(): ShellLayout {
	if (typeof window === "undefined" || !window.matchMedia) return "wide";
	const compact = window.matchMedia("(max-width: 599px), (max-height: 479px) and (max-width: 1023px)").matches;
	if (compact) return "compact";
	return window.matchMedia("(max-width: 839px)").matches ? "medium" : "wide";
}

export function useShellLayout(): ShellLayout {
	const [layout, setLayout] = useState<ShellLayout>(readShellLayout);
	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const compact = window.matchMedia("(max-width: 599px), (max-height: 479px) and (max-width: 1023px)");
		const medium = window.matchMedia("(max-width: 839px)");
		const update = (): void => setLayout(readShellLayout());
		update();
		compact.addEventListener("change", update);
		medium.addEventListener("change", update);
		return () => {
			compact.removeEventListener("change", update);
			medium.removeEventListener("change", update);
		};
	}, []);
	return layout;
}
