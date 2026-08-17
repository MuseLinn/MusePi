/**
 * GUI i18n — re-export the collab-web i18n surface (same locale registry,
 * same runtime switching; the GUI and collab-web stay in sync on one locale).
 */

export type { TranslationMap } from "@musepi/collab-web";
export { getLocaleSnapshot, setLocale, subscribeLocale, t } from "@musepi/collab-web";
