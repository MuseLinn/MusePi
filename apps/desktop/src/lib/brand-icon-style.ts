import { useEffect, useState } from "react";

/** How brand marks are rendered: theme colour or each brand's own colour. */
export type BrandIconStyle = "mono" | "color";

const STORAGE_KEY = "musepi-gui-brand-icons";
const CHANGE_EVENT = "musepi-gui-brand-icons-changed";

/** Read the preference. Absent, junk and non-browser values resolve to mono. */
export function readBrandIconStyle(): BrandIconStyle {
	if (typeof localStorage === "undefined") return "mono";
	return localStorage.getItem(STORAGE_KEY) === "color" ? "color" : "mono";
}

/** Persist the preference and notify every mounted consumer. */
export function writeBrandIconStyle(style: BrandIconStyle): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(STORAGE_KEY, style);
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Subscribe to preference changes. Returns a disposer. */
export function subscribeBrandIconStyle(listener: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	window.addEventListener(CHANGE_EVENT, listener);
	return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/** Subscribe a component to the live brand-icon preference. */
export function useBrandIconStyle(): BrandIconStyle {
	const [style, setStyle] = useState(readBrandIconStyle);
	useEffect(() => {
		setStyle(readBrandIconStyle());
		return subscribeBrandIconStyle(() => setStyle(readBrandIconStyle()));
	}, []);
	return style;
}
