import { describe, expect, test } from "bun:test";
import {
	HIGHLIGHTS_PER_VERSION,
	localizeChangelogMarkdown,
	parseChangelogHighlights,
} from "../src/lib/changelog-highlights";

const FIXTURE = `# MusePi Changelog

## [Unreleased]

### Added

- **未发布亮点 X**：不该出现在任何版本段里。
  - EN: Unreleased highlight X: must not leak into any version section.

## [0.5.0] - 2026-09-28

### Added

- **素材策略行 + 媒体 provider 内联（M3 3.7c）**：欢迎页新增素材单选。选中值随发送落盘。
  - EN: asset-policy row + inline media provider (M3 3.7c): a new single-select on the welcome page. The value lands with the send.
- **普通亮点 B**：只有一句话。
- 普通条目没有加粗：永远不是亮点，但要计数。
- **普通亮点 C**：第三条亮点。
- **普通亮点 D**：第四条亮点，超出每版上限不取。

### Fixed

- 修复条目 1。
  - EN: Fix entry 1.
- 修复条目 2。

### Breaking Changes

- **破坏性变更亮点**：不在四类小节里，只计入总数，不进入分类计数。

## [0.4.9] - 2026-09-01

### Changed

- 变更条目没有加粗：该版本亮点应为空数组。

### Removed

- 移除条目 1。
`;

describe("parseChangelogHighlights", () => {
	test("multiple version sections keep document order; the head is the current version", () => {
		const versions = parseChangelogHighlights(FIXTURE);
		expect(versions.map(v => v.version)).toEqual(["0.5.0", "0.4.9"]);
	});

	test("[Unreleased] sections are skipped entirely", () => {
		const versions = parseChangelogHighlights(FIXTURE);
		expect(versions.some(v => v.version.toLowerCase() === "unreleased")).toBe(false);
		expect(JSON.stringify(versions)).not.toContain("未发布亮点");
	});

	test("highlights: bold bullets only, first three, document order, kind from the section heading", () => {
		const [current] = parseChangelogHighlights(FIXTURE);
		expect(current.highlights.map(h => h.title)).toEqual([
			"素材策略行 + 媒体 provider 内联（M3 3.7c）",
			"普通亮点 B",
			"普通亮点 C",
		]);
		expect(current.highlights.every(h => h.kind === "added")).toBe(true);
		expect(current.highlights).toHaveLength(HIGHLIGHTS_PER_VERSION);
	});

	test("description is the first sentence of the Chinese main line; the - EN: child line never leaks in", () => {
		const [current] = parseChangelogHighlights(FIXTURE);
		const [first] = current.highlights;
		expect(first.description).toBe("欢迎页新增素材单选。");
		expect(JSON.stringify(current.highlights)).not.toContain("EN:");
		expect(JSON.stringify(current.highlights)).not.toContain("asset-policy row");
	});

	test("counts are per-kind, over all bullets (bold or not) in the four known sections", () => {
		const [current, older] = parseChangelogHighlights(FIXTURE);
		// Added has 5 bullets, Fixed 2; Breaking Changes is outside the four
		// categories but still a change the panel must count.
		expect(current.counts).toEqual({ added: 5, fixed: 2, changed: 0, removed: 0 });
		expect(current.count).toBe(8);
		expect(older.counts).toEqual({ added: 0, fixed: 0, changed: 1, removed: 1 });
		expect(older.count).toBe(2);
	});

	test('date comes from the `## [x.y.z] - date` heading; a heading without a date yields ""', () => {
		const versions = parseChangelogHighlights(FIXTURE);
		expect(versions[0].date).toBe("2026-09-28");
		expect(versions[1].date).toBe("2026-09-01");
		const noDate = parseChangelogHighlights("## [1.2.3]\n\n### Added\n\n- **亮点**：描述。");
		expect(noDate[0].date).toBe("");
	});

	test("each version carries its raw markdown section (heading included, other sections excluded)", () => {
		const [current, older] = parseChangelogHighlights(FIXTURE);
		expect(current.markdown.startsWith("## [0.5.0] - 2026-09-28")).toBe(true);
		expect(current.markdown).toContain("普通亮点 D");
		expect(current.markdown).not.toContain("0.4.9");
		expect(older.markdown.startsWith("## [0.4.9] - 2026-09-01")).toBe(true);
	});

	test("a version with no bold bullets yields an empty highlights array, not an error", () => {
		const [, older] = parseChangelogHighlights(FIXTURE);
		expect(older.highlights).toEqual([]);
	});

	test("empty markdown and markdown without any version section both yield []", () => {
		expect(parseChangelogHighlights("")).toEqual([]);
		expect(parseChangelogHighlights("   \n\t")).toEqual([]);
		expect(parseChangelogHighlights("# MusePi Changelog\n\n一些没有版本段的前言。")).toEqual([]);
	});

	test("a bullet whose bold span is unterminated becomes a title-only highlight", () => {
		const versions = parseChangelogHighlights("## [2.0.0]\n\n### Added\n\n- **没写完的加粗：后续正文。");
		expect(versions[0].highlights).toEqual([{ kind: "added", title: "没写完的加粗：后续正文。", description: "" }]);
	});

	test("a version heading that is not a version at all is skipped like Unreleased", () => {
		const versions = parseChangelogHighlights(
			"## [Unreleased]\n\n- 条目\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- **亮点**：描述。",
		);
		expect(versions.map(v => v.version)).toEqual(["0.1.0"]);
	});
});

describe("flat release notes (this repository's shape)", () => {
	const FLAT = `## [0.7.5] - 2026-11-13

- **子代理会话与转录在跑完后保持可见**：右侧名册改由磁盘记录派生。
  - EN: Subagent sessions stay visible after the run.
- **外观设置新增对话字体与终端字体**：两者分别可选并持久化。
  - EN: Appearance gains a conversation font and a terminal font.
- **内置浏览器新标签默认静音**：仍可按标签单独取消静音。
- **普通条目**：第四条。
- 没有加粗的条目：计入总数，不是亮点。
`;

	test("a section without ### headings counts every bullet and highlights the first three bold ones", () => {
		const [version] = parseChangelogHighlights(FLAT);
		expect(version.version).toBe("0.7.5");
		expect(version.count).toBe(5);
		expect(version.counts).toEqual({ added: 0, fixed: 0, changed: 0, removed: 0 });
		expect(version.highlights.map(h => h.title)).toEqual([
			"子代理会话与转录在跑完后保持可见",
			"外观设置新增对话字体与终端字体",
			"内置浏览器新标签默认静音",
		]);
		expect(version.highlights.every(h => h.kind === "note")).toBe(true);
	});

	test("flat bullets before a category heading stay notes; categorized ones keep their kind", () => {
		const versions = parseChangelogHighlights(`## [1.0.0]

- **未分类**：说明。

### Fixed

- **修复项**：说明。`);
		expect(versions[0]?.highlights.map(h => h.kind)).toEqual(["note", "fixed"]);
		expect(versions[0]?.count).toBe(2);
	});

	test("the shipped CHANGELOG.musepi.md parses with entries and highlights", async () => {
		const path = new URL("../../../packages/coding-agent/CHANGELOG.musepi.md", import.meta.url);
		const markdown = localizeChangelogMarkdown(await Bun.file(path).text(), "zh-CN");
		const [current] = parseChangelogHighlights(markdown);
		expect(current).toBeDefined();
		expect(current?.count).toBeGreaterThan(0);
		expect(current?.highlights.length).toBeGreaterThan(0);
		expect(current?.highlights[0]?.kind).toBe("note");
	});
});

describe("localizeChangelogMarkdown", () => {
	test("Chinese keeps the main bullet and drops every EN child", () => {
		const localized = localizeChangelogMarkdown(FIXTURE, "zh-CN");
		expect(localized).toContain("素材策略行 + 媒体 provider 内联");
		expect(localized).not.toContain("EN:");
		expect(localized).not.toContain("asset-policy row");
		expect(localized).toContain("修复条目 2。");
	});

	test("English promotes the EN body under the same bold title and drops the Chinese body", () => {
		const localized = localizeChangelogMarkdown(FIXTURE, "en-US");
		expect(localized).toContain("- **素材策略行 + 媒体 provider 内联（M3 3.7c）**：asset-policy row");
		expect(localized).not.toContain("欢迎页新增素材单选");
		expect(localized).toContain("Fix entry 1.");
		// A bullet without an EN child keeps its Chinese line (older releases).
		expect(localized).toContain("修复条目 2。");
	});

	test("English highlights still parse from the promoted bullets", () => {
		const versions = parseChangelogHighlights(localizeChangelogMarkdown(FIXTURE, "en-US"));
		expect(versions[0]?.highlights[0]).toEqual({
			kind: "added",
			title: "素材策略行 + 媒体 provider 内联（M3 3.7c）",
			description:
				"asset-policy row + inline media provider (M3 3.7c): a new single-select on the welcome page. The value lands with the send.",
		});
	});
});
