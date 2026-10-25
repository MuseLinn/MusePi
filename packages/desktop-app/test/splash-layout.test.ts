import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const puppeteer = require("puppeteer-core");
const { ensureChromiumExecutable } = require("../../coding-agent/src/tools/browser/launch");
const CSS = ["gui-base.css", "gui-composer.css"]
	.map(file => fs.readFileSync(path.resolve(import.meta.dir, "../src/styles", file), "utf8"))
	.join("\n");

const executablePath = await ensureChromiumExecutable();
if (!executablePath) throw new Error("No Chromium executable resolved");
const browser = await puppeteer.launch({
	executablePath,
	headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600 });

beforeEach(async () => {
	await page.setContent(`
		<style>${CSS}</style>
		<div class="gui-shell">
			<div class="gui-splash">
				<div class="gui-splash-inner"></div>
				<button type="button">Retry</button>
				<a href="https://example.com">Help</a>
			</div>
		</div>`);
});

afterAll(async () => {
	await browser.close();
}, 30_000);

describe("splash drag layout", () => {
	it("fills the shell bounding rect so blank areas remain draggable", async () => {
		const rects = await page.evaluate(() => {
			const shell = document.querySelector(".gui-shell");
			const splash = document.querySelector(".gui-splash");
			if (!shell || !splash) throw new Error("splash fixture did not mount");
			const bounds = (element: Element) => {
				const rect = element.getBoundingClientRect();
				return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
			};
			return { shell: bounds(shell), splash: bounds(splash) };
		});

		expect(rects.splash).toEqual(rects.shell);
	});

	it("keeps buttons and links out of the drag surface", async () => {
		const regions = await page.evaluate(() => {
			const splash = document.querySelector(".gui-splash");
			if (!splash) throw new Error("splash fixture did not mount");
			return {
				splash: getComputedStyle(splash).getPropertyValue("-webkit-app-region"),
				controls: Array.from(splash.querySelectorAll("button, a"), control =>
					getComputedStyle(control).getPropertyValue("-webkit-app-region"),
				),
			};
		});

		expect(regions).toEqual({ splash: "drag", controls: ["no-drag", "no-drag"] });
	});
});
