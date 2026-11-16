import { describe, expect, test } from "bun:test";
import { renderUiBlockAscii } from "./ui-block-ascii";

/**
 * A terminal cannot draw components, so a `ui` block is reduced to the content
 * it carries. Showing the program instead would answer a question nobody asked.
 */

describe("ui block in a terminal", () => {
	test("a card of steps and a table reads as content", () => {
		const text = renderUiBlockAscii(
			'root = Stack([Card("迁移顺序", [Steps([{title: "影子写", status: "done"}, {title: "双读", status: "current"}])]), Table(["阶段", "耗时"], [["影子写", "1 天"]])])',
			60,
		);
		expect(text).toContain("▸ 迁移顺序");
		expect(text).toContain("✓ 影子写");
		expect(text).toContain("▸ 双读");
		expect(text).toContain("阶段 | 耗时");
		expect(text).toContain("影子写 | 1 天");
	});

	test("numbers read as numbers, not as source", () => {
		const text = renderUiBlockAscii('root = Stack([Stat("P95", "38ms", "-12%")])', 40);
		expect(text).toBe("  P95: 38ms (-12%)");
	});

	test("a bar chart keeps its proportions", () => {
		const text = renderUiBlockAscii('root = Stack([BarChart(["解析", "渲染"], [Series("耗时", [50, 25])])])', 60);
		expect(text).toContain("解析");
		expect(text).toContain("50");
		expect(text).toContain("█");
	});

	test("a program that is not a block falls back to a code fence", () => {
		expect(renderUiBlockAscii("const x = 1;", 40)).toBeNull();
	});

	test("a block with nothing readable is not claimed as rendered", () => {
		expect(renderUiBlockAscii("root = Stack([])", 40)).toBeNull();
	});
});
