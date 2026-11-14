import "./happy-dom-shim";
import { expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { preSeedLocale, seededLocale } from "./session-tabs-locale-fixture";

test("seeds a foreign locale for the following tab suite", () => {
	expect(getLocaleSnapshot()).toBe(preSeedLocale);
	setLocale(seededLocale);
	expect(getLocaleSnapshot()).toBe(seededLocale);
});
