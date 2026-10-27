import "./happy-dom-shim";
import { expect, test } from "bun:test";
import { getLocaleSnapshot } from "@musepi/client-core";
import { preSeedLocale } from "./session-tabs-locale-fixture";

test("isolation cleanup restores the exact pre-seed locale", () => {
	expect(getLocaleSnapshot()).toBe(preSeedLocale);
});
