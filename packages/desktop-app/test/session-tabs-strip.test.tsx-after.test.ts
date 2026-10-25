import "./happy-dom-shim";
import { afterAll, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { preSeedLocale, seededLocale } from "./session-tabs-strip-00-isolation-seed.test";

afterAll(() => {
	document.getElementById("session-tabs-foreign-fixture")?.remove();
	setLocale(preSeedLocale);
});

test("tab suite restores the previous file locale", () => {
	expect(getLocaleSnapshot()).toBe(seededLocale);
});

test("tab suite preserves DOM owned by another file", () => {
	expect(document.getElementById("session-tabs-foreign-fixture")).not.toBeNull();
});
