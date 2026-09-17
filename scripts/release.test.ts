import { describe, expect, test } from "bun:test";
import { insertFreshUnreleased, validateExplicitVersion } from "./release";

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

/**
 * A release consumes the `[Unreleased]` heading (it becomes the new version
 * section), and the file must get a fresh empty one back — otherwise the NEXT
 * release skips that changelog with "no [Unreleased] section" and the
 * what's-new panel keeps serving the previous version's notes forever.
 *
 * The regression this pins: the old code re-inserted it by anchoring on the
 * title line (`# Changelog\n\n` / `# MusePi Changelog\n\n`). The MusePi file
 * carries a description paragraph between its title and the first section, so
 * the anchor never matched and the section was silently NOT re-created.
 */
describe("insertFreshUnreleased", () => {
	test("re-inserts before the first section when the title is followed by prose", () => {
		const musepi = [
			"# MusePi Changelog",
			"MusePi 定制版本的发布说明。",
			"",
			"## [0.4.31] - 2026-09-17",
			"",
			"### Added",
			"",
			"- something",
			"",
		].join("\n");
		const out = insertFreshUnreleased(musepi);
		expect(out.indexOf("## [Unreleased]")).toBeLessThan(out.indexOf("## [0.4.31]"));
		// The prose stays directly under the title, untouched.
		expect(out.startsWith("# MusePi Changelog\nMusePi 定制版本的发布说明。\n")).toBe(true);
		// And it is an EMPTY section: nothing between it and the version heading.
		expect(out).toContain("## [Unreleased]\n\n## [0.4.31] - 2026-09-17");
	});

	test("works for the plain upstream header too", () => {
		const upstream = "# Changelog\n\n## [17.3.0] - 2026-08-13\n\n### Added\n";
		expect(insertFreshUnreleased(upstream)).toContain("## [Unreleased]\n\n## [17.3.0] - 2026-08-13");
	});

	test("is idempotent — an existing section is left alone", () => {
		const withSection = "# Changelog\n\n## [Unreleased]\n\n## [17.3.0] - 2026-08-13\n";
		expect(insertFreshUnreleased(withSection)).toBe(withSection);
	});

	test("appends when the file has no section headings at all", () => {
		const bare = "# Changelog\n\nNothing here yet.";
		const out = insertFreshUnreleased(bare);
		expect(out).toContain("## [Unreleased]");
		expect(out.startsWith("# Changelog\n\nNothing here yet.")).toBe(true);
	});

	test("does not mistake a non-version heading for the insertion point", () => {
		// `## [Unreleased]` must land above the version history, and a leading
		// non-bracket heading must not attract it.
		const doc = "# Changelog\n\n## Notes\n\ntext\n\n## [17.3.0] - 2026-08-13\n";
		const out = insertFreshUnreleased(doc);
		expect(out.indexOf("## [Unreleased]")).toBeLessThan(out.indexOf("## [17.3.0]"));
	});
});
