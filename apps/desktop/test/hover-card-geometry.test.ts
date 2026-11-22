import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Hover-card recipe geometry (puppeteer, real cascade).
 *
 * Both sidebar hover cards are one recipe in `gui-chrome.css`
 * (`.gui-hover-card` + its parts). happy-dom reports zero geometry, so the
 * facts this recipe promises can only be read off the real engine:
 *
 *  1. **Padding and row step are the recipe's, not each card's.** Both cards
 *     carry the same box padding and the same row box; only the width differs
 *     (288px session, 240px project). A future card that copies six
 *     declarations instead of the recipe fails here.
 *  2. **The title clamp is per content.** The session card keeps two lines
 *     (its titles are long), the project card one (a project name is a name).
 *  3. **The entrance is one gesture.** `opacity` and `transform` are animated
 *     TOGETHER by `gui-hover-card-in`; a transform-only animation over a class
 *     that flips opacity is not the same thing, and a base `opacity: 0` would
 *     leave the card invisible once the animation is switched off.
 *  4. **Reduced motion lands both immediately and visible** — under
 *     `prefers-reduced-motion` and under the `.gui-motion-off` class.
 *  5. **Hit areas are honest.** Only the project card's directory rows carry
 *     `.gui-hover-card-row--action`; the session card's read-only rows paint
 *     no hover wash.
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
	.map(file => {
		const full = path.join(STYLES, file);
		return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
	})
	.join("\n");

const LONG_TITLE =
	"Refactor the hover-card recipe so both sidebar cards share one surface, one rhythm and one entrance gesture";

const SESSION_CARD = `
	<div class="gui-hover-card gui-session-hover-card" role="tooltip" style="left: 300px; top: 40px;">
		<div class="gui-hover-card-title gui-session-hover-card-title">${LONG_TITLE}</div>
		<div class="gui-hover-card-meta">
			<span class="gui-hover-card-chip gui-session-hover-card-mode">Coder</span>
			<span class="gui-hover-card-dot" aria-hidden="true"></span>
			<span class="gui-session-hover-card-when">Updated 2026-11-22 12:00</span>
		</div>
		<div class="gui-hover-card-rows">
			<div class="gui-hover-card-row">
				<span class="gui-hover-card-icon"></span>
				<span class="gui-hover-card-text">Forked from Parent session</span>
			</div>
			<div class="gui-hover-card-row">
				<span class="gui-hover-card-icon"></span>
				<span class="gui-hover-card-label">Workspace</span>
				<span class="gui-hover-card-text">musepi</span>
			</div>
			<div class="gui-hover-card-row">
				<span class="gui-hover-card-icon gui-hover-card-icon--ghost"></span>
				<span class="gui-hover-card-label">Created</span>
				<span class="gui-hover-card-text">2026-11-01 09:00</span>
			</div>
		</div>
	</div>`;

const PROJECT_CARD = `
	<div class="gui-hover-card gui-project-hover-card" role="group" aria-label="alpha" style="left: 300px; top: 40px;">
		<div class="gui-hover-card-title gui-project-hover-card-title">${LONG_TITLE}</div>
		<div class="gui-hover-card-meta">
			<span class="gui-hover-card-icon"></span>
			<span>2 directories</span>
			<span class="gui-hover-card-dot" aria-hidden="true"></span>
			<span>4 sessions</span>
		</div>
		<ul class="gui-hover-card-rows gui-project-hover-card-list">
			<li class="gui-hover-card-row gui-hover-card-row--action">
				<span class="gui-hover-card-icon"></span>
				<span class="gui-hover-card-text">alpha</span>
				<span class="gui-hover-card-chip">Primary</span>
				<button type="button" class="gui-project-hover-card-open">o</button>
			</li>
			<li class="gui-hover-card-row gui-hover-card-row--action">
				<span class="gui-hover-card-icon"></span>
				<span class="gui-hover-card-text">shared</span>
				<button type="button" class="gui-project-hover-card-open">o</button>
			</li>
		</ul>
	</div>`;

let browser: Browser;
let page: Page;

const ROOT_TOKENS = `
	:root {
		--bg: rgb(18, 18, 18);
		--bg-overlay: rgb(24, 24, 24);
		--color-surface: rgb(32, 32, 32);
		--color-surface-sunken: rgb(28, 28, 28);
		--color-surface-raised: rgb(40, 40, 40);
		--color-text: rgb(235, 235, 235);
		--color-text-muted: rgb(160, 160, 160);
		--color-text-faint: rgb(120, 120, 120);
		--color-accent: rgb(90, 150, 240);
		--border: rgb(70, 70, 70);
		--glass-hover: rgb(255 255 255 / 8%);
		--radius-xs: 4px;
		--radius-sm: 6px;
		--radius-md: 8px;
		--radius-lg: 12px;
		--radius-full: 999px;
		--spring: cubic-bezier(0.34, 1.56, 0.64, 1);
		--z-hover-card: 2600;
		--ui-font-size: 15px;
		--ui-font-size-xs: 13px;
		--gui-glass-blur: 12px;
		--gui-glass-saturate: 140%;
		--gui-glass-overlay: 55%;
		--gui-glass-alpha: 1;
	}
	html, body { height: 100%; margin: 0; }
	/* Tailwind preflight, which the desktop app loads. */
	*, *::before, *::after { box-sizing: border-box; }
`;

async function mount(markup: string, options: { reducedMotion?: boolean; motionOff?: boolean } = {}): Promise<void> {
	await page.emulateMediaFeatures([
		{ name: "prefers-reduced-motion", value: options.reducedMotion ? "reduce" : "no-preference" },
	]);
	await page.setContent(`
		<style>${ROOT_TOKENS}${CASCADE}</style>
		<body class="${options.motionOff ? "gui-motion-off" : ""}">${markup}</body>`);
}

interface CardGeometry {
	cardWidth: number;
	cardHeight: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	titleFontSize: number;
	titleLineHeight: number;
	titleHeight: number;
	titleLines: number;
	rowPaddingTop: number;
	rowPaddingLeft: number;
	rowFontSize: number;
	rowHeight: number;
	iconWidth: number;
	iconOpacity: number;
	dotWidth: number;
	chipRadius: number;
	chipColor: string;
	animationName: string;
	animationDuration: string;
	rowGap: number;
}

async function readCard(selector: string): Promise<CardGeometry> {
	return page.evaluate((cardSelector: string) => {
		const card = document.querySelector<HTMLElement>(cardSelector)!;
		const title = card.querySelector<HTMLElement>(".gui-hover-card-title")!;
		const row = card.querySelector<HTMLElement>(".gui-hover-card-row")!;
		const icon = card.querySelector<HTMLElement>(".gui-hover-card-icon")!;
		const dot = card.querySelector<HTMLElement>(".gui-hover-card-dot");
		const chip = card.querySelector<HTMLElement>(".gui-hover-card-chip");
		const rows = card.querySelector<HTMLElement>(".gui-hover-card-rows");
		const cardStyle = getComputedStyle(card);
		const titleStyle = getComputedStyle(title);
		const rowStyle = getComputedStyle(row);
		const iconStyle = getComputedStyle(icon);
		const lineHeight = Number.parseFloat(titleStyle.lineHeight);
		const titleHeight = title.getBoundingClientRect().height;
		return {
			cardWidth: Math.round(card.getBoundingClientRect().width),
			cardHeight: Math.round(card.getBoundingClientRect().height),
			paddingTop: Number.parseFloat(cardStyle.paddingTop),
			paddingRight: Number.parseFloat(cardStyle.paddingRight),
			paddingBottom: Number.parseFloat(cardStyle.paddingBottom),
			paddingLeft: Number.parseFloat(cardStyle.paddingLeft),
			titleFontSize: Number.parseFloat(titleStyle.fontSize),
			titleLineHeight: lineHeight,
			titleHeight: Math.round(titleHeight * 100) / 100,
			// The clamp is a line count: height / line-height, rounded to a half
			// line so sub-pixel text boxes do not read as a third line.
			titleLines: Math.round((titleHeight / lineHeight) * 2) / 2,
			rowPaddingTop: Number.parseFloat(rowStyle.paddingTop),
			rowPaddingLeft: Number.parseFloat(rowStyle.paddingLeft),
			rowFontSize: Number.parseFloat(rowStyle.fontSize),
			rowHeight: Math.round(row.getBoundingClientRect().height * 100) / 100,
			iconWidth: Number.parseFloat(iconStyle.width),
			iconOpacity: Number.parseFloat(iconStyle.opacity),
			dotWidth: dot ? Number.parseFloat(getComputedStyle(dot).width) : 0,
			chipRadius: chip ? Number.parseFloat(getComputedStyle(chip).borderTopLeftRadius) : 0,
			chipColor: chip ? getComputedStyle(chip).color : "",
			animationName: cardStyle.animationName,
			animationDuration: cardStyle.animationDuration,
			rowGap: rows ? Number.parseFloat(getComputedStyle(rows).gap) : 0,
		};
	}, selector);
}

/** Sample opacity + transform at two instants inside the entrance. */
async function readEntrance(
	selector: string,
): Promise<{ start: { opacity: number; transform: string }; end: { opacity: number; transform: string } }> {
	return page.evaluate(async (cardSelector: string) => {
		const card = document.querySelector<HTMLElement>(cardSelector)!;
		const animation = card.getAnimations()[0];
		if (!animation) throw new Error("card has no entrance animation");
		const sample = (): { opacity: number; transform: string } => {
			const style = getComputedStyle(card);
			return { opacity: Number(style.opacity), transform: style.transform };
		};
		animation.pause();
		animation.currentTime = 0;
		await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
		const start = sample();
		animation.currentTime = 70;
		await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
		const end = sample();
		animation.play();
		await animation.finished.catch(() => {});
		return { start, end };
	}, selector);
}

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
}, 120_000);

afterAll(async () => {
	await browser.close();
}, 60_000);

describe("session hover card geometry", () => {
	test("reads the recipe's box: 288px, the shared padding, xs rows", async () => {
		await mount(SESSION_CARD);
		const geometry = await readCard(".gui-session-hover-card");
		// Width is the session card's own difference (long titles).
		expect(geometry.cardWidth).toBe(288);
		// Padding, row box and icon come from `.gui-hover-card`, not the card.
		expect(geometry.paddingTop).toBe(12);
		expect(geometry.paddingRight).toBe(14);
		expect(geometry.paddingBottom).toBe(10);
		expect(geometry.paddingLeft).toBe(14);
		expect(geometry.rowPaddingTop).toBe(3);
		expect(geometry.rowPaddingLeft).toBe(4);
		expect(geometry.rowFontSize).toBe(13);
		expect(geometry.iconWidth).toBe(12);
		expect(geometry.iconOpacity).toBeCloseTo(0.75, 2);
		// The meta line is the shared structured line, not a label/value stack.
		expect(geometry.dotWidth).toBe(2);
		expect(geometry.chipRadius).toBe(4);
		expect(geometry.chipColor).toBe("rgb(90, 150, 240)");
	});

	test("keeps the two-line title clamp its long titles need", async () => {
		await mount(SESSION_CARD);
		const geometry = await readCard(".gui-session-hover-card");
		expect(geometry.titleFontSize).toBe(15);
		expect(geometry.titleLineHeight).toBeCloseTo(15 * 1.35, 1);
		// Two lines: the clamp hides the rest instead of growing the card.
		expect(geometry.titleLines).toBe(2);
		// A row is a real box with vertical rhythm, not bare text.
		expect(geometry.rowHeight).toBeGreaterThan(geometry.rowFontSize);
		expect(geometry.rowGap).toBe(1);
	});

	test("entrance animates opacity AND transform as one gesture", async () => {
		await mount(SESSION_CARD);
		const geometry = await readCard(".gui-session-hover-card");
		expect(geometry.animationName).toBe("gui-hover-card-in");
		expect(geometry.animationDuration).toBe("0.14s");
		const entrance = await readEntrance(".gui-session-hover-card");
		// Both properties move: a transform-only animation would leave opacity 1.
		expect(entrance.start.opacity).toBeLessThan(0.5);
		expect(entrance.end.opacity).toBeGreaterThan(entrance.start.opacity);
		expect(entrance.start.transform).not.toBe("none");
		// The session card slides in from the row's right.
		expect(entrance.start.transform).toContain("-6");
	});

	test("lands immediately and visible under prefers-reduced-motion", async () => {
		await mount(SESSION_CARD, { reducedMotion: true });
		const geometry = await readCard(".gui-session-hover-card");
		expect(geometry.animationName).toBe("none");
		const opacity = await page.evaluate(() =>
			Number(getComputedStyle(document.querySelector<HTMLElement>(".gui-session-hover-card")!).opacity),
		);
		// The hidden state lives in the keyframe; with the animation off the card
		// is simply visible (a base opacity:0 would leave it invisible forever).
		expect(opacity).toBe(1);
	});

	test("lands immediately and visible under gui-motion-off", async () => {
		await mount(SESSION_CARD, { motionOff: true });
		const geometry = await readCard(".gui-session-hover-card");
		expect(geometry.animationName).toBe("none");
		const opacity = await page.evaluate(() =>
			Number(getComputedStyle(document.querySelector<HTMLElement>(".gui-session-hover-card")!).opacity),
		);
		expect(opacity).toBe(1);
	});

	test("read-only rows carry no hover wash", async () => {
		await mount(SESSION_CARD);
		const washes = await page.evaluate(() => {
			const card = document.querySelector<HTMLElement>(".gui-session-hover-card")!;
			return [...card.querySelectorAll<HTMLElement>(".gui-hover-card-row")].map(row => ({
				action: row.classList.contains("gui-hover-card-row--action"),
				background: getComputedStyle(row).backgroundColor,
			}));
		});
		expect(washes).toHaveLength(3);
		for (const row of washes) {
			expect(row.action).toBe(false);
			// Transparent: a wash here would promise an action that does not exist.
			expect(row.background === "rgba(0, 0, 0, 0)" || row.background === "transparent").toBe(true);
		}
	});
});

describe("project hover card geometry", () => {
	test("reads the same recipe box at its own 240px width", async () => {
		await mount(PROJECT_CARD);
		const geometry = await readCard(".gui-project-hover-card");
		expect(geometry.cardWidth).toBe(240);
		expect(geometry.paddingTop).toBe(12);
		expect(geometry.paddingRight).toBe(14);
		expect(geometry.paddingBottom).toBe(10);
		expect(geometry.paddingLeft).toBe(14);
		expect(geometry.rowPaddingTop).toBe(3);
		expect(geometry.rowPaddingLeft).toBe(4);
		expect(geometry.rowFontSize).toBe(13);
		expect(geometry.iconWidth).toBe(12);
		expect(geometry.rowGap).toBe(1);
	});

	test("keeps its single-line title", async () => {
		await mount(PROJECT_CARD);
		const geometry = await readCard(".gui-project-hover-card");
		expect(geometry.titleLines).toBe(1);
	});

	test("directory rows are the hoverable ones", async () => {
		await mount(PROJECT_CARD);
		const rows = await page.evaluate(() => {
			const card = document.querySelector<HTMLElement>(".gui-project-hover-card")!;
			return [...card.querySelectorAll<HTMLElement>(".gui-hover-card-row")].map(row =>
				row.classList.contains("gui-hover-card-row--action"),
			);
		});
		expect(rows).toEqual([true, true]);
	});

	test("entrance animates opacity and transform together, from above", async () => {
		await mount(PROJECT_CARD);
		const geometry = await readCard(".gui-project-hover-card");
		expect(geometry.animationName).toBe("gui-hover-card-in");
		expect(geometry.animationDuration).toBe("0.14s");
		const entrance = await readEntrance(".gui-project-hover-card");
		expect(entrance.start.opacity).toBeLessThan(0.5);
		expect(entrance.end.opacity).toBeGreaterThan(entrance.start.opacity);
		expect(entrance.start.transform).not.toBe("none");
		// Slides down from above the row (the `--above` variant flips the sign).
		expect(entrance.start.transform).toContain("-4");
	});

	test("lands immediately and visible under reduced motion and gui-motion-off", async () => {
		await mount(PROJECT_CARD, { reducedMotion: true });
		expect((await readCard(".gui-project-hover-card")).animationName).toBe("none");
		const reduced = await page.evaluate(() =>
			Number(getComputedStyle(document.querySelector<HTMLElement>(".gui-project-hover-card")!).opacity),
		);
		expect(reduced).toBe(1);

		await mount(PROJECT_CARD, { motionOff: true });
		expect((await readCard(".gui-project-hover-card")).animationName).toBe("none");
		const off = await page.evaluate(() =>
			Number(getComputedStyle(document.querySelector<HTMLElement>(".gui-project-hover-card")!).opacity),
		);
		expect(off).toBe(1);
	});
});
