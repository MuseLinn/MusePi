import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * The right panel's fold is ONE motion: box, gutter and contents move together.
 *
 * The panel and the chat column are flex siblings. The fold used to snap the box
 * (`width 0s`) and animate only the contents, which read as two different
 * motions in one toggle — the chat column jumped a full panel width in a single
 * frame while the panel's contents morphed. Width, the card gutter and the
 * contents now share the same 220ms spring, once, in one direction; the cost is
 * that the panel subtree and the transcript re-measure per frame for those
 * 220ms.
 *
 * These checks sample the REAL box frame by frame and assert the shape of that
 * motion: the panel shrinks monotonically (never grows past its resting left
 * edge), the column widens monotonically, and both land on the closed state.
 * Geometric, so it cannot be asserted in happy-dom.
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = ["gui-base.css", "gui-chat.css", "gui-misc.css"]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

/** The panel's children mirror ContextPanel: the seam band, the flex column,
 *  and the subagent detail dock (an in-pane drawer that slides both ways). */
const FIXTURE = `
	<div style="display: flex; height: 700px">
		<div id="chat" style="flex: 1; min-width: 0; background: rgb(50, 50, 50)">chat</div>
		<aside id="panel" class="gui-pane-right gui-pane-right--inner" style="width: 420px">
			<div class="gui-pane-resize-x"></div>
			<div id="body" style="height: 100%">panel body</div>
			<div class="gui-agent-dock gui-agent-dock--open" id="dock"><div style="height: 100%">dock</div></div>
		</aside>
	</div>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1200, height: 800 });
	await page.setContent(`
		<style>
			:root {
				--color-surface: rgb(30, 30, 30);
				--color-bg: rgb(20, 20, 20);
				--gui-card-gutter: 8px;
				--gui-pane-transition: width 320ms linear;
				--spring: cubic-bezier(0.2, 0.9, 0.2, 1);
				--border: rgb(70, 70, 70);
				--radius-2xl: 20px;
				--glass-hairline: rgb(255 255 255 / 10%);
				--glass-card-bg: rgb(40 40 40);
				--glass-card-shadow: 0 8px 24px rgb(0 0 0 / 30%);
			}
			${CASCADE}
		</style>
		${FIXTURE}`);
});

afterAll(async () => {
	await browser.close();
}, 60_000);

describe("right panel fold", () => {
	// @guard: revert apps/desktop/src/styles/gui-chat.css:5182 | 		width 220ms var(--spring),
	// @guard: test the panel folds in one direction — box, gutter and contents together
	test("the panel folds in one direction — box, gutter and contents together", async () => {
		const result = await page.evaluate(async () => {
			const chat = document.querySelector<HTMLElement>("#chat")!;
			const panel = document.querySelector<HTMLElement>("#panel")!;
			/** The RESTING box, read BEFORE the toggle: the closed state drops the
			 *  card gutter, and a baseline taken after it would already contain
			 *  the 8px pop this test exists to catch. */
			const readBox = (): { width: number; left: number; marginRight: number; chatWidth: number } => {
				const box = panel.getBoundingClientRect();
				return {
					width: Math.round(box.width),
					left: Math.round(box.left),
					marginRight: Math.round(Number.parseFloat(getComputedStyle(panel).marginRight) * 100) / 100,
					chatWidth: Math.round(chat.getBoundingClientRect().width),
				};
			};
			const resting = readBox();
			const frames: Array<{ width: number; left: number; marginRight: number; chatWidth: number }> = [];
			panel.classList.add("gui-pane-right--inner--closed");
			const start = performance.now();
			await new Promise<void>(resolve => {
				const tick = (): void => {
					frames.push(readBox());
					if (performance.now() - start < 400) requestAnimationFrame(tick);
					else resolve();
				};
				requestAnimationFrame(tick);
			});
			// The contents must have finished their composited exit…
			const body = getComputedStyle(document.querySelector<HTMLElement>("#body")!);
			return {
				resting,
				frames,
				panelWidth: panel.getBoundingClientRect().width,
				bodyOpacity: Number(body.opacity),
			};
		});

		const distinct = (values: number[]): number[] => [...new Set(values)];
		const { resting, frames } = result;

		// The box animates: several intermediate widths, sampled per frame.
		expect(frames.length).toBeGreaterThan(5);
		expect(distinct(frames.map(frame => frame.width)).length).toBeGreaterThan(2);

		// One direction only. The gutter drops with the box, so a frame whose
		// margin finished early would push the panel's left edge right — the box
		// would visibly grow while folding.
		expect(resting.marginRight).toBeGreaterThan(0);
		for (let index = 1; index < frames.length; index++) {
			expect(frames[index]!.width).toBeLessThanOrEqual(frames[index - 1]!.width + 1);
			expect(frames[index]!.left).toBeGreaterThanOrEqual(Math.round(resting.left) - 1);
		}
		// The column takes exactly the width the panel gives up.
		const columnWidths = distinct(frames.map(frame => frame.chatWidth));
		expect(columnWidths.length).toBeGreaterThan(2);
		for (let index = 1; index < frames.length; index++) {
			expect(frames[index]!.chatWidth).toBeGreaterThanOrEqual(frames[index - 1]!.chatWidth - 1);
		}

		// The panel really folded and its contents really left.
		expect(result.panelWidth).toBe(0);
		expect(result.bodyOpacity).toBe(0);
	});

	test("opening the panel animates the column back in the same motion", async () => {
		const result = await page.evaluate(async () => {
			const chat = document.querySelector<HTMLElement>("#chat")!;
			const panel = document.querySelector<HTMLElement>("#panel")!;
			const widths: number[] = [];
			panel.classList.remove("gui-pane-right--inner--closed");
			panel.style.width = "420px";
			const start = performance.now();
			await new Promise<void>(resolve => {
				const tick = (): void => {
					widths.push(Math.round(chat.getBoundingClientRect().width));
					if (performance.now() - start < 400) requestAnimationFrame(tick);
					else resolve();
				};
				requestAnimationFrame(tick);
			});
			return { distinct: [...new Set(widths)], panelWidth: Math.round(panel.getBoundingClientRect().width) };
		});
		expect(result.distinct.length).toBeGreaterThan(2);
		expect(result.panelWidth).toBe(420);
	});

	test("the subagent dock keeps its own exit: visible while it slides, hidden after", async () => {
		/** The dock is a direct child of the panel, so the panel's fold rule
		 *  would match it too. At (0,2,0) it beats the dock's own (0,1,0)
		 *  recipe and replaces `visibility 0s linear 200ms` with a 160ms
		 *  opacity fade — the drawer then hides on the FIRST exit frame and
		 *  plays its 200ms slide invisibly. */
		const result = await page.evaluate(async () => {
			const dock = document.querySelector<HTMLElement>("#dock")!;
			const panel = document.querySelector<HTMLElement>("#panel")!;
			const read = () => ({
				visibility: getComputedStyle(dock).visibility,
				transform: getComputedStyle(dock).transform,
			});
			const resting = read();
			dock.classList.remove("gui-agent-dock--open");
			const frames: Array<{ at: number; visibility: string; transform: string }> = [];
			const start = performance.now();
			await new Promise<void>(resolve => {
				const tick = (): void => {
					const now = performance.now() - start;
					const state = read();
					frames.push({ at: Math.round(now), ...state });
					if (now < 400) requestAnimationFrame(tick);
					else resolve();
				};
				requestAnimationFrame(tick);
			});
			return { resting, frames, panelClosed: panel.classList.contains("gui-pane-right--inner--closed") };
		});

		// It starts open (visible, at rest)…
		expect(result.resting.visibility).toBe("visible");
		// …and while it slides out it must STILL be visible, so the motion is
		// seen. Frame 1 must not already be `hidden`.
		expect(result.frames.length).toBeGreaterThan(5);
		const early = result.frames.filter(frame => frame.at <= 150);
		expect(early.length).toBeGreaterThan(1);
		for (const frame of early) {
			expect(frame.visibility).toBe("visible");
		}
		// It actually moved during the exit (the slide is real, not a snap)…
		expect(new Set(result.frames.map(frame => frame.transform)).size).toBeGreaterThan(2);
		// …and it is hidden only once the exit finished.
		expect(result.frames.at(-1)!.visibility).toBe("hidden");
	});
});
