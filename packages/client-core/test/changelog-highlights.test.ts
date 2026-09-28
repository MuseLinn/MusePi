import { describe, expect, test } from "bun:test";
import { HIGHLIGHTS_PER_VERSION, parseChangelogHighlights } from "../src/lib/changelog-highlights";

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

- **破坏性变更亮点**：不在四类小节里，不算亮点也不计数。

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
		// Added has 5 bullets, Fixed 2, Breaking Changes is not counted.
		expect(current.counts).toEqual({ added: 5, fixed: 2, changed: 0, removed: 0 });
		expect(older.counts).toEqual({ added: 0, fixed: 0, changed: 1, removed: 1 });
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
