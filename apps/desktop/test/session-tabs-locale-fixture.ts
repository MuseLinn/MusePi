import { getLocaleSnapshot, setLocale } from "@musepi/client-core";

const requestedEntryLocale = Bun.env.SESSION_TAB_TEST_ENTRY_LOCALE;
if (requestedEntryLocale === "en-US" || requestedEntryLocale === "zh-CN") setLocale(requestedEntryLocale);
export const preSeedLocale = getLocaleSnapshot();
export const seededLocale = preSeedLocale === "zh-CN" ? "en-US" : "zh-CN";
