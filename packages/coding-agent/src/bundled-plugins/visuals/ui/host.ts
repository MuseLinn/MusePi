/**
 * Host services a compiled widget renderer may use.
 *
 * Widget modules are compiled separately and imported through a blob URL, so
 * they cannot import client-core (a second copy would break hook identity).
 * The GUI publishes the shared i18n instance on `window.MusePiHostModules`;
 * this helper is the single place a card reads it. A missing table (older
 * host, SSR) falls back to the supplied English text instead of throwing.
 */
declare const window: {
	MusePiHostModules?: { i18n?: { t(key: string): string } };
};

/** Translate a host key with a fallback for hosts that do not publish i18n. */
export function hostT(key: string, fallback: string): string {
	const text = window.MusePiHostModules?.i18n?.t(key);
	return typeof text === "string" && text.length > 0 && text !== key ? text : fallback;
}
