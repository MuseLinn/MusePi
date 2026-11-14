import "./happy-dom-shim";
import { expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { preSeedLocale, seededLocale } from "./session-tabs-locale-fixture";

test("tab suite restores the previous file locale", () => {
	setLocale(seededLocale);
	try {
		expect(getLocaleSnapshot()).toBe(seededLocale);
	} finally {
		setLocale(preSeedLocale);
	}
});
