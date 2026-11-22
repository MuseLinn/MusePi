import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Project hover card placement + overflow (real cascade, real Chromium).
 *
 * Both facts are geometric and cannot be asserted in happy-dom:
 *
 *  1. **Placement.** The card opens BESIDE the sidebar — its left edge past the
 *     sidebar's right edge, its top level with the hovered row — instead of
 *     covering the sidebar's own session rows. When the window leaves no room
 *     on the right it flips to the sidebar's left side. It also has to escape
 *     the session list's clipping, which is why it portals to `document.body`
 *     and is `position: fixed`: an ancestor with `backdrop-filter`/transform
 *     would otherwise capture it.
 *
 *  2. **Overflow.** The list scrolls vertically and MUST NOT scroll
 *     horizontally. `overflow-y: auto` alone computes the other axis to
 *     `auto`, so a nowrap path row produced a horizontal scrollbar on a card
 *     whose content was complete (the user's report). The assertion is
 *     `scrollWidth === clientWidth` on both the list and the card while the
 *     full path stays readable through the row's `title`.
 *
 * The fixture reproduces the real ancestor chain: the sidebar rail, the
 * scroller, the project block, and a `backdrop-filter` on the workspace layer.
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
	.map(file => {
		const full = path.join(STYLES, file);
		return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
	})
	.join("\n");

/** The handful of Tailwind utilities the sidebar markup carries. */
const UTILITIES = `
	.flex { display: flex; }
	.flex-col { flex-direction: column; }
	.flex-1 { flex: 1 1 0%; }
	.flex-shrink-0 { flex-shrink: 0; }
	.min-h-0 { min-height: 0; }
	.min-w-0 { min-width: 0; }
	.h-full { height: 100%; }
`;

/** One directory path long enough that a nowrap row would overflow the card. */
const LONG_PATH =
	"/Users/example/Documents/Projects/very-long-organisation-name/very-long-repository-name/packages/an-extremely-long-package-name";

const DIRECTORIES = [
	{ path: LONG_PATH, primary: true },
	{ path: "/Users/example/Documents/Projects/short", primary: false },
	{
		path: "/Volumes/External-Work-Drive/Archive Projects/2026/q4-migration/an-even-longer-nested-directory-name",
		primary: false,
	},
];

const ROW_COUNT = 12;

function cardMarkup(): string {
	const rows = Array.from({ length: ROW_COUNT }, (_, index) => {
		const directory = DIRECTORIES[index] ?? {
			path: `/Users/example/Documents/d${index}`,
			primary: false,
		};
		const label = directory.path.split("/").filter(Boolean).pop() ?? directory.path;
		const chip = directory.primary ? '<span class="gui-hover-card-chip">Primary</span>' : "";
		return `
			<li class="gui-hover-card-row gui-hover-card-row--action">
				<span class="gui-hover-card-icon"></span>
				<span class="gui-hover-card-text" title="${directory.path}">${label}</span>
				${chip}
				<button type="button" class="gui-project-hover-card-open" title="Open: ${directory.path}">o</button>
			</li>`;
	}).join("");
	return `
		<div class="gui-hover-card gui-project-hover-card" role="group" aria-label="alpha">
			<div class="gui-hover-card-title gui-project-hover-card-title" title="alpha">alpha</div>
			<div class="gui-hover-card-meta">
				<span class="gui-hover-card-icon"></span>
				<span>12 directories</span>
				<span class="gui-hover-card-dot"></span>
				<span>4 sessions</span>
			</div>
			<ul class="gui-hover-card-rows gui-project-hover-card-list">${rows}</ul>
		</div>`;
}

function fixture({ cardLeft, cardTop }: { cardLeft: string; cardTop: string }): string {
	return `
		<div class="gui-shell" style="height: 100%; display: flex;">
			<div class="gui-main flex min-h-0 flex-1" style="height: 100%;">
				<aside class="gui-pane-side flex flex-shrink-0 flex-col" id="sidebar" style="width: 256px; height: 100%;">
					<div class="gui-sidebar flex flex-col min-h-0 flex-1" style="height: 100%;">
						<div class="gui-scroll-frame flex min-h-0 flex-1 flex-col">
							<div class="gui-sessions-list min-h-0 flex-1" id="scroller" style="overflow-y: auto; height: 100%;">
								<div class="mb-1.5">
									<div class="gui-project-block" id="block" style="height: 28px; margin-top: 120px;">
										<button type="button" class="gui-project-head">alpha</button>
									</div>
								</div>
								${Array.from({ length: 40 }, (_, i) => `<div style="height:24px">row ${i}</div>`).join("")}
							</div>
						</div>
					</div>
				</aside>
				<div class="flex min-h-0 flex-1"></div>
			</div>
		</div>
		<div id="card-host" style="position: fixed; left: ${cardLeft}; top: ${cardTop}; z-index: 100;">
			${cardMarkup()}
		</div>`;
}

let browser: Browser;
let page: Page;

async function mount(options: { cardLeft: string; cardTop: string; width: number; height: number }): Promise<void> {
	await page.setViewport({ width: options.width, height: options.height });
	await page.setContent(`
		<style>
			:root {
				--bg: rgb(18, 18, 18);
				--bg-overlay: rgb(24, 24, 24);
				--color-surface: rgb(32, 32, 32);
				--color-surface-sunken: rgb(28, 28, 28);
				--color-surface-raised: rgb(40, 40, 40);
				--color-text: rgb(235, 235, 235);
				--color-text-muted: rgb(160, 160, 160);
				--color-text-faint: rgb(120, 120, 120);
				--color-accent: rgb(90, 150, 240);
				--color-danger: rgb(220, 90, 90);
				--border: rgb(70, 70, 70);
				--glass-border: rgb(80 80 80 / 60%);
				--glass-bg: rgb(40 40 40 / 70%);
				--glass-sheen: linear-gradient(rgb(255 255 255 / 5%), transparent);
				--glass-hover: rgb(255 255 255 / 8%);
				--radius-xs: 4px;
				--radius-sm: 6px;
				--radius-md: 8px;
				--radius-lg: 12px;
				--radius-xl: 16px;
				--radius-2xl: 20px;
				--radius-full: 999px;
				--spring: cubic-bezier(0.34, 1.56, 0.64, 1);
				--spring-snappy: cubic-bezier(0.2, 0.8, 0.2, 1);
				--z-hover-card: 2500;
				--ui-font-size: 15px;
				--ui-font-size-xs: 13px;
				--ui-font-size-sm: 14px;
				--gui-glass-blur: 12px;
				--gui-glass-saturate: 140%;
				--gui-glass-overlay: 55%;
				--gui-glass-alpha: 1;
				--font-mono: ui-monospace, monospace;
			}
			html, body { height: 100%; margin: 0; }
			${UTILITIES}
			${CASCADE}
		</style>
		${fixture(options)}`);
	await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
}

interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
	right: number;
	bottom: number;
}

async function readGeometry() {
	return page.evaluate(() => {
		const box = (element: Element): Box => {
			const rect = element.getBoundingClientRect();
			return {
				top: Math.round(rect.top),
				left: Math.round(rect.left),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				right: Math.round(rect.right),
				bottom: Math.round(rect.bottom),
			};
		};
		const select = (selector: string) => document.querySelector<HTMLElement>(selector)!;
		const sidebar = select("#sidebar");
		const block = select("#block");
		const card = select(".gui-project-hover-card");
		const list = select(".gui-project-hover-card-list");
		const firstRow = select(".gui-hover-card-row");
		const firstText = select(".gui-hover-card-text");
		const workspace = select(".gui-main");
		const computed = getComputedStyle(card);
		const listStyle = getComputedStyle(list);
		return {
			sidebar: box(sidebar),
			block: box(block),
			card: box(card),
			list: box(list),
			firstRow: box(firstRow),
			cardPosition: computed.position,
			cardParent: card.parentElement?.id ?? "",
			cardIsInsideScroller: Boolean(scroller.contains(card)),
			listOverflowX: listStyle.overflowX,
			listOverflowY: listStyle.overflowY,
			workspaceFilter: getComputedStyle(workspace).backdropFilter,
			cardScrollWidth: card.scrollWidth,
			cardClientWidth: card.clientWidth,
			listScrollWidth: list.scrollWidth,
			listClientWidth: list.clientWidth,
			rowScrollWidth: firstRow.scrollWidth,
			rowClientWidth: firstRow.clientWidth,
			listScrollHeight: list.scrollHeight,
			listClientHeight: list.clientHeight,
			textTitle: firstText.getAttribute("title"),
			textOverflow: getComputedStyle(firstText).textOverflow,
			textWhiteSpace: getComputedStyle(firstText).whiteSpace,
			textWidth: box(firstText).width,
		};
	});
}

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
}, 120_000);

afterAll(async () => {
	await browser.close();
}, 60_000);

describe("project hover card placement", () => {
	/**
	 * The card is placed by the component at runtime; the fixture positions the
	 * host the way `placeProjectCard` computes it so the CSS cascade and the
	 * geometry can be measured together. The pure function has its own unit
	 * tests; this suite proves the RESULT on the real stylesheet.
	 */
	test("opens beside the sidebar, past its right edge, level with the row", async () => {
		// Sidebar is 256px wide starting at x=0; the card goes 8px past it.
		await mount({ cardLeft: "264px", cardTop: "120px", width: 1280, height: 900 });
		const geometry = await readGeometry();

		// (a) Beside, not over: the card's left edge clears the sidebar entirely.
		expect(geometry.card.left).toBeGreaterThanOrEqual(geometry.sidebar.right);
		// (b) Anchored to the row's top, so the reader keeps the row in view.
		expect(Math.abs(geometry.card.top - geometry.block.top)).toBeLessThanOrEqual(2);
		// (c) It left the scroller: neither the block nor the list contains it.
		expect(geometry.cardParent).toBe("card-host");
		expect(geometry.cardIsInsideScroller).toBe(false);
		// (d) `fixed` — not captured by the workspace `backdrop-filter`, whose
		// containing block would otherwise re-anchor it to the workspace box.
		expect(geometry.cardPosition).toBe("fixed");
		expect(geometry.workspaceFilter).not.toBe("none");
	});

	test("fits inside the viewport when it opens on the left instead", async () => {
		// The narrow window: no room right of a 256px sidebar, so the card flips
		// left of it and must still be fully on screen.
		await mount({ cardLeft: "8px", cardTop: "120px", width: 360, height: 900 });
		const geometry = await readGeometry();
		expect(geometry.card.left).toBeGreaterThanOrEqual(0);
		expect(geometry.card.right).toBeLessThanOrEqual(360);
		// Even at 240px in a 360px window the card is not wider than the viewport.
		expect(geometry.card.width).toBeLessThanOrEqual(360);
	});
});

describe("project hover card overflow", () => {
	test("does not scroll horizontally on a complete card with a very long path", async () => {
		await mount({ cardLeft: "264px", cardTop: "120px", width: 1280, height: 900 });
		const geometry = await readGeometry();

		// The declared contract, read off the live cascade: one axis scrolls,
		// the other is explicitly not a scroll container.
		expect(geometry.listOverflowY).toBe("auto");
		expect(geometry.listOverflowX).toBe("clip");

		// The defect the user reported: a complete card that still scrolls
		// sideways. Both the list and the card must be exactly as wide as their
		// content box.
		expect(geometry.listScrollWidth).toBe(geometry.listClientWidth);
		expect(geometry.cardScrollWidth).toBe(geometry.cardClientWidth);
		// And no row is wider than the list it sits in.
		expect(geometry.rowScrollWidth).toBe(geometry.rowClientWidth);
	});

	test("keeps the full path readable without a scrollbar", async () => {
		await mount({ cardLeft: "264px", cardTop: "120px", width: 1280, height: 900 });
		const geometry = await readGeometry();

		// The long path is truncated with an ellipsis …
		expect(geometry.textWhiteSpace).toBe("nowrap");
		expect(geometry.textOverflow).toBe("ellipsis");
		// … and the untruncated value is still available to the reader.
		expect(geometry.textTitle).toBe(LONG_PATH);
		// The label it shows is the basename, so it has something to ellipsize.
		expect(geometry.textWidth).toBeGreaterThan(0);
	});

	test("still scrolls vertically when the directory list exceeds the cap", async () => {
		await mount({ cardLeft: "264px", cardTop: "120px", width: 1280, height: 900 });
		const geometry = await readGeometry();
		// 12 rows overflow the default `min(280px, 50vh)` cap, so the vertical
		// axis must remain a real scroll container — the fix must not trade the
		// horizontal bug for a lost affordance.
		expect(geometry.listScrollHeight).toBeGreaterThan(geometry.listClientHeight);
		const scrolled = await page.evaluate(() => {
			const list = document.querySelector<HTMLElement>(".gui-project-hover-card-list")!;
			list.scrollTop = 9999;
			return { scrollTop: list.scrollTop, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth };
		});
		expect(scrolled.scrollTop).toBeGreaterThan(0);
		expect(scrolled.scrollWidth).toBe(scrolled.clientWidth);
	});
});
