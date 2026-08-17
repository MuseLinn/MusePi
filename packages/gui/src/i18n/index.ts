/**
 * GUI i18n — re-export the desktop-web i18n surface (same locale registry,
 * same runtime switching; the GUI and desktop-web stay in sync on one locale).
 */

export type { TranslationMap } from "@musepi/desktop-web";
export { getLocaleSnapshot, registerTranslations, setLocale, subscribeLocale, t, tLoose } from "@musepi/desktop-web";
