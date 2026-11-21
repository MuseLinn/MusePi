import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

const CSS = fs.readFileSync(path.resolve(import.meta.dir, "../src/styles/gui-base.css"), "utf8");
const executablePath = await ensureChromiumExecutable();
if (!executablePath) throw new Error("No Chromium executable resolved");
const browser: Browser = await puppeteer.launch({ executablePath, headless: true });
const page: Page = await browser.newPage();

const BAND = `<span class="gui-edge-blur-tint"></span><span class="gui-edge-blur-layer gui-edge-blur-layer--1"></span>`;

beforeEach(async () => {
	await page.setContent(`
		<style>
			:root {
				--gui-card-surface-fade: rgb(30, 30, 30);
				--gui-blur-progressive-2: 6px;
				--gui-blur-progressive-3: 14px;
			}
			${CSS}
			.fixture-panel {
				position: relative;
				width: 320px;
				height: 400px;
				background: rgb(34, 34, 34);
			}
			.fixture-frame {
				width: 240px;
				height: 300px;
				display: flex;
				flex-direction: column;
			}
			.fixture-scroller {
				flex: 1;
				min-height: 0;
				overflow-y: auto;
			}
			.fixture-page {
				position: relative;
				width: 300px;
				height: 200px;
			}
			.fixture-page .gui-edge-blur--overlay {
				display: block;
				top: 40px;
			}
			.fixture-frame .gui-edge-blur--overlay {
				top: 12px;
			}
		</style>
		<div class="fixture-panel">
			<div class="gui-scroll-frame fixture-frame">
				<div class="fixture-scroller" data-top-scroll="true" data-bottom-scroll="true">
					<div style="height: 1200px"></div>
				</div>
				<div class="gui-edge-blur gui-edge-blur--top" aria-hidden="true">${BAND}</div>
				<div class="gui-edge-blur gui-edge-blur--end" aria-hidden="true">${BAND}</div>
				<div
					class="gui-edge-blur gui-edge-blur--end gui-edge-blur--overlay fixture-frame-overlay"
					aria-hidden="true"
				>${BAND}</div>
			</div>
		</div>
		<div class="fixture-page">
			<div class="gui-edge-blur gui-edge-blur--end gui-edge-blur--overlay" aria-hidden="true">${BAND}</div>
		</div>`);
});

afterAll(async () => {
	await browser.close();
}, 60_000);

describe("scroll edge bands", () => {
	it("anchor to the frame, not the nearest positioned panel", async () => {
		const geometry = await page.evaluate(() => {
			const frame = document.querySelector<HTMLElement>(".fixture-frame")!;
			const band = document.querySelector<HTMLElement>(".gui-scroll-frame > .gui-edge-blur--top")!;
			const bounds = (element: HTMLElement) => {
				const rect = element.getBoundingClientRect();
				return { left: rect.left, width: rect.width };
			};
			return {
				frame: bounds(frame),
				band: bounds(band),
				anchoredToFrame: band.offsetParent === frame,
			};
		});

		// The sidebar card (`.fixture-panel`) is positioned and wider than the
		// list's frame; an unpositioned frame makes it the band's containing
		// block and the feather spans the whole left panel.
		expect(geometry.anchoredToFrame).toBe(true);
		expect(geometry.band.width).toBe(geometry.frame.width);
		expect(geometry.band.left).toBe(geometry.frame.left);
	});

	it("leave the overlay form to the page's own display and placement", async () => {
		const overlay = await page.evaluate(() => {
			const fixturePage = document.querySelector<HTMLElement>(".fixture-page")!;
			const band = document.querySelector<HTMLElement>(".fixture-page .gui-edge-blur--overlay")!;
			const inFrame = document.querySelector<HTMLElement>(".fixture-frame-overlay")!;
			const rect = band.getBoundingClientRect();
			return {
				display: getComputedStyle(band).display,
				top: Math.round(rect.top - fixturePage.getBoundingClientRect().top),
				anchoredToPage: band.offsetParent === fixturePage,
				inFrameDisplay: getComputedStyle(inFrame).display,
				inFrameTop: getComputedStyle(inFrame).top,
			};
		});

		// Capability center owns its band: the page rule flips display and sets
		// the top offset below the tool row. The frame's `:not(--overlay)`
		// display rule must not capture it, and the frame must not win over the
		// page's own placement.
		expect(overlay).toEqual({
			display: "block",
			top: 40,
			anchoredToPage: true,
			inFrameDisplay: "none",
			inFrameTop: "12px",
		});
	});
});
