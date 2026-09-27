import { describe, expect, test } from "bun:test";
import { computeScrollEdgeState, SCROLL_EDGE_THRESHOLD } from "./scroll-shadow";

/** 竖向几何:视口高 100、内容高 300。 */
const V = { clientHeight: 100, scrollHeight: 300 };
/** 横向几何:视口宽 200、内容宽 500。 */
const H = { clientWidth: 200, scrollWidth: 500 };

describe("computeScrollEdgeState", () => {
	test("内容不溢出时四方向全 false —— 羽化不显示", () => {
		expect(
			computeScrollEdgeState({
				scrollTop: 0,
				clientHeight: 100,
				scrollHeight: 100,
				scrollLeft: 0,
				clientWidth: 200,
				scrollWidth: 200,
			}),
		).toEqual({ top: false, bottom: false, left: false, right: false });
	});

	test("纵向:贴顶/贴底/中间三态", () => {
		const atTop = computeScrollEdgeState({ scrollTop: 0, scrollLeft: 0, ...V, ...H });
		expect(atTop).toEqual({ top: false, bottom: true, left: false, right: true });
		// 滚到底:bottom 消失,top 保留。
		const atBottom = computeScrollEdgeState({ scrollTop: 200, scrollLeft: 0, ...V, ...H });
		expect(atBottom).toEqual({ top: true, bottom: false, left: false, right: true });
		const mid = computeScrollEdgeState({ scrollTop: 100, scrollLeft: 150, ...V, ...H });
		expect(mid).toEqual({ top: true, bottom: true, left: true, right: true });
	});

	test("横向:贴右缘时 right 消失(left 保留)", () => {
		const atRight = computeScrollEdgeState({ scrollTop: 0, scrollLeft: 300, ...V, ...H });
		expect(atRight).toEqual({ top: false, bottom: true, left: true, right: false });
	});

	test("阈值边界:滚动距离 ≤ 阈值视为贴在边缘", () => {
		// scrollLeft 恰为阈值:不羽化(内容"还在边缘上")。
		const at = computeScrollEdgeState({
			scrollTop: 0,
			scrollLeft: SCROLL_EDGE_THRESHOLD,
			...V,
			...H,
		});
		expect(at.left).toBe(false);
		// 阈值 +1px:羽化出现。
		const past = computeScrollEdgeState({
			scrollTop: 0,
			scrollLeft: SCROLL_EDGE_THRESHOLD + 1,
			...V,
			...H,
		});
		expect(past.left).toBe(true);
	});

	test("短内容横向不溢出但纵向溢出:横向恒 false", () => {
		const st = computeScrollEdgeState({
			scrollTop: 50,
			clientHeight: 100,
			scrollHeight: 300,
			scrollLeft: 0,
			clientWidth: 200,
			scrollWidth: 180,
		});
		expect(st.top).toBe(true);
		expect(st.left).toBe(false);
		expect(st.right).toBe(false);
	});
});
