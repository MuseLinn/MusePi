import { describe, expect, test } from "bun:test";
import { describeDrift } from "./verify-generated";

describe("verify-generated", () => {
	test("reports no drift for identical text", () => {
		expect(describeDrift("a\nb\n", "a\nb\n")).toBeNull();
	});

	test("names the first differing line", () => {
		const drift = describeDrift("a\nnew\nc", "a\nold\nc");
		expect(drift).toContain("line 2");
		expect(drift).toContain("committed: old");
		expect(drift).toContain("expected:  new");
	});

	test("reports a truncated artifact as a missing line", () => {
		const drift = describeDrift("a\nb", "a");
		expect(drift).toContain("line 2");
		expect(drift).toContain("<missing>");
	});
});
