import { describe, expect, test } from "bun:test";
import { validateExplicitVersion } from "./release";

describe("validateExplicitVersion", () => {
	test("rejects malformed versions", () => {
		expect(validateExplicitVersion("999.bad")).toBe(null);
		expect(validateExplicitVersion("17")).toBe(null);
		expect(validateExplicitVersion("17.2")).toBe(null);
		expect(validateExplicitVersion("17.2.8.9")).toBe(null);
		expect(validateExplicitVersion("v17.2.8.9")).toBe(null);
		expect(validateExplicitVersion("abc")).toBe(null);
		expect(validateExplicitVersion("")).toBe(null);
		expect(validateExplicitVersion("v")).toBe(null);
		expect(validateExplicitVersion("17.2.8-")).toBe(null);
	});

	test("rejects leading zeroes in numeric segments", () => {
		expect(validateExplicitVersion("018.0.0")).toBe(null);
		expect(validateExplicitVersion("v018.0.0")).toBe(null);
		expect(validateExplicitVersion("18.00.0")).toBe(null);
		expect(validateExplicitVersion("18.0.00")).toBe(null);
	});

	test("rejects prerelease suffixes (not supported by this release path)", () => {
		// Prereleases would be published as npm `latest` because the downstream
		// publish runs `npm publish` with no `--tag`.
		expect(validateExplicitVersion("17.2.8-rc.1")).toBe(null);
		expect(validateExplicitVersion("v17.2.8-beta")).toBe(null);
		expect(validateExplicitVersion("1.0.0-alpha")).toBe(null);
		expect(validateExplicitVersion("1.0.0-alpha.1.2")).toBe(null);
		expect(validateExplicitVersion("1.0.0-0.3.7")).toBe(null);
		expect(validateExplicitVersion("1.0.0-x.7.z.92")).toBe(null);
	});

	test("accepts bare three-segment numeric versions and returns them unchanged", () => {
		expect(validateExplicitVersion("17.2.8")).toBe("17.2.8");
		expect(validateExplicitVersion("0.0.0")).toBe("0.0.0");
		expect(validateExplicitVersion("1.0.0")).toBe("1.0.0");
	});

	test("accepts leading v prefix and normalizes to the bare version", () => {
		expect(validateExplicitVersion("v17.2.8")).toBe("17.2.8");
		expect(validateExplicitVersion("V17.2.8")).toBe(null);
	});
});
