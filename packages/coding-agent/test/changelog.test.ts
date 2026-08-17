import { describe, expect, test } from "bun:test";
import { parseChangelog, parseChangelogVersion, selectStartupChangelog } from "../src/utils/changelog.js";

const entry = (
	v: string,
	content = `## [${v}] - 2026-08-16\n\n### Added\n\n- something`,
): Parameters<typeof selectStartupChangelog>[0][number] => {
	const parsed = parseChangelogVersion(v)!;
	return { major: parsed.major, minor: parsed.minor, patch: parsed.patch, content };
};

describe("changelog — MusePi notes first", () => {
	test("parseChangelog prefers CHANGELOG.musepi.md over the upstream bundle", async () => {
		// The repo ships packages/coding-agent/CHANGELOG.musepi.md, so the
		// musepi-first path must surface its 0.4.x entry — not the upstream
		// 17.x bundle.
		const entries = await parseChangelog(undefined);
		const versions = entries.map(e => `${e.major}.${e.minor}.${e.patch}`);
		expect(versions.some(v => v.startsWith("0.4."))).toBe(true);
	});
});

describe("selectStartupChangelog — marker handling", () => {
	test("marker newer than current (version-system switch) shows the series entries", () => {
		// Pre-split upstream marker 17.3.0 vs MusePi changelog 0.4.x — the
		// naive >-filter would hide everything forever; treat as first-seen.
		const entries = [entry("0.4.0"), entry("0.4.1")];
		const sel = selectStartupChangelog(entries, "17.3.0", "0.4.1");
		expect(sel.markdown).toContain("0.4.1");
		expect(sel.persistCurrentVersion).toBe(true);
	});

	test("normal upgrade shows only entries above the marker", () => {
		const entries = [entry("0.4.0"), entry("0.4.1")];
		const sel = selectStartupChangelog(entries, "0.4.0", "0.4.1");
		expect(sel.markdown).toContain("0.4.1");
		expect(sel.markdown).not.toContain("0.4.0");
		expect(sel.persistCurrentVersion).toBe(true);
	});

	test("marker equal to current is a no-op", () => {
		const entries = [entry("0.4.1")];
		const sel = selectStartupChangelog(entries, "0.4.1", "0.4.1");
		expect(sel.markdown).toBeUndefined();
		expect(sel.persistCurrentVersion).toBe(false);
	});
});
