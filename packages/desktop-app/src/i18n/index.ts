/**
 * GUI i18n — re-export the guest-client i18n surface (same locale registry,
 * same runtime switching; the GUI and guest-client stay in sync on one locale).
 */

export type { TranslationMap } from "@musepi/guest-client";
export { getLocaleSnapshot, registerTranslations, setLocale, subscribeLocale, t, tLoose } from "@musepi/guest-client";
