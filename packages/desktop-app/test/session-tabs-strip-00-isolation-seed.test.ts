import "./happy-dom-shim";
import { expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";

const requestedEntryLocale = Bun.env.SESSION_TAB_TEST_ENTRY_LOCALE;
if (requestedEntryLocale === "en-US" || requestedEntryLocale === "zh-CN") setLocale(requestedEntryLocale);
export const preSeedLocale = getLocaleSnapshot();
export const seededLocale = preSeedLocale === "zh-CN" ? "en-US" : "zh-CN";
setLocale(seededLocale);
const sentinel = document.createElement("div");
sentinel.id = "session-tabs-foreign-fixture";
document.body.appendChild(sentinel);

test("seeds foreign locale and DOM for the following tab suite", () => {
	expect(getLocaleSnapshot()).toBe(seededLocale);
	expect(document.getElementById(sentinel.id)).toBe(sentinel);
});
