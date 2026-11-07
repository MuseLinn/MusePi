import { describe, expect, it } from "bun:test";
import { segmentFitWidth } from "../src/components/shell/Segmented";

/**
 * 分段控件「等宽 + 贴合内容」的宽度下界。
 *
 * 等宽段共享同一个宽度,所以最长标签决定所有段;而 CSS 读不到兄弟节点的
 * 「最宽」——`flex: 1 1 0` 分的是标签宽度之和,「运行中」+「全部」各拿 ~30px,
 * 长的那颗被静默裁掉(段落是 nowrap + overflow hidden)。组件把最宽段所需
 * 宽度量出来写进 `--seg-min`,CSS 只负责
 * `min-width: var(--seg-count) * var(--seg-min)`。
 *
 * 纯函数,不依赖布局:这里锁住「量什么」,渲染侧的真几何由
 * desktop-app/test/segmented-fit.test.ts 用 Chromium 断言。
 */
describe("segmentFitWidth — 等宽段的最宽下界", () => {
	it("takes the widest label, not the sum, when every segment is clipped", () => {
		// 「运行中」+「全部」各被压到 30px(padding 16 + 14 的可见文字)。
		const fit = segmentFitWidth([
			{ clientWidth: 30, label: { clientWidth: 14, scrollWidth: 36 } },
			{ clientWidth: 30, label: { clientWidth: 14, scrollWidth: 24 } },
		]);
		// 最宽标签 36 + 段自身 chrome 16 = 52,而不是 (36+24)/2 = 30。
		expect(fit).toBe(52);
	});

	it("keeps a segment that already fits exactly as wide as it is", () => {
		// 未裁剪:scrollWidth === clientWidth,chrome 仍是 16。
		expect(segmentFitWidth([{ clientWidth: 52, label: { clientWidth: 36, scrollWidth: 36 } }])).toBe(52);
	});

	it("falls back to the segment box for icon-only segments", () => {
		expect(segmentFitWidth([{ clientWidth: 30 }, { clientWidth: 30 }])).toBe(30);
	});

	it("returns 0 for a control with no segments (unmeasured stays a no-op)", () => {
		expect(segmentFitWidth([])).toBe(0);
	});

	it("never returns a negative width when chrome is reported larger than the box", () => {
		// 极端测量抖动(隐藏容器、0 宽父级):chrome 夹到 0,不给负下界。
		expect(segmentFitWidth([{ clientWidth: 0, label: { clientWidth: 5, scrollWidth: 8 } }])).toBe(8);
	});
});
