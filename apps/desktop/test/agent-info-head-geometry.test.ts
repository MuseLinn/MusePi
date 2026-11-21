import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Agent tab identity head geometry (puppeteer, real cascade).
 *
 * The chat capsule stays a one-line strip; the TALL identity head belongs to
 * the right panel's Agent tab. Two facts here are geometric and cannot be
 * asserted in happy-dom:
 *  1. the 64px orb is centered at the top of the pane with the agent's name,
 *     lane and live state stacked beneath it, each centered;
 *  2. the head is PINNED to the top of the pane's scroller: scrolling the tab
 *     moves the model/thinking/metadata sections beneath it and leaves the
 *     head's box untouched (opaque glass band, so rows never bleed through).
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = ["gui-base.css", "gui-chat.css", "gui-workspace.css", "gui-glass.css"]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

const SECTIONS = Array.from(
	{ length: 6 },
	(_, i) => `
	<section class="gui-agent-info-section">
		<div class="gui-agent-info-section-head"><span>Section ${i + 1}</span></div>
		<div class="gui-agent-info-row"><span class="gui-agent-info-row-label">Row</span><span class="gui-agent-info-row-value">value ${i + 1}</span></div>
		<div class="gui-agent-info-row"><span class="gui-agent-info-row-label">Row</span><span class="gui-agent-info-row-value">value ${i + 1}</span></div>
	</section>`,
).join("");

const FIXTURE = `
	<div class="gui-right-panel" id="scroller" style="height: 260px; width: 320px; overflow-y: auto; background: var(--color-surface)">
		<div class="gui-agent-info" id="pane">
			<header class="gui-agent-info-head" id="head" data-agent-role="coder">
				<span class="gui-agent-avatar" role="img" aria-label="agent listening">
					<svg width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="none" stroke="currentColor"/></svg>
				</span>
				<div class="gui-agent-info-identity">
					<span class="gui-agent-info-name" id="name">助手</span>
					<span class="gui-agent-role-tag" id="role">编码</span>
					<span class="gui-agent-info-status" id="status" data-state="idle">空闲</span>
					<span class="gui-agent-info-title" id="title">Refactor the panel</span>
				</div>
			</header>
			${SECTIONS}
		</div>
	</div>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 900, height: 700 });
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
				--color-warning: rgb(230, 180, 90);
				--border: rgb(70, 70, 70);
				--radius-md: 8px;
				--radius-lg: 12px;
				--glass-hairline: rgb(255 255 255 / 10%);
				--glass-rim-hi: rgb(255 255 255 / 8%);
				--ui-font-size-xs: 11px;
				--ui-font-size-sm: 13px;
				--gui-glass-blur: 12px;
				--gui-glass-saturate: 140%;
			}
			${CASCADE}
		</style>
		${FIXTURE}`);
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

async function readBoxes() {
	return page.evaluate(() => {
		const box = (element: Element): Box => {
			const rect = element.getBoundingClientRect();
			return {
				top: Math.round(rect.top),
				left: Math.round(rect.left),
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				bottom: Math.round(rect.bottom),
				right: Math.round(rect.right),
			};
		};
		const select = (selector: string) => document.querySelector<HTMLElement>(selector)!;
		const head = select(".gui-agent-info-head");
		return {
			scroller: box(select("#scroller")),
			pane: box(select(".gui-agent-info")),
			head: box(head),
			headPosition: getComputedStyle(head).position,
			headBackground: getComputedStyle(head).backgroundColor,
			avatar: box(select(".gui-agent-info-head .gui-agent-avatar")),
			name: box(select(".gui-agent-info-name")),
			role: box(select(".gui-agent-role-tag")),
			status: box(select(".gui-agent-info-status")),
			title: box(select(".gui-agent-info-title")),
			firstSection: box(select(".gui-agent-info-section")),
		};
	});
}

describe("agent tab identity head geometry", () => {
	test("the 64px orb is centered at the top with name, role and state stacked below", async () => {
		const boxes = await readBoxes();
		expect(boxes.avatar.width).toBe(64);
		expect(boxes.avatar.height).toBe(64);
		const paneCenter = boxes.pane.left + boxes.pane.width / 2;
		for (const part of [boxes.avatar, boxes.name, boxes.role, boxes.status, boxes.title]) {
			expect(Math.abs(part.left + part.width / 2 - paneCenter)).toBeLessThanOrEqual(1);
		}
		// Orb → name → role → state → title, top to bottom.
		expect(boxes.avatar.bottom).toBeLessThanOrEqual(boxes.name.top);
		expect(boxes.name.bottom).toBeLessThanOrEqual(boxes.role.top);
		expect(boxes.role.bottom).toBeLessThanOrEqual(boxes.status.top);
		expect(boxes.status.bottom).toBeLessThanOrEqual(boxes.title.top);
		// The orb owns the head's top: nothing above it but the band's padding.
		expect(boxes.avatar.top - boxes.head.top).toBeLessThanOrEqual(20);
	});

	test("the band is full-bleed across the pane and has its own surface", async () => {
		const boxes = await readBoxes();
		expect(boxes.head.left).toBe(boxes.pane.left);
		expect(boxes.head.width).toBe(boxes.pane.width);
		// Glass, not transparent: sections must not show through the pinned band.
		expect(boxes.headBackground).not.toBe("rgba(0, 0, 0, 0)");
	});

	test("pinned: scrolling the tab moves the sections and leaves the head alone", async () => {
		const before = await readBoxes();
		expect(before.headPosition).toBe("sticky");
		await page.evaluate(() => {
			document.querySelector<HTMLElement>("#scroller")!.scrollTop = 240;
		});
		const after = await readBoxes();
		expect(after.head).toEqual(before.head);
		expect(after.head.top).toBe(before.scroller.top);
		// The content really moved beneath it.
		expect(after.firstSection.top).toBeLessThan(before.firstSection.top - 100);
		await page.evaluate(() => {
			document.querySelector<HTMLElement>("#scroller")!.scrollTop = 0;
		});
	});
});
