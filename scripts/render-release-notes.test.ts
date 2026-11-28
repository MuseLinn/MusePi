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
	resolveReleaseVersion,
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
		expect(body).toContain("[完整更新日志](https://muselinn.github.io/MusePi/changelog.html)");
		expect(body).toContain(`[对比 v1.1.0…v1.2.0](https://github.com/${DEFAULT_REPO}/compare/v1.1.0...v1.2.0)`);
	});

	test("uses the asset tag for downloads but the release tag for comparison", () => {
		const beta = [
			"## [1.2.0-beta.1] - 2026-11-22",
			"",
			"### 修复",
			"",
			"- **乙**：beta 修复。",
			"",
			"## [1.1.0] - 2026-10-01",
			"",
			"### 修复",
			"",
			"- **甲**：上一条修复。",
			"",
		].join("\n");
		const body = renderReleaseNotes({
			changelog: beta,
			version: "1.2.0-beta.1",
			tag: "v1.2.0-beta.1",
			assetsTag: "channel-beta",
		});
		expect(body).toContain(`/releases/download/channel-beta/MusePi-1.2.0-beta.1-arm64.dmg`);
		expect(body).toContain("/compare/v1.1.0...v1.2.0-beta.1");
	});

	test("refuses a tag that does not match the version", () => {
		expect(() => renderReleaseNotes({ changelog: CHANGELOG, version: "1.2.0", tag: "v1.1.0" })).toThrow(
			'tag "v1.1.0" does not match version 1.2.0',
		);
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

describe("resolveReleaseVersion", () => {
	test("derives the version from --tag when --version is omitted", () => {
		expect(resolveReleaseVersion({ tag: "v1.2.0", packageVersion: "1.1.0" })).toEqual({
			version: "1.2.0",
			tag: "v1.2.0",
		});
	});

	test("keeps a beta tag and its version aligned", () => {
		expect(resolveReleaseVersion({ tag: "v1.2.0-beta.1", packageVersion: "1.1.0" })).toEqual({
			version: "1.2.0-beta.1",
			tag: "v1.2.0-beta.1",
		});
	});

	test("falls back to the package version and v<version>", () => {
		expect(resolveReleaseVersion({ packageVersion: "1.2.0" })).toEqual({ version: "1.2.0", tag: "v1.2.0" });
	});

	test("rejects an explicit tag that differs from the version", () => {
		expect(() => resolveReleaseVersion({ version: "1.2.0", tag: "v1.1.0", packageVersion: "1.2.0" })).toThrow(
			'tag "v1.1.0" does not match version 1.2.0',
		);
	});

	test("rejects a tag without the v prefix", () => {
		expect(() => resolveReleaseVersion({ tag: "1.2.0", packageVersion: "1.2.0" })).toThrow(
			'must use the release form "v<version>"',
		);
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
		expect(links).toContain("https://github.com/o/r/blob/main/packages/coding-agent/CHANGELOG.musepi.md");
	});
});

describe("renderReleaseNotes --max-chars", () => {
	const body = "这是一段足够长的正文，用来把页面撑到需要截断的长度。".repeat(12);
	const entry = (title: string): string[] => [`- **${title}**：${body}`, `  - EN: ${body}`];
	const LONG_CHANGELOG = [
		"## [2.0.0] - 2026-11-21",
		"",
		"### 新功能",
		"",
		...entry("甲"),
		"",
		...entry("乙"),
		"",
		...entry("丙"),
		"",
		"### 改进",
		"",
		...entry("丁"),
		"",
		...entry("戊"),
		"",
		"### 修复",
		"",
		...entry("己"),
		"",
		"## [1.0.0] - 2026-09-01",
		"",
		"### 修复",
		"",
		...entry("庚"),
		"",
	].join("\n");
	const chars = (text: string): number => [...text].length;
	const render = (maxChars?: number): string =>
		renderReleaseNotes({ changelog: LONG_CHANGELOG, version: "2.0.0", tag: "v2.0.0", maxChars });
	const SHOWN_TITLES = ["甲", "乙", "丙", "丁", "戊", "己"];

	test("keeps the body unchanged when it fits the budget", () => {
		const full = render();
		expect(render(chars(full))).toBe(full);
		expect(render(chars(full) + 1)).toBe(full);
	});

	test("trims whole entries and keeps the counts and omitted total consistent", () => {
		const full = render();
		const budget = Math.floor(chars(full) * 0.6);
		const capped = render(budget);
		expect(chars(capped)).toBeLessThanOrEqual(budget);

		const shown = [...capped.matchAll(/^- \*\*(.+?)\*\*/gm)].map(match => match[1]!);
		const omitted = Number(/还有 (\d+) 项变更未在此页展开/.exec(capped)?.[1]);
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.length).toBeLessThan(SHOWN_TITLES.length);
		expect(Number.isInteger(omitted)).toBe(true);
		expect(shown.length + omitted).toBe(SHOWN_TITLES.length);
		expect(capped).toContain("本次发布：3 项新功能 · 2 项改进 · 1 项修复");
		expect(capped).toContain(
			`[完整更新日志](https://github.com/${DEFAULT_REPO}/blob/main/packages/coding-agent/CHANGELOG.musepi.md)`,
		);

		const shownByCategory = new Map<string, string[]>();
		let heading = "";
		for (const block of capped.split("\n\n")) {
			if (block.startsWith("### ")) {
				heading = block;
				shownByCategory.set(heading, []);
			} else if (block.startsWith("- **")) {
				shownByCategory.get(heading)?.push(/^- \*\*(.+?)\*\*/.exec(block)?.[1] ?? "");
			}
		}
		for (const [category, titles] of [
			["### 新功能", ["甲", "乙", "丙"]],
			["### 改进", ["丁", "戊"]],
			["### 修复", ["己"]],
		] as const) {
			const visible = shownByCategory.get(category) ?? [];
			expect(visible).toEqual(titles.slice(0, visible.length));
		}
	});

	test("never ends an entry mid-way", () => {
		const capped = render(Math.floor(chars(render()) * 0.6));
		const entries = capped.split("\n\n").filter(block => block.startsWith("- "));
		expect(entries.length).toBeGreaterThan(0);
		for (const block of entries) {
			expect(block.split("\n").at(-1)?.startsWith("  - EN: ")).toBe(true);
		}
		const shown = new Set([...capped.matchAll(/^- \*\*(.+?)\*\*/gm)].map(match => match[1]));
		for (const title of SHOWN_TITLES) {
			if (!shown.has(title)) expect(capped).not.toContain(`- **${title}**`);
		}
	});

	test("refuses a budget that cannot hold the fixed blocks", () => {
		expect(() => render(100)).toThrow("nothing is left to fit --max-chars 100");
	});
});
