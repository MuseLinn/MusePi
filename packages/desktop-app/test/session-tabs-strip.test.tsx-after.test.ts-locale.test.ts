import "./happy-dom-shim";
import { expect, test } from "bun:test";
import { getLocaleSnapshot } from "@musepi/client-core";
import { preSeedLocale } from "./session-tabs-strip-00-isolation-seed.test";

test("isolation cleanup restores the exact pre-seed locale", () => {
	expect(getLocaleSnapshot()).toBe(preSeedLocale);
});
