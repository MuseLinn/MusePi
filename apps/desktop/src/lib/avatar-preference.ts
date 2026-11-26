import { useEffect, useState } from "react";

/** Whether transcript rows render agent and user avatars. */
export type AvatarPreference = boolean;

const STORAGE_KEY = "musepi-gui-avatars";
const CHANGE_EVENT = "musepi-gui-avatars-changed";

/** Read the preference. Absent and non-browser values resolve to shown. */
export function readAvatarPreference(): AvatarPreference {
	if (typeof localStorage === "undefined") return true;
	return localStorage.getItem(STORAGE_KEY) !== "0";
}

/** Persist the preference and notify every mounted consumer. */
export function writeAvatarPreference(show: AvatarPreference): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(STORAGE_KEY, show ? "1" : "0");
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Subscribe to preference changes. Returns a disposer. */
export function subscribeAvatarPreference(listener: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	window.addEventListener(CHANGE_EVENT, listener);
	return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/** Subscribe a component to the live avatar preference. */
export function useAvatarPreference(): AvatarPreference {
	const [show, setShow] = useState(readAvatarPreference);
	useEffect(() => {
		setShow(readAvatarPreference());
		return subscribeAvatarPreference(() => setShow(readAvatarPreference()));
	}, []);
	return show;
}
