import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * The share dialog's height chain, measured in real Chromium.
 *
 * `DialogFrame` wraps every dialog's children in `.gui-dialog-morph`, whose
 * shared rule is `display: block`. A block wrapper silently voids the body's
 * `flex: 1 1 auto`, so the two columns grew past `max-height: 84vh` and the
 * dialog clipped them with `overflow: hidden`: the start action sat below that
 * edge with no scrollbar and no wheel target — unreachable, not merely
 * off-screen. happy-dom has no layout, so the component suite cannot see it.
 *
 * Three facts are asserted here, each one geometry the cascade produces:
 *
 *  1. The dialog never exceeds its `84vh` cap.
 *  2. The body is the scroller: content taller than the frame yields
 *     `scrollHeight > clientHeight` and moving it actually moves content.
 *  3. The footer does not move when the body scrolls — the decisive action is
 *     outside the scrolling region and fully inside the dialog box.
 *
 * The markup mirrors the component's shell (head → frame → body → footer,
 * with the real class names the component suite also pins). What this cannot
 * prove is copy or taste; those stay a screenshot review.
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = [
	"gui-base.css",
	"gui-tone.css",
	"gui-chrome.css",
	"gui-composer.css",
	"gui-connection.css",
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
	.map(file => {
		const full = path.join(STYLES, file);
		return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
	})
	.join("\n");

const TOKENS = fs.readFileSync(
	path.resolve(import.meta.dir, "../../../packages/client-core/src/styles/tokens.css"),
	"utf8",
);

const EXPOSURE_ROWS = ["Local network", "Cloudflare Tunnel", "ngrok", "Tailscale Serve"]
	.map(
		(name, index) => `
		<div class="gui-collab-exposure" data-selected="${index === 0 ? "true" : "false"}">
			<button type="button" role="radio" aria-checked="${index === 0}" class="gui-collab-exposure-row">
				<span class="gui-collab-radio" data-on="${index === 0}">${index === 0 ? "<span></span>" : ""}</span>
				<span class="gui-collab-exposure-copy">
					<span class="gui-collab-exposure-name">${name}</span>
					<span class="gui-collab-exposure-state">
						<span class="gui-collab-dot${index === 0 ? "" : " gui-collab-dot--off"}"></span>
						<span>${index === 0 ? "Available" : "Unavailable"}</span>
						<span class="gui-collab-exposure-facts">Same network only</span>
					</span>
				</span>
			</button>
			${
				index === 1
					? `<details class="gui-collab-exposure-more">
						<summary>Install Cloudflare Tunnel first</summary>
						<div class="gui-collab-install-body">
							<p>MusePi never installs it for you; quick tunnels need no account.</p>
							<div class="gui-collab-platform"><span>macOS</span><code>brew install cloudflared</code></div>
							<button type="button" class="gui-btn gui-btn-sm">View installation guide</button>
						</div>
					</details>`
					: ""
			}
		</div>`,
	)
	.join("");

const CHANNEL_ROWS = ["Huawei Today", "Discord", "WeChat", "Telegram", "Feishu", "Lark"]
	.map(
		name => `
		<li class="gui-collab-bot-wrap">
			<div class="gui-collab-bot">
				<span class="gui-collab-bot-ico gui-collab-bot-ico--discord"></span>
				<div class="gui-collab-bot-copy">
					<div class="gui-collab-bot-title"><span>${name}</span></div>
					<div class="gui-collab-bot-status">Not connected</div>
				</div>
				<div class="gui-collab-bot-actions">
					<button type="button" class="gui-btn gui-btn-sm">Connect</button>
					<button type="button" class="gui-btn gui-btn-sm gui-collab-icon-action">⚙</button>
				</div>
			</div>
		</li>`,
	)
	.join("");

function fixture(): string {
	return `
		<div class="gui-dialog-backdrop gui-dialog-backdrop--entered">
			<div class="gui-dialog gui-collab-dialog gui-dialog--entered" role="dialog" aria-modal="true" aria-label="Remote access">
				<div class="gui-dialog-morph">
					<div class="gui-dialog-head">
						<h1 class="gui-collab-dialog-title">Remote access</h1>
						<button type="button" class="gui-tool-btn" aria-label="Close">×</button>
					</div>
					<div class="gui-collab-frame gui-scroll-frame">
						<div class="gui-collab-grid">
							<section class="gui-collab-col gui-collab-share">
								<div class="gui-collab-col-head"><h2>Share link</h2></div>
								<div class="gui-collab-setup">
									<p class="gui-collab-desc">Phones and browsers can join this share. Choose a network path, then start sharing.</p>
									<p class="gui-collab-scope-line">Share the whole workspace — guests see every session</p>
									<div class="gui-collab-exposures">
										<div class="gui-collab-group-head"><span>Network path</span><button type="button" class="gui-tool-btn gui-collab-recheck" aria-label="Check again">↻</button></div>
										<div class="gui-collab-exposure-list">${EXPOSURE_ROWS}</div>
									</div>
								</div>
							</section>
							<section class="gui-collab-col gui-collab-channel-col">
								<div class="gui-collab-col-head"><h2>Chat bots</h2></div>
								<p class="gui-collab-desc">Connect a chat bot for longer mobile access.</p>
								<ul class="gui-collab-bots">${CHANNEL_ROWS}</ul>
								<details class="gui-collab-plugins"><summary><span>Channel plugins</span><span class="gui-collab-plugin-count">6</span></summary></details>
							</section>
						</div>
						<div class="gui-edge-blur gui-edge-blur--top" aria-hidden="true"></div>
						<div class="gui-edge-blur gui-edge-blur--end" aria-hidden="true"></div>
					</div>
					<div class="gui-collab-foot">
						<button type="button" class="gui-remote-disclaimer-link">Read the remote-access disclaimer</button>
						<button type="button" class="gui-btn gui-btn-primary gui-collab-foot-action">Start sharing</button>
					</div>
				</div>
			</div>
		</div>`;
}

let browser: Browser;
let page: Page;

async function mount(width: number, height: number): Promise<void> {
	await page.setViewport({ width, height });
	await page.setContent(`
		<style>
			${TOKENS}
			${CASCADE}
			html, body { margin: 0; height: 100%; }
			.gui-tool-btn { display: inline-flex; align-items: center; justify-content: center; }
		</style>
		${fixture()}
	`);
}

interface Measured {
	dialogHeight: number;
	viewportHeight: number;
	bodyScrollHeight: number;
	bodyClientHeight: number;
	footTop: number;
	footBottom: number;
	actionBottom: number;
	dialogBottom: number;
	columnOverflow: number;
}

async function measure(): Promise<Measured> {
	return page.evaluate(() => {
		const dialog = document.querySelector<HTMLElement>(".gui-collab-dialog");
		const body = document.querySelector<HTMLElement>(".gui-collab-grid");
		const foot = document.querySelector<HTMLElement>(".gui-collab-foot");
		const action = document.querySelector<HTMLElement>(".gui-collab-foot-action");
		if (!dialog || !body || !foot || !action) throw new Error("dialog shell did not render");
		const dialogRect = dialog.getBoundingClientRect();
		const footRect = foot.getBoundingClientRect();
		const actionRect = action.getBoundingClientRect();
		const columns = Array.from(dialog.querySelectorAll<HTMLElement>(".gui-collab-col"));
		const columnOverflow = Math.max(...columns.map(column => Math.max(0, column.scrollWidth - column.clientWidth)));
		return {
			dialogHeight: dialogRect.height,
			viewportHeight: window.innerHeight,
			bodyScrollHeight: body.scrollHeight,
			bodyClientHeight: body.clientHeight,
			footTop: footRect.top,
			footBottom: footRect.bottom,
			actionBottom: actionRect.bottom,
			dialogBottom: dialogRect.bottom,
			columnOverflow,
		};
	});
}

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
});

afterAll(async () => {
	await browser?.close();
});

describe("remote access dialog geometry", () => {
	for (const [width, height] of [
		[1280, 800],
		[1280, 640],
	] as const) {
		test(`the body scrolls and the footer stays put at ${width}×${height}`, async () => {
			await mount(width, height);
			const first = await measure();

			// The dialog is capped at 84vh, so the content must fit by scrolling
			// rather than by growing past the window.
			expect(first.dialogHeight).toBeLessThanOrEqual(height * 0.84 + 1);
			expect(first.bodyScrollHeight).toBeGreaterThan(first.bodyClientHeight);

			// The action is inside the dialog box, not clipped by its bottom edge.
			expect(first.actionBottom).toBeLessThanOrEqual(first.dialogBottom);
			expect(first.footBottom).toBeLessThanOrEqual(first.dialogBottom);

			// Scrolling the body must not move the footer: it is a sibling of the
			// scroller, not part of its overflow.
			await page.evaluate(() => {
				const body = document.querySelector<HTMLElement>(".gui-collab-grid");
				if (body) body.scrollTop = body.scrollHeight;
			});
			const scrolled = await measure();
			expect(Math.round(scrolled.footTop)).toBe(Math.round(first.footTop));
			expect(scrolled.actionBottom).toBeLessThanOrEqual(scrolled.dialogBottom);

			// Two 470px columns must not push a horizontal scrollbar.
			expect(first.columnOverflow).toBe(0);
		});
	}

	test("a short dialog whose content fits hides nothing", async () => {
		await mount(1440, 1100);
		const measured = await measure();
		// No overflow means the body must not have invented a scroll range; if
		// it had, the last option would be reachable only by guessing.
		expect(measured.bodyScrollHeight).toBe(measured.bodyClientHeight);
		expect(measured.actionBottom).toBeLessThanOrEqual(measured.dialogBottom);
	});
});
