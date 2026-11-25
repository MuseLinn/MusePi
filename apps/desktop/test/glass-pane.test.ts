import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Floating-glass pane (puppeteer, real cascade).
 *
 * `.gui-liquid-glass` is the whole material; hosts add the class and a
 * radius and declare no fill, edge or shadow of their own:
 *
 *  1. **A tint, once.** The warp layer must not inherit the element's fill.
 *     Light is a grey tint, never white — a white pane on a white page leaves
 *     the lit bands nothing to stand out from.
 *  2. **Two lit edges, thin dark sides.** Top and bottom are 1px bands; left
 *     and right are 1px lines; each band is backed by a half-pixel dark
 *     hairline just outside it, and nothing draws around the corners.
 *  3. **The spill sits above the blur.** The 2px band plateau plus the 18px
 *     flare rides the pane's ::after, which paints over the warp layer.
 *  4. **One offset-free lift.** A soft 18px shadow, polarity-scaled.
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CORE = path.resolve(import.meta.dir, "../../../packages/client-core/src/styles");

const CASCADE = [
	path.join(CORE, "tokens.css"),
	path.join(STYLES, "gui-base.css"),
	path.join(STYLES, "gui-composer.css"),
]
	.map(file => fs.readFileSync(file, "utf8"))
	.join("\n");

const MARKUP = `
	<div id="frame" class="gui-composer-frame gui-liquid-glass"></div>
	<div id="probe"></div>`;

type PaneRead = {
	fill: string;
	warpBackground: string;
	edgeBackground: string;
	edgeShadow: string;
	edgePadding: string;
	edgeMask: string;
	shadow: string;
	band: string;
	side: string;
	hairline: string;
};

let browser: Browser;
let page: Page;

async function readPane(): Promise<PaneRead> {
	return page.evaluate(() => {
		const frame = document.getElementById("frame") as HTMLElement;
		const probe = document.getElementById("probe") as HTMLElement;
		const edge = getComputedStyle(frame, "::after");
		const color = (token: string): string => {
			probe.style.color = `var(${token})`;
			return getComputedStyle(probe).color;
		};
		return {
			fill: getComputedStyle(frame).backgroundColor,
			warpBackground: getComputedStyle(frame, "::before").backgroundImage,
			edgeBackground: edge.backgroundImage,
			edgeShadow: edge.boxShadow,
			edgePadding: edge.paddingTop,
			edgeMask: edge.maskImage,
			shadow: getComputedStyle(frame).boxShadow,
			band: color("--glass-pane-band"),
			side: color("--glass-pane-side"),
			hairline: color("--glass-pane-hairline"),
		};
	});
}

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	// The pane's dark material is the default; the OS scheme decides whether
	// the system-light fallback applies, so pin the host preference instead of
	// inheriting whichever scheme this machine runs.
	await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
	await page.setContent(`<style>${CASCADE}</style>${MARKUP}`);
	// Theme flips make the pane's shadow transition; read the landed value.
	await page.addStyleTag({ content: ".gui-liquid-glass{transition:none!important}" });
});

afterAll(async () => {
	await browser?.close();
});

describe("floating-glass pane", () => {
	test("paints the tint once", async () => {
		const { fill, warpBackground } = await readPane();
		expect(fill).toContain("/ 0.4)");
		expect(warpBackground).toBe("none");
	});

	test("draws lit bands and dark sides, never a closed ring", async () => {
		const { edgeShadow, edgePadding, edgeMask, band, side, hairline } = await readPane();
		expect(edgePadding).toBe("0px");
		expect(edgeMask).toBe("none");
		expect(edgeShadow).toContain("1px 0px 0px 0px inset");
		expect(edgeShadow).toContain("0px 1px 0px 0px inset");
		expect(edgeShadow).toContain("0px -0.5px");
		expect(edgeShadow).toContain("0px 0.5px");
		expect(band).toContain("/ 0.22)");
		expect(side).toContain("/ 0.14)");
		expect(hairline).toContain("/ 0.5)");
	});

	test("carries the inner spill above the warp layer", async () => {
		const { edgeBackground } = await readPane();
		expect(edgeBackground).toContain("2px");
		expect(edgeBackground).toContain("18px");
		expect(edgeBackground).toContain("/ 0.077)");
		expect(edgeBackground.split("linear-gradient").length - 1).toBe(2);
	});

	test("lifts with one offset-free shadow", async () => {
		const { shadow } = await readPane();
		expect(shadow).toContain("0px 0px 18px");
		expect(shadow).toContain("/ 0.3)");
	});

	test("light panes are grey with white bands and dark sides", async () => {
		await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
		const { fill, edgeShadow, band, side, hairline, shadow } = await readPane();
		expect(fill).toContain("/ 0.45)");
		expect(band).toBe("oklch(1 0 0)");
		expect(side).toBe("oklch(0 0 0 / 0.24)");
		expect(hairline).toBe("oklch(0 0 0 / 0.2)");
		expect(edgeShadow).toContain("oklch(0 0 0 / 0.24) 1px 0px");
		expect(shadow).toContain("/ 0.06)");
		await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
	});
});
