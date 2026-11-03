import { describe, expect, it } from "bun:test";
import { managedTabIsBlank } from "../src/lib/managed-browser-visibility";

describe("managed browser visibility", () => {
	it("uses the real URL instead of a stale blank flag", () => {
		// A missed blank-field update must not leave a loaded HTTP page hidden.
		expect(managedTabIsBlank({ url: "https://example.com" })).toBe(false);
		expect(managedTabIsBlank({ url: "about:blank" })).toBe(true);
		expect(managedTabIsBlank({ url: "" })).toBe(true);
		expect(managedTabIsBlank(null)).toBe(true);
	});
});
