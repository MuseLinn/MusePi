import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Agent capsule geometry (puppeteer, real cascade).
 *
 * The capsule replaced the per-row orb; two facts are geometric and cannot be
 * asserted in happy-dom:
 *  1. it is centered against the CHAT COLUMN (so the right panel, side panel
 *     and rail all move its center with the column, never the window), and it
 *     sits inside the 52px band the transcript reserves — no message row is
 *     covered at rest;
 *  2. it is pinned, not faded: scrolling the transcript moves the rows and
 *     leaves the capsule's box and opacity untouched.
 *
 * The row-width assertions guard the other half of the change: empty gutters
 * reclaim the desktop's 64px orb column + 12px gap at EVERY width (the shared
 * transcript only collapses it at ≥641px).
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
	"gui-creation.css",
	"gui-pet.css",
	"gui-board.css",
	"gui-widgets.css",
	"gui-misc.css",
	"gui-side-panel.css",
	"gui-glass.css",
]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");
const TRANSCRIPT_CSS = fs.readFileSync(
	path.resolve(import.meta.dir, "../../../packages/client-core/src/components/transcript/transcript.css"),
	"utf8",
);

/** The handful of Tailwind utilities the chat column markup carries. */
const UTILITIES = `
	.flex { display: flex; }
	.flex-col { flex-direction: column; }
	.flex-1 { flex: 1 1 0%; }
	.min-h-0 { min-height: 0; }
	.min-w-0 { min-width: 0; }
	.h-full { height: 100%; }
	.overflow-y-auto { overflow-y: auto; }
	.px-5 { padding-left: 20px; padding-right: 20px; }
	.py-4 { padding-top: 16px; padding-bottom: 16px; }
	.relative { position: relative; }
`;

const ROW = (kind: string, gutter: string, label: string) => `
	<div class="tr-row tr-row--${kind}">
		<div class="tr-gutter">${gutter}</div>
		<div class="tr-body"><p>${label}</p></div>
	</div>`;

const FIXTURE = `
	<div class="gui-shell" id="shell" data-fixture="capsule">
		<div class="gui-main flex min-h-0 flex-1">
			<div class="gui-chat-column gui-float-card flex min-h-0 min-w-0 flex-1 flex-col" style="height: 620px; width: 760px; background: var(--color-surface)">
				<div class="gui-chat-head">
					<div class="gui-chat-head-left"><div class="gui-surface-mode"><button type="button">对话</button></div></div>
					<div class="gui-agent-capsule" data-agent-status="idle">
						<span class="gui-agent-capsule-name">助手</span>
						<span class="gui-agent-capsule-sep" aria-hidden="true"></span>
						<span class="gui-agent-capsule-status">空闲</span>
					</div>
					<button class="gui-chat-info-toggle" type="button">i</button>
				</div>
				<div class="gui-chat-body relative flex min-h-0 min-w-0 flex-1 flex-col">
					<div class="gui-transcript-wrap relative min-h-0 min-w-0 flex-1">
						<div class="gui-transcript min-h-0 min-w-0 h-full overflow-y-auto px-5 py-4">
							<div class="tr-root">
								${ROW("user", "", "用户消息")}
								${ROW("assistant", "", "助手回复正文，占据整行可用宽度。")}
								${ROW("assistant", "垂", "带角标的行保留头像列")}
								${Array.from({ length: 24 }, (_, i) => ROW("assistant", "", `第 ${i + 3} 行正文`)).join("")}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1100, height: 800 });
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
				--border: rgb(70, 70, 70);
				--fg: rgb(235, 235, 235);
				--fg-muted: rgb(170, 170, 170);
				--fg-faint: rgb(120, 120, 120);
				--accent: rgb(90, 150, 240);
				--radius-md: 8px;
				--radius-lg: 12px;
				--radius-2xl: 20px;
				--glass-hairline: rgb(255 255 255 / 10%);
				--glass-rim-hi: rgb(255 255 255 / 8%);
				--shadow-overlay: 0 12px 32px rgb(0 0 0 / 30%);
				--ui-font-size-xs: 11px;
				--ui-font-size-sm: 13px;
				--gui-glass-blur: 12px;
				--gui-glass-saturate: 140%;
			}
			${UTILITIES}
			${TRANSCRIPT_CSS}
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
		const column = select(".gui-chat-column");
		const capsule = select(".gui-agent-capsule");
		const rows = [...document.querySelectorAll<HTMLElement>(".gui-transcript .tr-row")];
		const assistantBodies = rows
			.filter(row => row.classList.contains("tr-row--assistant"))
			.map(row => ({
				gutterEmpty: (row.querySelector(".tr-gutter")?.textContent ?? "").trim() === "",
				row: box(row),
				body: box(row.querySelector(".tr-body")!),
			}));
		return {
			column: box(column),
			capsule: box(capsule),
			capsuleOpacity: getComputedStyle(capsule).opacity,
			firstRow: box(rows[0]!),
			assistantBodies,
		};
	});
}

describe("agent capsule geometry", () => {
	test("centered against the chat column, inside the reserved top band", async () => {
		const before = await readBoxes();
		const capsuleCenter = before.capsule.left + before.capsule.width / 2;
		const columnCenter = before.column.left + before.column.width / 2;
		// ±1px: the capsule is a fixed-width pill and both edges round.
		expect(Math.abs(capsuleCenter - columnCenter)).toBeLessThanOrEqual(1);
		// The scroller reserves 52px for the head row; the pill must end inside it
		// so the first message row is never covered at rest.
		const band = before.firstRow.top - before.column.top;
		expect(before.capsule.bottom - before.column.top).toBeLessThanOrEqual(band);
		expect(before.capsule.height).toBe(28);
	});

	test("pinned, not faded: scrolling moves rows and leaves the capsule alone", async () => {
		const before = await readBoxes();
		await page.evaluate(() => {
			document.querySelector<HTMLElement>(".gui-transcript")!.scrollTop = 420;
		});
		const after = await readBoxes();
		expect(after.capsule).toEqual(before.capsule);
		expect(after.capsuleOpacity).toBe("1");
		// The messages really moved under it.
		expect(after.firstRow.top).toBeLessThan(before.firstRow.top - 100);
	});

	test("empty gutters give the body the full row width", async () => {
		const boxes = await readBoxes();
		const collapsed = boxes.assistantBodies.find(row => row.gutterEmpty);
		const reserved = boxes.assistantBodies.find(row => !row.gutterEmpty);
		expect(collapsed).toBeDefined();
		expect(reserved).toBeDefined();
		if (!collapsed || !reserved) return;
		// No 64px orb column, no 12px gap: the body starts at the row edge.
		expect(collapsed.body.left).toBe(collapsed.row.left);
		expect(Math.abs(collapsed.body.right - collapsed.row.right)).toBeLessThanOrEqual(1);
		// A row that still carries a gutter keeps the column, so the reclaimed
		// width is the 64px + 12px the avatar used to take.
		expect(collapsed.body.width - reserved.body.width).toBeGreaterThanOrEqual(70);
	});
});
