import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const SIDE_PANEL_CSS = fs.readFileSync(path.join(STYLES, "gui-side-panel.css"), "utf8");
const CHAT_CSS = fs.readFileSync(path.join(STYLES, "gui-chat.css"), "utf8");
/** The single owner of -webkit-app-region: the keeper band and the card's
 *  opt-out are declared there, not in the component sheets. */
const WINDOW_DRAG_CSS = fs.readFileSync(path.join(STYLES, "gui-window-drag.css"), "utf8");

/** The real cascade, in gui.css order: the winning rule for every card edge
 *  may come from any of these files, so the fixture loads them all. */
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
	"gui-window-drag.css",
	"gui-glass.css",
]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

/** The handful of Tailwind utilities the shell markup carries. tailwind.out.css
 *  is generated, so the fixture restates only the utilities it uses. */
const UTILITIES = `
	.flex { display: flex; }
	.flex-col { flex-direction: column; }
	.flex-1 { flex: 1 1 0%; }
	.flex-shrink-0 { flex-shrink: 0; }
	.min-h-0 { min-height: 0; }
	.min-w-0 { min-width: 0; }
	.h-12 { height: 48px; }
	.h-9 { height: 36px; }
	.h-full { height: 100%; }
	.items-center { align-items: center; }
	.gap-2 { gap: 8px; }
	.px-4 { padding-left: 16px; padding-right: 16px; }
	.pr-2 { padding-right: 8px; }
	.justify-end { justify-content: flex-end; }
	.relative { position: relative; }
	.overflow-hidden { overflow: hidden; }
	.gui-fixture-panel { width: 1200px; height: 800px; }
`;

const executablePath = await ensureChromiumExecutable();
if (!executablePath) throw new Error("No Chromium executable resolved");
const browser: Browser = await puppeteer.launch({ executablePath, headless: true });
const page: Page = await browser.newPage();

beforeEach(async () => {
	await page.setViewport({ width: 1200, height: 800 });
	// Mirrors the shell from app.tsx: rail + side keeper + chat column, the
	// chat header, and the nested surface/column that carry the card gutters.
	await page.setContent(`
		<style>
			:root {
				--bg-overlay: rgb(24, 24, 24);
				--color-surface: rgb(32, 32, 32);
				--color-surface-sunken: rgb(28, 28, 28);
				--color-surface-raised: rgb(40, 40, 40);
				--color-text: rgb(235, 235, 235);
				--color-text-muted: rgb(160, 160, 160);
				--color-text-faint: rgb(120, 120, 120);
				--color-accent: rgb(90, 150, 240);
				--color-accent-soft: rgb(60, 90, 140);
				--color-accent-bd: rgb(80, 110, 160);
				--color-accent-fg: rgb(255, 255, 255);
				--border: rgb(70, 70, 70);
				--backdrop: rgba(0, 0, 0, 0.5);
				--bg: rgb(20, 20, 20);
				--radius-md: 8px;
				--radius-lg: 12px;
				--radius-2xl: 20px;
				--spring: ease;
				--ui-font-size-sm: 13px;
				--gui-glass-alpha: 1;
				--gui-glass-blur: 12px;
				--gui-glass-saturate: 140%;
			}
			${UTILITIES}
			${CASCADE}
		</style>
		<div class="gui-shell gui-fixture-panel" style="--gui-side-w: 256px">
			<div class="gui-main relative flex min-h-0 flex-1">
				<div class="gui-rail">
					<div class="gui-rail-top"></div>
					<button class="gui-rail-btn" type="button">A</button>
				</div>
				<div class="gui-side-keeper" data-panel="home">
					<button class="gui-sidebar-toggle" type="button">T</button>
					<div class="gui-pane-side gui-pane-side--immersive flex h-full flex-shrink-0 flex-col overflow-hidden">
						<div class="gui-pane-drag flex h-9 flex-shrink-0 items-center justify-end pr-2"></div>
						<div class="gui-sidebar-toggle-seat"></div>
						<div class="gui-side-panel" style="flex: 1; min-height: 0">
							<div class="gui-side-panel-head"><button type="button">New</button></div>
							<div class="gui-side-panel-scroll">
								<button class="gui-side-panel-row" type="button">row</button>
							</div>
						</div>
					</div>
				</div>
				<div class="gui-resize-x gui-resize-x--side" role="separator"></div>
				<div class="gui-chat-col relative flex min-w-0 flex-1 flex-col">
					<div class="gui-chat-col-keeper">
						<header class="gui-header flex h-12 flex-shrink-0 items-center gap-2 px-4">
						</header>
						<div class="gui-surface-area relative flex min-h-0 flex-1 flex-col">
							<main class="gui-pane-center relative flex min-h-0 min-w-0 flex-1 flex-col">
								<div class="gui-chat-surface flex min-h-0 flex-1 flex-col" style="margin: var(--gui-card-gutter)">
									<div class="flex min-h-0 flex-1">
										<div class="gui-scenes relative min-h-0 min-w-0 flex-1">
											<div class="gui-scene gui-scene-chat flex min-h-0 flex-1 flex-col">
												<div class="flex min-h-0 flex-1">
													<div class="gui-chat-column gui-float-card flex min-h-0 min-w-0 flex-1 flex-col" style="background: var(--color-surface)"></div>
												</div>
											</div>
										</div>
									</div>
								</div>
							</main>
						</div>
					</div>
				</div>
			</div>
		</div>`);
	// The keeper's entrance animation scales the column, so a measurement
	// taken mid-animation reports a 2px offset that does not exist at rest.
	await page.evaluate(() =>
		Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
	);
});

afterAll(async () => {
	await browser.close();
}, 60_000);

interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
	bottom: number;
	right: number;
}

/** Rects relative to the shell, so body margins never leak into an assertion. */
async function readGeometry() {
	return page.evaluate(() => {
		const shell = document.querySelector<HTMLElement>(".gui-shell")!;
		const origin = shell.getBoundingClientRect();
		const box = (element: Element): Box => {
			const rect = element.getBoundingClientRect();
			return {
				top: Math.round(rect.top - origin.top),
				left: Math.round(rect.left - origin.left),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				bottom: Math.round(rect.bottom - origin.top),
				right: Math.round(rect.right - origin.left),
			};
		};
		const select = (selector: string) => document.querySelector<HTMLElement>(selector)!;
		return {
			rail: box(select(".gui-rail")),
			railTop: box(select(".gui-rail-top")),
			keeper: box(select(".gui-side-keeper")),
			keeperRegion: getComputedStyle(select(".gui-side-keeper")).webkitAppRegion,
			paneRegion: getComputedStyle(select(".gui-pane-side")).webkitAppRegion,
			railButtonRegion: getComputedStyle(select(".gui-rail-btn")).webkitAppRegion,
			pane: box(select(".gui-pane-side")),
			toggle: box(select(".gui-sidebar-toggle")),
			primaryAction: box(select(".gui-side-panel-head button")),
			header: box(select(".gui-header")),
			surface: box(select(".gui-chat-surface")),
			surfaceMargin: {
				top: getComputedStyle(select(".gui-chat-surface")).marginTop,
				right: getComputedStyle(select(".gui-chat-surface")).marginRight,
				bottom: getComputedStyle(select(".gui-chat-surface")).marginBottom,
				left: getComputedStyle(select(".gui-chat-surface")).marginLeft,
			},
			column: box(select(".gui-chat-column")),
			columnAppRegion: getComputedStyle(select(".gui-chat-column")).webkitAppRegion,
			resizer: box(select(".gui-resize-x--side")),
			rowRegion: getComputedStyle(select(".gui-side-panel-row")).webkitAppRegion,
			rowHit: (() => {
				const row = select(".gui-side-panel-row").getBoundingClientRect();
				const hit = document.elementFromPoint(row.left + row.width / 2, row.top + row.height / 2);
				return hit?.closest(".gui-side-panel-row") ? "row" : (hit?.className ?? "none");
			})(),
			stripHit: (() => {
				// A point inside the empty strip: above the card, right of the rail.
				const keeper = select(".gui-side-keeper").getBoundingClientRect();
				const hit = document.elementFromPoint(keeper.left + keeper.width / 2, origin.top + 20);
				return hit?.closest(".gui-side-keeper") === select(".gui-side-keeper")
					? "keeper"
					: hit?.closest(".gui-pane-side")
						? "pane"
						: (hit?.className ?? "none");
			})(),
		};
	});
}

describe("shell top geometry", () => {
	it("starts both cards one gutter below the header", async () => {
		const { pane, header, column, surfaceMargin } = await readGeometry();
		expect(header.height).toBe(48);
		// One card gutter, not the old stacked window + card gutter pair.
		expect(pane.top - header.bottom).toBe(8);
		expect(column.top - header.bottom).toBe(8);
		expect(column.top).toBe(pane.top);
		// Only the top edge drops the window gutter; the other three keep it.
		expect(surfaceMargin).toEqual({ top: "0px", right: "8px", bottom: "8px", left: "8px" });
	});

	it("keeps the two cards' bottoms aligned", async () => {
		const { pane, column, keeper } = await readGeometry();
		expect(pane.bottom).toBe(column.bottom);
		expect(pane.height).toBe(column.height);
		expect(keeper.bottom - pane.bottom).toBe(16);
	});

	it("makes the strip above the sidebar card a drag surface", async () => {
		const { keeperRegion, paneRegion, keeper, rail, pane, stripHit } = await readGeometry();
		expect(keeperRegion).toBe("drag");
		// The card subtree opts out, so its controls keep their clicks.
		expect(paneRegion).toBe("no-drag");
		expect(keeper.top).toBe(0);
		// The draggable strip is exactly the window top down to the card.
		expect(pane.top - keeper.top).toBe(56);
		// Cards keep one gutter between the rail and sidebar keeper.
		expect(keeper.left - rail.right).toBe(8);
		expect(stripHit).toBe("keeper");
	});

	it("keeps the rail, panel rows and header controls out of the drag band", async () => {
		const { railTop, railButtonRegion, rowRegion, rowHit, columnAppRegion } = await readGeometry();
		expect(railTop.height).toBe(12);
		expect(railButtonRegion).toBe("no-drag");
		// The card subtree is excluded from the keeper's drag region.
		expect(rowRegion).toBe("no-drag");
		expect(rowHit).toBe("row");
		// The chat card is not a drag surface; only its header is.
		expect(columnAppRegion).toBe("none");
	});

	it("follows the card with the sidebar seam handle", async () => {
		const { resizer, pane } = await readGeometry();
		expect(resizer.top).toBe(pane.top);
	});

	it("keeps the persistent toggle at the same screen position in both panel states", async () => {
		const expandedGeometry = await readGeometry();
		const expanded = expandedGeometry.toggle;
		expect(expanded.top).toBeGreaterThanOrEqual(expandedGeometry.pane.top);
		expect(expanded.right).toBeLessThanOrEqual(expandedGeometry.pane.right);
		await page.evaluate(() => {
			const keeper = document.querySelector<HTMLElement>(".gui-side-keeper")!;
			keeper.removeAttribute("data-panel");
			const pane = document.querySelector<HTMLElement>(".gui-pane-side")!;
			pane.classList.add("gui-pane-side--collapsed");
			pane.style.width = "0px";
		});
		await page.evaluate(() =>
			Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
		);
		const folded = (await readGeometry()).toggle;
		expect({ left: folded.left, top: folded.top, width: folded.width, height: folded.height }).toEqual({
			left: expanded.left,
			top: expanded.top,
			width: expanded.width,
			height: expanded.height,
		});
	});

	it("leaves no drag strip when the sidebar is collapsed", async () => {
		await page.evaluate(() => {
			// Folded: `resolveSidebarPanel` drops `data-panel` (no docked pane),
			// so the inactive-pane rule takes over and the inline width 0 wins.
			const keeper = document.querySelector<HTMLElement>(".gui-side-keeper")!;
			keeper.removeAttribute("data-panel");
			const pane = document.querySelector<HTMLElement>(".gui-pane-side")!;
			pane.classList.add("gui-pane-side--collapsed");
			pane.style.width = "0px";
		});
		// The pane animates its width; the folded box is the settled one.
		await page.evaluate(() =>
			Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
		);
		const collapsed = await page.evaluate(() => {
			const keeper = document.querySelector<HTMLElement>(".gui-side-keeper")!;
			const pane = document.querySelector<HTMLElement>(".gui-pane-side")!;
			return {
				pane: Math.round(pane.getBoundingClientRect().width),
				keeper: Math.round(keeper.getBoundingClientRect().width),
			};
		});
		expect(collapsed).toEqual({ pane: 0, keeper: 0 });
	});
	it("reserves the toggle's rect inside every panel head", async () => {
		await page.evaluate(() => {
			document.querySelector(".gui-side-keeper")!.setAttribute("data-panel", "scheduled");
			document.querySelector(".gui-pane-side")!.classList.add("gui-scheduled-slot");
		});
		const { toggle, primaryAction } = await readGeometry();
		expect(primaryAction.left).toBeGreaterThanOrEqual(toggle.right);
	});

	it("keeps one card gutter between the rail and chat after folding", async () => {
		const expanded = (await readGeometry()).toggle;
		await page.evaluate(() => {
			const keeper = document.querySelector(".gui-side-keeper")!;
			keeper.removeAttribute("data-panel");
			const pane = document.querySelector(".gui-pane-side")!;
			pane.classList.add("gui-pane-side--collapsed");
			pane.style.width = "0px";
		});
		await page.evaluate(() =>
			Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
		);
		const { rail, surface, toggle } = await readGeometry();
		expect(surface.left - rail.right).toBe(8);
		expect({ left: toggle.left, top: toggle.top }).toEqual({ left: expanded.left, top: expanded.top });
	});
});

describe("shell top css contract", () => {
	it("declares the sidebar keeper as the drag region and the card as no-drag", () => {
		// One owner (gui-window-drag.css) lists both sides of the contract.
		const bandList = WINDOW_DRAG_CSS.match(/\[data-gui-window-drag="band"\],[\s\S]*?\{[^}]*\}/);
		expect(bandList).not.toBeNull();
		expect(bandList![0]).toContain(".gui-side-keeper");
		expect(bandList![0]).toContain("-webkit-app-region: drag");
		const optOuts = WINDOW_DRAG_CSS.match(/\[data-gui-window-drag="off"\],[\s\S]*?\{[^}]*\}/);
		expect(optOuts).not.toBeNull();
		expect(optOuts![0]).toContain(".gui-side-keeper > .gui-pane-side");
		expect(optOuts![0]).toContain("-webkit-app-region: no-drag");
		// The component sheet keeps geometry only.
		expect(SIDE_PANEL_CSS).not.toMatch(/-webkit-app-region/);
	});

	it("folds only the chat surface's top window gutter", () => {
		const rule = CHAT_CSS.match(/\.gui-chat-surface\s*\{[^}]*margin-top:\s*0\s*!important;[^}]*\}/);
		expect(rule).not.toBeNull();
	});
});
