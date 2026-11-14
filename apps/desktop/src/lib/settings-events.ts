/**
 * One settings-changed event for the desktop shell.
 *
 * The canonical name is `musepi-settings-changed` (the same `musepi-` prefix
 * every current custom event uses). `omp-settings-changed` is the pre-rename
 * alias: it stays dispatched so external/older listeners keep working, but
 * in-repo consumers subscribe through {@link onSettingsChanged} and therefore
 * hear the canonical event once.
 */

export const SETTINGS_CHANGED_EVENT = "musepi-settings-changed";
/** @deprecated Pre-rename alias. Dispatched for compatibility only. */
export const LEGACY_SETTINGS_CHANGED_EVENT = "omp-settings-changed";

export interface SettingsChangedDetail {
	key: string;
}

/** Broadcast a committed settings write to live shell surfaces. */
export function dispatchSettingsChanged(key: string): void {
	if (typeof window === "undefined") return;
	const detail: SettingsChangedDetail = { key };
	window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail }));
	window.dispatchEvent(new CustomEvent(LEGACY_SETTINGS_CHANGED_EVENT, { detail }));
}

/** Subscribe to committed settings writes; returns the unsubscribe function. */
export function onSettingsChanged(handler: (detail: SettingsChangedDetail) => void): () => void {
	if (typeof window === "undefined") return () => {};
	const listener = (event: Event): void => {
		const detail = (event as CustomEvent<Partial<SettingsChangedDetail>>).detail;
		handler({ key: typeof detail?.key === "string" ? detail.key : "" });
	};
	window.addEventListener(SETTINGS_CHANGED_EVENT, listener);
	return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, listener);
}
