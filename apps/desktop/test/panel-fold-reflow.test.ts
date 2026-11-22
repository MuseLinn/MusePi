import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * The right panel's fold must not re-lay out the transcript.
 *
 * The panel and the chat column are flex siblings, so an animated `width` on
 * the panel resizes the column every frame — the transcript is re-laid out 15
 * times over a 220ms fold (measured), and opening the agent capsule spent its
 * first third of a second reflowing text it was not changing. The fold now
 * snaps the box once (a delayed zero-duration `width`) and animates
 * `transform`/`opacity` on the contents, both compositor properties.
 *
 * This samples the REAL column width frame by frame during the fold: the fixed
 * build yields one distinct width, the animated-width build a continuum. It is
 * geometric, so it cannot be asserted in happy-dom.
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
	test("the panel's box holds — width, left edge and gutter — until one snap", async () => {
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

		// A per-frame width animation yields one width per frame (15 distinct in
		// the 220ms build this replaced); a snap yields the before/after pair.
		expect(frames.length).toBeGreaterThan(5);
		expect(distinct(frames.map(frame => frame.width)).length).toBeLessThanOrEqual(2);

		// THE margin regression: the closed state drops the card gutter. If that
		// drop applies on frame 1 while the box is still full width, the panel's
		// left edge jumps 8px right into the freed gutter — the box visibly grows
		// before it folds. Every full-width frame must therefore keep the resting
		// gutter and left edge, which is what a reverted `margin` transition
		// breaks (measured: `left 764 → 772` at frame 1, margin `8px → 0px`).
		expect(resting.marginRight).toBeGreaterThan(0);
		const fullWidth = frames.filter(frame => frame.width === resting.width);
		expect(fullWidth.length).toBeGreaterThan(3);
		for (const frame of fullWidth) {
			expect(frame.marginRight).toBe(resting.marginRight);
			expect(frame.left).toBe(resting.left);
		}
		// Nothing but the final snap may move the column, either.
		expect(distinct(frames.map(frame => frame.chatWidth)).length).toBeLessThanOrEqual(2);

		// The panel really folded and its contents really left.
		expect(result.panelWidth).toBe(0);
		expect(result.bodyOpacity).toBe(0);
	});

	test("opening the panel does not animate the column width either", async () => {
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
		expect(result.distinct.length).toBeLessThanOrEqual(2);
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
