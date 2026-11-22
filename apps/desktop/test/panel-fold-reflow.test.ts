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
const CASCADE = ["gui-base.css", "gui-chat.css"]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

const FIXTURE = `
	<div style="display: flex; height: 700px">
		<div id="chat" style="flex: 1; min-width: 0; background: rgb(50, 50, 50)">chat</div>
		<aside id="panel" class="gui-pane-right gui-pane-right--inner" style="width: 420px">
			<div class="gui-pane-resize-x"></div>
			<div id="body" style="height: 100%">panel body</div>
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
	test("reflows the chat column once, not every frame", async () => {
		const result = await page.evaluate(async () => {
			const chat = document.querySelector<HTMLElement>("#chat")!;
			const panel = document.querySelector<HTMLElement>("#panel")!;
			const widths: number[] = [];
			panel.classList.add("gui-pane-right--inner--closed");
			const start = performance.now();
			await new Promise<void>(resolve => {
				const tick = (): void => {
					widths.push(Math.round(chat.getBoundingClientRect().width));
					if (performance.now() - start < 400) requestAnimationFrame(tick);
					else resolve();
				};
				requestAnimationFrame(tick);
			});
			// The contents must have finished their composited exit…
			const body = getComputedStyle(document.querySelector<HTMLElement>("#body")!);
			return {
				distinct: [...new Set(widths)],
				frames: widths.length,
				panelWidth: panel.getBoundingClientRect().width,
				bodyOpacity: Number(body.opacity),
			};
		});

		// A per-frame width animation yields one width per frame (15 distinct in
		// the 220ms build this replaced); a snap yields the before/after pair.
		expect(result.frames).toBeGreaterThan(5);
		expect(result.distinct.length).toBeLessThanOrEqual(2);
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
});
