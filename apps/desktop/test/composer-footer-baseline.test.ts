import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Composer footer controls after the model/thinking chip left the input row.
 *
 * The chip was one of the fixed-height members of the right-hand action group;
 * removing it must not change the shared 26px baseline of the controls that
 * stayed, and a narrow composer must still WRAP the action group onto its own
 * line instead of letting the two groups collide.
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
]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

const CONTROLS = `
	<div class="gui-composer-left">
		<button type="button" class="gui-composer-ico" aria-label="attach">+</button>
		<button type="button" class="gui-composer-ico" aria-label="focus">F</button>
	</div>
	<div class="gui-composer-right">
		<button type="button" class="gui-approval-btn">Approval</button>
		<button type="button" class="gui-composer-send" aria-label="send">→</button>
	</div>`;

const FIXTURE = (width: number) => `
	<div class="gui-composer" style="width:${width}px">
		<div class="gui-composer-row">${CONTROLS}</div>
	</div>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 900, height: 600 });
	await page.setContent(`
		<style>
			:root {
				--color-surface: rgb(32, 32, 32);
				--color-surface-raised: rgb(40, 40, 40);
				--color-text: rgb(235, 235, 235);
				--color-text-muted: rgb(160, 160, 160);
				--color-text-faint: rgb(120, 120, 120);
				--color-accent: rgb(90, 150, 240);
				--border: rgb(70, 70, 70);
				--glass-hairline: rgb(255 255 255 / 10%);
				--glass-rim-hi: rgb(255 255 255 / 8%);
				--glass-sheen: none;
				--glass-edge-hi: rgb(255 255 255 / 8%);
				--glass-edge-lo: rgb(0 0 0 / 20%);
				--radius-md: 8px;
				--radius-lg: 12px;
				--radius-2xl: 20px;
				--spring-liquid: cubic-bezier(0.2, 0.9, 0.2, 1);
				--ui-font-size-xs: 11px;
			}
			${CASCADE}
		</style>
		<div id="host"></div>`);
});

afterAll(async () => {
	await browser.close();
}, 60_000);

interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
}

async function layout(width: number) {
	await page.evaluate(html => {
		document.getElementById("host")!.innerHTML = html;
	}, FIXTURE(width));
	return page.evaluate(() => {
		const box = (selector: string): Box => {
			const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
			return {
				top: Math.round(rect.top),
				left: Math.round(rect.left),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
			};
		};
		const controls = [
			...document.querySelectorAll<HTMLElement>(".gui-composer-ico, .gui-approval-btn, .gui-composer-send"),
		];
		return {
			left: box(".gui-composer-left"),
			right: box(".gui-composer-right"),
			heights: controls.map(control => Math.round(control.getBoundingClientRect().height)),
			substrates: controls.map(control => control.className),
		};
	});
}

describe("composer footer after the chip removal", () => {
	test("the remaining controls keep the shared 26px baseline", async () => {
		const boxes = await layout(560);
		expect(boxes.heights.length).toBe(4);
		for (const height of boxes.heights) expect(height).toBe(26);
	});

	test("both groups share one line while there is room", async () => {
		const boxes = await layout(560);
		expect(Math.abs(boxes.left.top - boxes.right.top)).toBeLessThanOrEqual(1);
		expect(boxes.right.left).toBeGreaterThan(boxes.left.left);
	});

	test("a narrow composer wraps the action group instead of colliding", async () => {
		const boxes = await layout(120);
		// The right group drops below the left group; horizontal overlap is gone.
		expect(boxes.right.top).toBeGreaterThan(boxes.left.top);
		expect(boxes.right.left).toBeGreaterThanOrEqual(boxes.left.left);
	});
});
