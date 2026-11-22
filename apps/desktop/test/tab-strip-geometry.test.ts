import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Tab strip geometry (puppeteer, real cascade).
 *
 * Both strips — the header's working set (`.gui-session-tabs-scroll`) and the
 * right panel's instances (`.gui-surface-tabs`) — share one contract:
 *
 *  1. EQUAL LENGTH: every tab holds the same width at a narrow window, and a
 *     long title ellipsizes inside its own tab instead of shrinking the row;
 *  2. SCROLLING INTACT, INDICATOR INVISIBLE: the strip still overflows and
 *     scrolls while `scrollbar-width: none` + `::-webkit-scrollbar` hide the
 *     track. Hiding the indicator by removing the scrolling was the exact
 *     regression this file guards;
 *  3. ACTIVE TAB REACHABLE: an off-screen tab can be brought fully into view.
 *
 * The panel strip's declarations all live in gui-settings.css, including its
 * fixed width and both overflow axes; gui-chat.css carries only the shared
 * contract prose and the `--gui-surface-tab-w` token. The cascade assembled
 * below is the real import order from styles/gui.css.
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = [
	"gui-base.css",
	"gui-tone.css",
	"gui-chrome.css",
	"gui-composer.css",
	"gui-settings.css",
	"gui-chat.css",
	"gui-workspace.css",
	"gui-creation.css",
	"gui-pet.css",
	"gui-board.css",
	"gui-widgets.css",
	"gui-misc.css",
	"gui-side-panel.css",
	"gui-glass.css",
]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

const TITLE = "一个很长的会话标题用来验证省略而不是挤压";

/** Three header tabs in a 360px strip: 3 × 176px cannot fit, so the contract's
 *  two halves are both exercised — equal widths AND real overflow. */
const HEADER_FIXTURE = `
	<div class="gui-shell" style="width: 360px">
		<div class="gui-session-tabs" role="tablist">
			<div class="gui-session-tabs-scroll" id="header-scroll">
				${["a", "b", "c"]
					.map(
						(id, index) => `
					<div class="gui-session-tab-slot">
						<div role="tab" id="session-tab-${id}" class="gui-session-tab${index === 0 ? " gui-session-tab--active" : ""}"${index === 0 ? " data-active-session-tab" : ""}>
							<span class="gui-session-tab-main">
								<span class="gui-session-tab-label" data-long="${index === 1 ? "yes" : "no"}">${index === 1 ? TITLE : `标签 ${id.toUpperCase()}`}</span>
							</span>
						</div>
					</div>`,
					)
					.join("")}
			</div>
		</div>
	</div>`;

/** The panel strip: the same three tabs through `.gui-surface-tab`. */
const PANEL_FIXTURE = `
	<div class="gui-shell" style="width: 300px">
		<div class="gui-surface-tabs" role="tablist" id="panel-scroll">
			${["a", "b", "c"]
				.map(
					(id, index) => `
				<button type="button" role="tab" class="gui-surface-tab${index === 0 ? " gui-surface-tab--active" : ""}">
					<span class="gui-surface-tab-title" data-long="${index === 1 ? "yes" : "no"}">${index === 1 ? TITLE : `面板 ${id.toUpperCase()}`}</span>
				</button>`,
				)
				.join("")}
		</div>
	</div>`;

let browser: Browser;
let page: Page;

const ROOT_TOKENS = `
	:root {
		--color-surface: rgb(32, 32, 32);
		--color-surface-raised: rgb(40, 40, 40);
		--color-text: rgb(235, 235, 235);
		--color-text-muted: rgb(160, 160, 160);
		--color-text-faint: rgb(120, 120, 120);
		--color-accent: rgb(90, 150, 240);
		--color-accent-soft: rgb(60, 90, 140);
		--color-accent-fg: rgb(255, 255, 255);
		--border: rgb(70, 70, 70);
		--radius-md: 8px;
		--radius-lg: 12px;
	}
	* { font-family: sans-serif; }
`;

async function load(fixture: string): Promise<void> {
	await page.setContent(`<style>${ROOT_TOKENS}${CASCADE}</style>${fixture}`);
	await page.evaluate(() =>
		Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
	);
}

interface StripFacts {
	widths: number[];
	scrollWidth: number;
	clientWidth: number;
	overflowX: string;
	overflows: boolean;
	longLabelWidth: number;
	longLabelScrollWidth: number;
	/** The long label is clipped inside its own tab, not inside the strip. */
	longLabelFitsTab: boolean;
}

async function readStrip(scrollId: string, tabClass: string): Promise<StripFacts> {
	return page.evaluate(
		({ scrollId, tabClass }) => {
			const scroll = document.getElementById(scrollId)!;
			const tabs = [...scroll.querySelectorAll<HTMLElement>(`.${tabClass}`)];
			const label = scroll.querySelector<HTMLElement>("[data-long='yes']")!;
			const slot = label.closest<HTMLElement>(`.${tabClass}`)!;
			const labelBox = label.getBoundingClientRect();
			const slotBox = slot.getBoundingClientRect();
			return {
				widths: tabs.map(tab => Math.round(tab.getBoundingClientRect().width)),
				scrollWidth: scroll.scrollWidth,
				clientWidth: scroll.clientWidth,
				overflowX: getComputedStyle(scroll).overflowX,
				overflows: scroll.scrollWidth > scroll.clientWidth,
				longLabelWidth: Math.round(labelBox.width),
				longLabelScrollWidth: label.scrollWidth,
				longLabelFitsTab: labelBox.left >= slotBox.left - 1 && labelBox.right <= slotBox.right + 1,
			};
		},
		{ scrollId, tabClass },
	);
}

/** Scroll to the far end the way a user's repeated gesture would, and report
 *  how much travel the element actually has. */
async function scrollToEnd(scrollId: string): Promise<{ left: number; max: number }> {
	return page.evaluate(id => {
		const node = document.getElementById(id)!;
		const max = node.scrollWidth - node.clientWidth;
		node.scrollLeft = max;
		return { left: Math.round(node.scrollLeft), max };
	}, scrollId);
}

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1000, height: 700 });
});

afterAll(async () => {
	await browser.close();
}, 60_000);

describe("header session tab strip", () => {
	test("three tabs are three equal widths at a narrow window", async () => {
		await load(HEADER_FIXTURE);
		const strip = await readStrip("header-scroll", "gui-session-tab");
		expect(strip.widths).toHaveLength(3);
		// Equal length: one shared width, not three shrunken neighbours.
		expect(new Set(strip.widths).size).toBe(1);
		expect(strip.widths[0]).toBe(176);
	});

	test("a long title ellipsizes inside its own tab instead of shrinking the row", async () => {
		await load(HEADER_FIXTURE);
		const strip = await readStrip("header-scroll", "gui-session-tab");
		// The long label's content overflows its own box (that is the ellipsis)…
		expect(strip.longLabelScrollWidth).toBeGreaterThan(strip.longLabelWidth);
		// …while the box stays inside its fixed tab, never spilling into a neighbour.
		expect(strip.longLabelFitsTab).toBe(true);
		expect(strip.longLabelWidth).toBeLessThanOrEqual(176);
	});

	test("scrolling is intact while the indicator is hidden", async () => {
		await load(HEADER_FIXTURE);
		const strip = await readStrip("header-scroll", "gui-session-tab");
		expect(strip.overflowX).toBe("auto");
		expect(strip.overflows).toBe(true);
		// Indicator hidden by the scrollbar properties, not by removing overflow.
		const scrollbar = await page.evaluate(id => {
			const node = document.getElementById(id)!;
			const style = getComputedStyle(node);
			const webkit = getComputedStyle(node, "::-webkit-scrollbar");
			return { width: style.scrollbarWidth, display: webkit.display };
		}, "header-scroll");
		expect(scrollbar.width).toBe("none");
		expect(scrollbar.display).toBe("none");

		const end = await scrollToEnd("header-scroll");
		expect(end.max).toBeGreaterThan(0);
		expect(end.left).toBeGreaterThanOrEqual(end.max - 1);
	});

	test("an off-screen tab can be brought fully into view", async () => {
		await load(HEADER_FIXTURE);
		const hidden = await page.evaluate(() => {
			const scroll = document.getElementById("header-scroll")!;
			const tab = document.getElementById("session-tab-c")!;
			scroll.scrollLeft = 0;
			const strip = scroll.getBoundingClientRect();
			const box = tab.getBoundingClientRect();
			return { pastRight: box.right - strip.right, width: box.width };
		});
		// The last tab really is hidden past the right edge…
		expect(hidden.pastRight).toBeGreaterThan(0);

		// …and scrolling the strip in brings it fully inside the viewport.
		// Mirrors lib/session-tab-reveal.ts: add the distance the tab overhangs
		// the right edge. At the end of the scroll range the strip's own padding
		// can absorb the last few pixels, so the contract asserted here is "fully
		// visible", not "24px clear of the fade".
		const revealed = await page.evaluate(() => {
			const scroll = document.getElementById("header-scroll")!;
			const tab = document.getElementById("session-tab-c")!;
			const strip = scroll.getBoundingClientRect();
			const box = tab.getBoundingClientRect();
			const delta = box.right - (strip.right - 24);
			if (delta > 0) scroll.scrollLeft += delta;
			const after = tab.getBoundingClientRect();
			const stripAfter = scroll.getBoundingClientRect();
			return {
				moved: scroll.scrollLeft > 0,
				fullyVisible: after.left >= stripAfter.left - 1 && after.right <= stripAfter.right + 1,
			};
		});
		expect(revealed.moved).toBe(true);
		expect(revealed.fullyVisible).toBe(true);
	});
});

describe("right panel tab strip", () => {
	test("the panel's tabs are equal width too", async () => {
		await load(PANEL_FIXTURE);
		const strip = await readStrip("panel-scroll", "gui-surface-tab");
		expect(strip.widths).toHaveLength(3);
		expect(new Set(strip.widths).size).toBe(1);
		expect(strip.widths[0]).toBe(132);
	});

	test("the panel strip keeps horizontal scrolling with no indicator", async () => {
		await load(PANEL_FIXTURE);
		const strip = await readStrip("panel-scroll", "gui-surface-tab");
		expect(strip.overflowX).toBe("auto");
		expect(strip.overflows).toBe(true);
		const scrollbar = await page.evaluate(id => {
			const node = document.getElementById(id)!;
			const style = getComputedStyle(node);
			const webkit = getComputedStyle(node, "::-webkit-scrollbar");
			return { width: style.scrollbarWidth, display: webkit.display };
		}, "panel-scroll");
		expect(scrollbar.width).toBe("none");
		expect(scrollbar.display).toBe("none");

		const end = await scrollToEnd("panel-scroll");
		expect(end.max).toBeGreaterThan(0);
		expect(end.left).toBeGreaterThanOrEqual(end.max - 1);
	});

	test("a long panel title ellipsizes inside its fixed tab", async () => {
		await load(PANEL_FIXTURE);
		const strip = await readStrip("panel-scroll", "gui-surface-tab");
		expect(strip.longLabelScrollWidth).toBeGreaterThan(strip.longLabelWidth);
		expect(strip.longLabelFitsTab).toBe(true);
		expect(strip.longLabelWidth).toBeLessThanOrEqual(132);
	});

	test("drag reorder keeps whole, evenly spaced drop targets", async () => {
		await load(PANEL_FIXTURE);
		// `resolvePanelDrop` (lib/panel-tab-dnd.ts) is rect-based: a drag lands on
		// the chip under the pointer. Fixed widths must therefore leave every tab
		// a full, non-overlapping hit box with an even gap — a squeezed slot would
		// still "work" but the insertion point would jump between narrow targets.
		const targets = await page.evaluate(() => {
			const tabs = [...document.querySelectorAll<HTMLElement>("#panel-scroll .gui-surface-tab")];
			return tabs.map(tab => {
				const box = tab.getBoundingClientRect();
				return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
			});
		});
		expect(targets).toHaveLength(3);
		for (let index = 1; index < targets.length; index += 1) {
			// Monotonic, non-overlapping, and the same gap between every pair.
			expect(targets[index]!.left).toBeGreaterThanOrEqual(targets[index - 1]!.right);
		}
		const gaps = targets.slice(1).map((tab, index) => tab.left - targets[index]!.right);
		expect(new Set(gaps).size).toBe(1);
		// Each target is a full tab wide, so it stays easy to hit while dragging.
		expect(new Set(targets.map(tab => tab.width))).toEqual(new Set([132]));
	});
});
