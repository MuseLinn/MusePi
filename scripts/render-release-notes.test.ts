#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import {
	buildDownloadTable,
	buildReleaseLinks,
	buildUpdateNotes,
	countReleaseEntries,
	DEFAULT_REPO,
	findReleaseSection,
	formatReleaseSummary,
	listReleaseSections,
	renderReleaseNotes,
} from "./render-release-notes.ts";

const CHANGELOG = [
	"# MusePi Changelog",
	"",
	"MusePi 的发布说明。",
	"",
	"## [Unreleased]",
	"",
	"### 新功能",
	"",
	"- 未发布条目。",
	"  - EN: Unreleased entry.",
	"",
	"## [1.2.0] - 2026-11-21",
	"",
	"### 新功能",
	"",
	"- **甲**：新东西。",
	"  - EN: A.",
	"",
	"- **乙**：另一个新东西。",
	"  - EN: B.",
	"",
	"### 改进",
	"",
	"- **丙**：更好用了。",
	"  - EN: C.",
	"",
	"### 修复",
	"",
	"- **丁**：修好了。",
	"  - EN: D.",
	"",
	"- **戊**：也修好了。",
	"  - EN: E.",
	"",
	"## [1.1.0] - 2026-10-01",
	"",
	"- 平铺旧条目。",
	"",
	"- 另一条平铺旧条目。",
	"",
	"## [1.0.0] - 2026-09-01",
	"",
	"### Added",
	"",
	"- **Old**：Shipped with the English heading.",
	"  - EN: Old.",
	"",
].join("\n");

describe("listReleaseSections", () => {
	test("lists released sections in document order and skips [Unreleased]", () => {
		const sections = listReleaseSections(CHANGELOG);
		expect(sections.map(section => section.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
		expect(sections[0]?.date).toBe("2026-11-21");
		expect(sections[0]?.body.startsWith("### 新功能")).toBe(true);
	});

	test("keeps a beta version section", () => {
		const sections = listReleaseSections("## [1.2.0-beta.2] - 2026-11-20\n\n- 条目。\n");
		expect(sections).toEqual([{ version: "1.2.0-beta.2", date: "2026-11-20", body: "- 条目。" }]);
	});
});

describe("countReleaseEntries", () => {
	test("counts one entry per top-level bullet, not per EN child", () => {
		const section = findReleaseSection(CHANGELOG, "1.2.0");
		expect(countReleaseEntries(section?.body ?? "")).toEqual({
			added: 2,
			improved: 1,
			fixed: 2,
			uncategorized: 0,
			total: 5,
		});
	});

	test("counts a flat section as uncategorized", () => {
		const section = findReleaseSection(CHANGELOG, "1.1.0");
		expect(countReleaseEntries(section?.body ?? "")).toEqual({
			added: 0,
			improved: 0,
			fixed: 0,
			uncategorized: 2,
			total: 2,
		});
	});

	test("counts the English headings of older releases", () => {
		const section = findReleaseSection(CHANGELOG, "1.0.0");
		expect(countReleaseEntries(section?.body ?? "").added).toBe(1);
	});
});

describe("formatReleaseSummary", () => {
	test("uses the canonical category line", () => {
		expect(formatReleaseSummary({ added: 2, improved: 1, fixed: 2, uncategorized: 0, total: 5 })).toBe(
			"本次发布：2 项新功能 · 1 项改进 · 2 项修复",
		);
	});

	test("omits zero categories", () => {
		expect(formatReleaseSummary({ added: 0, improved: 0, fixed: 1, uncategorized: 0, total: 1 })).toBe(
			"本次发布：1 项修复",
		);
	});

	test("labels flat sections as other changes", () => {
		expect(formatReleaseSummary({ added: 0, improved: 0, fixed: 0, uncategorized: 2, total: 2 })).toBe(
			"本次发布：2 项其他变更",
		);
	});
});

describe("renderReleaseNotes", () => {
	test("keeps the download table and drops the duplicated version heading", () => {
		const body = renderReleaseNotes({ changelog: CHANGELOG, version: "1.2.0", tag: "v1.2.0" });
		expect(body.startsWith("# MusePi 1.2.0\n")).toBe(true);
		expect(body).toContain("| Platform | 下载 |");
		expect(body).toContain(
			`[MusePi-1.2.0-arm64.dmg](https://github.com/${DEFAULT_REPO}/releases/download/v1.2.0/MusePi-1.2.0-arm64.dmg)`,
		);
		expect(body).not.toContain("## [1.2.0]");
	});

	test("adds the counts line and keeps the categorized entries", () => {
		const body = renderReleaseNotes({ changelog: CHANGELOG, version: "1.2.0", tag: "v1.2.0" });
		expect(body).toContain("本次发布：2 项新功能 · 1 项改进 · 2 项修复");
		expect(body).toContain("### 新功能");
		expect(body).toContain("**甲**：新东西。");
		expect(body).toContain("  - EN: A.");
		expect(body).not.toContain("未发布条目");
	});

	test("links the full changelog and the previous release comparison", () => {
		const body = renderReleaseNotes({ changelog: CHANGELOG, version: "1.2.0", tag: "v1.2.0" });
		expect(body).toContain(
			`[完整更新日志](https://github.com/${DEFAULT_REPO}/blob/main/packages/coding-agent/CHANGELOG.musepi.md)`,
		);
		expect(body).toContain(`[对比 v1.1.0…v1.2.0](https://github.com/${DEFAULT_REPO}/compare/v1.1.0...v1.2.0)`);
	});

	test("uses the asset tag for downloads but the release tag for comparison", () => {
		const body = renderReleaseNotes({
			changelog: CHANGELOG,
			version: "1.2.0",
			tag: "v1.2.0-beta.1",
			assetsTag: "channel-beta",
		});
		expect(body).toContain(`/releases/download/channel-beta/MusePi-1.2.0-arm64.dmg`);
		expect(body).toContain("/compare/v1.1.0...v1.2.0-beta.1");
	});

	test("falls back to the releases list when no older section exists", () => {
		const single = "## [1.0.0] - 2026-09-01\n\n### 新功能\n\n- **甲**：新东西。\n";
		const body = renderReleaseNotes({ changelog: single, version: "1.0.0", tag: "v1.0.0" });
		expect(body).toContain(`[全部发布](https://github.com/${DEFAULT_REPO}/releases)`);
	});

	test("throws when the released version has no section", () => {
		expect(() => renderReleaseNotes({ changelog: CHANGELOG, version: "9.9.9", tag: "v9.9.9" })).toThrow(
			"no `## [9.9.9]` section",
		);
	});
});

describe("buildUpdateNotes", () => {
	test("leads with the version heading and the category counts", () => {
		const section = findReleaseSection(CHANGELOG, "1.2.0");
		expect(section).toBeDefined();
		const notes = buildUpdateNotes(section!);
		const head = notes.slice(0, 200);
		expect(notes.startsWith("## [1.2.0] - 2026-11-21\n")).toBe(true);
		expect(head).toContain("本次发布：2 项新功能 · 1 项改进 · 2 项修复");
		expect(head).toContain("### 新功能");
		expect(notes).toContain("**甲**：新东西。");
		expect(notes).toContain("  - EN: A.");
	});
});

describe("building blocks", () => {
	test("download table follows the asset tag", () => {
		const table = buildDownloadTable("1.2.0", "channel-beta");
		expect(table).toContain("| Android |");
		expect(table).toContain("/releases/download/channel-beta/MusePi-1.2.0-app-debug.apk");
	});

	test("release links honour a custom repository", () => {
		const links = buildReleaseLinks({ version: "1.2.0", tag: "v1.2.0", previousVersion: "1.1.0", repo: "o/r" });
		expect(links).toContain("https://github.com/o/r/compare/v1.1.0...v1.2.0");
	});
});
