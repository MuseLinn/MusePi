import "./happy-dom-shim";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const puppeteer = require("puppeteer-core");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { StartupSplash } = require("../src/components/StartupSplash");
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
}, 60_000);

describe("splash content", () => {
	it("uses only brand visuals and indeterminate progress", () => {
		const html = renderToStaticMarkup(React.createElement(StartupSplash));
		expect(html).toContain("<progress");
		expect(html).toContain('aria-label="Loading"');
		expect(html).not.toContain("gui-splash-tagline");
		expect(html).not.toContain("gui-splash-stall");
		expect(html).not.toContain("<button");
	});

	it("paints the orb from the active pet palette", async () => {
		const html = renderToStaticMarkup(React.createElement(StartupSplash));
		await page.setContent(`<style>${CSS}</style>${html}`);
		const colors = await page.evaluate(() => {
			const root = document.documentElement;
			const variables = ["shell-a", "shell-b", "shell-c", "gold-a", "gold-b", "gold-c"];
			for (const [index, name] of variables.entries()) {
				root.style.setProperty(`--gui-pet-${name}`, `rgb(${index + 1}, 20, 40)`);
			}
			const stops = (id: string) =>
				Array.from(document.querySelectorAll(`#${id} stop`), stop => getComputedStyle(stop).stopColor);
			return { shell: stops("gui-splash-orb-shell"), accessories: stops("gui-splash-orb-rose") };
		});
		expect(colors).toEqual({
			shell: ["rgb(1, 20, 40)", "rgb(2, 20, 40)", "rgb(3, 20, 40)"],
			accessories: ["rgb(4, 20, 40)", "rgb(5, 20, 40)", "rgb(6, 20, 40)"],
		});
	});

	it("keeps indeterminate activity animated after the intro finishes", async () => {
		const html = renderToStaticMarkup(React.createElement(StartupSplash));
		await page.setContent(`<style>${CSS}</style>${html}`);
		await page.evaluate(() => document.documentElement.style.setProperty("--color-accent", "rgb(20, 120, 240)"));
		const progress = await page.$(".gui-splash-progress-track");
		const clip = await progress?.boundingBox();
		if (!clip) throw new Error("splash progress has no visible bounds");
		const first = await page.screenshot({ clip });
		await Bun.sleep(250);
		const second = await page.screenshot({ clip });
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
	});
});

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
