import { describe, expect, test } from "bun:test";
import { getChangelogPath } from "../src/config";
import {
	parseChangelog,
	parseChangelogVersion,
	renderChangelogEntries,
	selectStartupChangelog,
} from "../src/utils/changelog.js";

const entry = (
	v: string,
	content = `## [${v}] - 2026-08-16\n\n### Added\n\n- something`,
): Parameters<typeof selectStartupChangelog>[0][number] => {
	const parsed = parseChangelogVersion(v)!;
	return { major: parsed.major, minor: parsed.minor, patch: parsed.patch, content };
};

describe("changelog — one source", () => {
	test("parseChangelog reads the MusePi release notes with no upstream fallback", async () => {
		// packages/coding-agent/CHANGELOG.musepi.md is the only changelog the
		// product ships; the what's-new panel, `/changelog` and the release page
		// all slice this file.
		const entries = await parseChangelog(getChangelogPath());
		const versions = entries.map(e => `${e.major}.${e.minor}.${e.patch}`);
		expect(versions.some(v => v.startsWith("0.4."))).toBe(true);
	});

	test("getChangelogPath points at CHANGELOG.musepi.md", () => {
		expect(getChangelogPath()).toEndWith("CHANGELOG.musepi.md");
	});
});

describe("renderChangelogEntries — locale projection", () => {
	const flat = (): Parameters<typeof selectStartupChangelog>[0][number] => ({
		major: 0,
		minor: 7,
		patch: 5,
		content: `## [0.7.5] - 2026-11-13

- **子代理会话保持可见**：名册改由磁盘记录派生。
  - EN: Subagent sessions stay visible. The roster now derives from disk.`,
	});

	test("English keeps the bold title when it promotes the EN child", () => {
		// The what's-new card turns a bold span into its heading; dropping it
		// here left every English highlight without a title (and therefore
		// without a card) — the panel showed "0 changes" for every version.
		const rendered = renderChangelogEntries([flat()], { locale: "en-US", oldestFirst: false });
		expect(rendered.markdown).toContain("- **子代理会话保持可见**：Subagent sessions stay visible.");
		expect(rendered.markdown).not.toContain("EN:");
	});

	test("Chinese keeps the main bullet and drops the EN child", () => {
		const rendered = renderChangelogEntries([flat()], { locale: "zh-CN", oldestFirst: false });
		expect(rendered.markdown).toContain("- **子代理会话保持可见**：名册改由磁盘记录派生。");
		expect(rendered.markdown).not.toContain("Subagent sessions stay visible");
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
