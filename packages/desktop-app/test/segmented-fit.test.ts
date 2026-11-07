import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const puppeteer = require("puppeteer-core");
const { ensureChromiumExecutable } = require("../../coding-agent/src/tools/browser/launch");

/**
 * 分段控件的真几何(Chromium):等宽段 + 贴合内容 + 单一滑块三者同时成立
 * 的前提是「每段 = 最宽标签的宽度」。
 *
 * `flex: 1 1 0` 的 inline-flex 容器按 max-content 定宽时,宽度 = 各段所需
 * 宽度**之和**,随后两段平分它:「运行中」(52px)+「全部」(40px) → 各 46px,
 * 长的那颗被 `overflow: hidden` 静默裁掉。实机回归:右栏「任务」面板的
 * 运行中/全部滑块文字显示不全。
 *
 * 修复是组件把最宽段写进 `--seg-min`,CSS 用它当下界(见 tokens.css
 * § Segmented control)。这里锁住两侧的合力:不设变量时复现裁剪,设了之后
 * 段等宽、文字完整、滑块与段同宽。量取逻辑本身由
 * client-core/test/segmented-fit.test.ts 的 `segmentFitWidth` 覆盖。
 */

const CSS = fs.readFileSync(path.resolve(import.meta.dir, "../../client-core/src/styles/tokens.css"), "utf8");

function control(labels: readonly string[], segMin: string | null): string {
	const items = labels
		.map(
			label =>
				`<button class="gui-seg-item" aria-checked="false"><span class="gui-seg-item-label">${label}</span></button>`,
		)
		.join("");
	const style = `--seg-count:${labels.length};--seg-index:1;${segMin ? `--seg-min:${segMin};` : ""}`;
	return `<div class="gui-seg gui-seg--compact" role="radiogroup" style="${style}">
		<span class="gui-seg-thumb"></span>${items}
	</div>`;
}

const executablePath = await ensureChromiumExecutable();
if (!executablePath) throw new Error("No Chromium executable resolved");
const browser = await puppeteer.launch({ executablePath, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600 });

afterAll(async () => {
	await browser.close();
}, 60_000);

type Geometry = {
	rootWidth: number;
	segments: {
		width: number;
		clipped: boolean;
		/** 段内宽(含 padding/图标/间距)与标签的可见宽、完整文字宽。 */
		box: number;
		labelBox: number;
		labelText: number;
	}[];
	thumbWidth: number;
};

async function geometry(html: string): Promise<Geometry> {
	await page.setContent(`<style>${CSS}</style><div style="display:flex;padding:16px">${html}</div>`);
	return page.evaluate(() => {
		const root = document.querySelector(".gui-seg") as HTMLElement;
		const segments = Array.from(document.querySelectorAll(".gui-seg-item")).map(item => {
			const label = item.querySelector(".gui-seg-item-label") as HTMLElement | null;
			return {
				width: item.getBoundingClientRect().width,
				// 标签自身才是被裁的那个盒子:item 的 scrollWidth 恒等于
				// clientWidth(label 自己 overflow hidden,不会撑开父级)。
				clipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
				box: item.clientWidth,
				labelBox: label?.clientWidth ?? 0,
				labelText: label?.scrollWidth ?? 0,
			};
		});
		const thumb = document.querySelector(".gui-seg-thumb") as HTMLElement;
		return {
			rootWidth: root.getBoundingClientRect().width,
			segments,
			thumbWidth: thumb.getBoundingClientRect().width,
		};
	});
}

/** 与 `segmentFitWidth` 同一规则,但读的是浏览器真实布局 —— 用它算出
 *  下界再喂回 CSS,就是在断言「组件量出来的那个数确实够用」。 */
function fitOf(geo: Geometry): number {
	return Math.max(
		...geo.segments.map(s => s.labelText + Math.max(0, s.box - s.labelBox)),
		...geo.segments.map(s => s.box),
	);
}

describe("compact segmented control — equal segments, uncut labels", () => {
	it("reproduces the regression without the fit floor (labels share the sum)", async () => {
		const geo = await geometry(control(["运行中", "全部"], null));
		expect(geo.segments[0]!.clipped).toBe(true);
		expect(geo.segments[1]!.clipped).toBe(false);
	});

	it("keeps the long label whole once --seg-min carries the widest segment", async () => {
		const measured = await geometry(control(["运行中", "全部"], null));
		const geo = await geometry(control(["运行中", "全部"], `${fitOf(measured)}px`));
		expect(geo.segments.map(s => s.clipped)).toEqual([false, false]);
	});

	it("keeps both segments equal and the thumb exactly one segment wide", async () => {
		const measured = await geometry(control(["运行中", "全部"], null));
		const floor = fitOf(measured);
		const geo = await geometry(control(["运行中", "全部"], `${floor}px`));
		const [first, second] = geo.segments;
		expect(Math.abs(first!.width - second!.width)).toBeLessThan(1);
		expect(Math.abs(geo.thumbWidth - first!.width)).toBeLessThan(1);
		// 4px = 容器左右 padding(2px × 2),下界 = 段数 × 最宽段。
		expect(geo.rootWidth).toBeGreaterThanOrEqual(2 * floor - 1);
	});

	it("an English pair behaves the same (the floor is not CJK-specific)", async () => {
		// "Running" 是英文里最长的作业筛选标签。
		const measured = await geometry(control(["Running", "All"], null));
		expect(measured.segments[0]!.clipped).toBe(true);
		const geo = await geometry(control(["Running", "All"], `${fitOf(measured)}px`));
		expect(geo.segments.map(s => s.clipped)).toEqual([false, false]);
	});
});
