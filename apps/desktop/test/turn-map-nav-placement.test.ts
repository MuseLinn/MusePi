import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 轮次条放置契约:两种主线方向共用画布底缘横条——无 top 锚点、无左侧竖带,
 * 顶栏从卡片左缘(12px)开始。因此横条不压顶栏 / Chat|Canvas 切换 tab,画布
 * 也不在左侧留出空列。
 */
const css = readFileSync(join(import.meta.dir, "../src/styles/gui-workspace.css"), "utf8");

function ruleBlock(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("map turn strip placement CSS", () => {
	test("strip is a bottom rail in BOTH directions (no left column, no top anchor)", () => {
		const nav = ruleBlock(".tm-nav");
		expect(nav).toMatch(/position:\s*absolute/);
		// 顶部无锚点:横条只锚底边,顶栏 / 切换 tab 的带不被占用。
		expect(nav).toMatch(/top:\s*auto/);
		expect(nav).not.toMatch(/top:\s*16px/);
		expect(nav).toMatch(/bottom:\s*10px/);
		// 左右留边 + 自动宽度:条目沿 X 展开,不占左侧列。
		expect(nav).toMatch(/left:\s*16px/);
		expect(nav).toMatch(/right:\s*56px/);
		expect(nav).toMatch(/width:\s*auto/);
		expect(nav).toMatch(/height:\s*30px/);
		expect(nav).toMatch(/flex-direction:\s*row/);
		expect(nav).not.toMatch(/left:\s*10px/);
		expect(nav).not.toMatch(/width:\s*30px/);
		expect(nav).not.toMatch(/flex-direction:\s*column/);
	});

	test("no direction-specific strip geometry remains", () => {
		// [data-orient] 只作为状态属性;几何对 v/h 一致,切换方向不改变锚点。
		expect(css).not.toContain('.tm-nav[data-orient="h"]');
		expect(css).not.toContain('.tm-nav[data-orient="v"]');
		const band = ruleBlock(".tm-nav-band");
		expect(band).toMatch(/height:\s*100%/);
		expect(band).toMatch(/width:\s*auto/);
		const viewport = ruleBlock(".tm-nav-viewport");
		// 视口窗走横条几何(left/width),两个方向共用。
		expect(viewport).toMatch(/left:\s*1px/);
		expect(viewport).toMatch(/height:\s*calc\(100% - 2px\)/);
		expect(viewport).toMatch(/transition:\s*left 120ms ease-out, width 120ms ease-out/);
	});

	test("topbar starts at the card gutter and stays above the strip", () => {
		const topbar = ruleBlock(".tm-topbar");
		// 顶栏从卡片左缘开始:底部横条不占左侧列。
		expect(topbar).not.toMatch(/left:\s*64px/);
		expect(topbar).toMatch(/left:\s*12px/);
		expect(topbar).toMatch(/top:\s*46px/);
		// 导航条(z-index 5)在顶栏(6)之下,且无 top 锚点,不进入顶栏/tab 的带。
		expect(ruleBlock(".tm-nav")).toMatch(/z-index:\s*5/);
		expect(topbar).toMatch(/z-index:\s*6/);
	});
});
