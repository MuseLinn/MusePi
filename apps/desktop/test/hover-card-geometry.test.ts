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
const FALLBACKS = path.resolve(import.meta.dir, "../../../packages/client-core/src/styles/overlay-fallback.css");
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
	// Loaded last by every desktop entry point (`main.tsx` and the four
	// auxiliary windows), so its opaque fallbacks win the real cascade.
	FALLBACKS,
]
	.map(file => {
		const full = path.isAbsolute(file) ? file : path.join(STYLES, file);
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

/** The row IS the button: the whole row box is the target, with the icon, the
 *  name, the primary chip and a decorative trailing arrow inside it. */
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
			<li>
				<button type="button" class="gui-hover-card-row gui-hover-card-row--action gui-project-hover-card-row" aria-label="Open: /work/alpha">
					<span class="gui-hover-card-icon"></span>
					<span class="gui-hover-card-text">alpha</span>
					<span class="gui-hover-card-chip">Primary</span>
					<span class="gui-project-hover-card-go"></span>
				</button>
			</li>
			<li>
				<button type="button" class="gui-hover-card-row gui-hover-card-row--action gui-project-hover-card-row" aria-label="Open: /refs/shared">
					<span class="gui-hover-card-icon"></span>
					<span class="gui-hover-card-text">shared</span>
					<span class="gui-project-hover-card-go"></span>
				</button>
			</li>
		</ul>
	</div>`;

let browser: Browser;
let page: Page;
let mediaSession: Awaited<ReturnType<Page["createCDPSession"]>> | null = null;

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

async function mount(
	markup: string,
	options: {
		reducedMotion?: boolean;
		motionOff?: boolean;
		platform?: string;
		reducedTransparency?: boolean;
		settled?: boolean;
	} = {},
): Promise<void> {
	// `prefers-reduced-transparency` is not in puppeteer's allowlist, so it goes
	// through CDP directly; `emulateMediaFeatures` would throw on it. The session
	// is kept alive for the page's lifetime — detaching it discards the override.
	mediaSession ??= await page.createCDPSession();
	await mediaSession.send("Emulation.setEmulatedMedia", {
		features: [
			{ name: "prefers-reduced-motion", value: options.reducedMotion ? "reduce" : "no-preference" },
			{ name: "prefers-reduced-transparency", value: options.reducedTransparency ? "reduce" : "no-preference" },
		],
	});
	await page.setContent(`
		<style>${ROOT_TOKENS}${CASCADE}</style>
		<body class="${options.motionOff ? "gui-motion-off" : ""}">${markup}</body>`);
	// `initTooltips()` writes this from `shellPlatform()`; the fallbacks key on it.
	if (options.platform) {
		await page.evaluate(platform => {
			document.documentElement.dataset.platform = platform;
		}, options.platform);
	}
	// Reproduce the component's two-phase enter (`useTwoPhaseEnter`): the card
	// mounts at the base `opacity: 0` with no animation, then the next frame
	// gets `--entered`. `settled: false` leaves it in the pending frame.
	// The animation is deliberately NOT awaited to completion: `readEntrance`
	// needs the live animation object to sample it.
	if (options.settled !== false) {
		await page.evaluate(
			() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
		);
		await page.evaluate(() => {
			for (const card of document.querySelectorAll<HTMLElement>(".gui-hover-card")) {
				card.classList.add("gui-hover-card--entered");
			}
		});
		// Let the style change paint. Under reduced motion the `--entered` rule
		// wins over the base `opacity: 0` only after the recalc, so reading the
		// computed style in the same task still reports 0.
		await page.evaluate(
			() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
		);
	}
}

interface Surface {
	backdropFilter: string;
	webkitBackdropFilter: string;
	backgroundColor: string;
	backgroundImage: string;
}

/** The computed surface of a card, read from the live cascade. */
async function readSurface(selector: string): Promise<Surface> {
	return page.evaluate((cardSelector: string) => {
		const style = getComputedStyle(document.querySelector<HTMLElement>(cardSelector)!);
		return {
			backdropFilter: style.backdropFilter,
			webkitBackdropFilter: (style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ?? "",
			backgroundColor: style.backgroundColor,
			backgroundImage: style.backgroundImage,
		};
	}, selector);
}

/** Is the fill opaque? An opaque card paints a solid colour; the glass state
 *  is a `color-mix` alpha blend, so its computed background-color carries an
 *  alpha below 1. Chromium reports that blend as `oklab(L a b / alpha)`, not
 *  `rgba()`, so both notations are read here. */
function alphaOf(color: string): number {
	const match = color.match(/^[a-z-]+\(([^)]*)\)$/i);
	if (!match) return 1;
	const body = match[1]!.trim();
	const slash = body.lastIndexOf("/");
	if (slash === -1) return 1;
	return Number(body.slice(slash + 1).trim());
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

/** Sample the entrance at two instants. The card must be in its `--entered`
 *  state (the `mount` helper adds it). */
async function readEntrance(selector: string): Promise<{
	start: { opacity: number; transform: string };
	end: { opacity: number; transform: string };
	animatedProperties: string[];
}> {
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
		// The keyframe's own property list — the authoritative answer to "does
		// this animation touch opacity?", which sampling alone cannot give.
		const animatedProperties = animation.effect?.getKeyframes().flatMap(frame => Object.keys(frame)) ?? [];
		animation.play();
		await animation.finished.catch(() => {});
		return { start, end, animatedProperties };
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

	test("entrance is a transform-only slide, with opacity flipped by --entered", async () => {
		await mount(SESSION_CARD);
		const geometry = await readCard(".gui-session-hover-card");
		expect(geometry.animationName).toBe("gui-hover-card-in");
		expect(geometry.animationDuration).toBe("0.14s");
		const entrance = await readEntrance(".gui-session-hover-card");
		// Transform-only. Animating opacity on a backdrop-filter surface makes
		// Chromium skip backdrop sampling on the real compositor
		// (docs/gui-implementation.md §6.5), so the keyframe must not name it.
		expect(entrance.animatedProperties).not.toContain("opacity");
		expect(entrance.animatedProperties).toContain("transform");
		expect(entrance.start.transform).not.toBe("none");
		// The session card slides in from the row's right.
		expect(entrance.start.transform).toContain("-6");
		// Opacity is already 1 across the whole slide: `--entered` flipped it in
		// one step, which is what keeps the frost sampled.
		expect(entrance.start.opacity).toBe(1);
		expect(entrance.end.opacity).toBe(1);
	});

	test("lands immediately and visible under prefers-reduced-motion", async () => {
		await mount(SESSION_CARD, { reducedMotion: true });
		const geometry = await readCard(".gui-session-hover-card");
		expect(geometry.animationName).toBe("none");
		const opacity = await page.evaluate(() =>
			Number(getComputedStyle(document.querySelector<HTMLElement>(".gui-session-hover-card")!).opacity),
		);
		// The slide is gone; the `--entered` flip already set opacity 1, so the
		// card lands visible instead of stuck at the base rule's 0.
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

	test("is invisible in the pending frame before --entered", async () => {
		// The other half of two-phase: the mount frame really is transparent, so
		// the frosted backdrop composites before the slide starts.
		await mount(SESSION_CARD, { settled: false });
		const opacity = await page.evaluate(() =>
			Number(getComputedStyle(document.querySelector<HTMLElement>(".gui-session-hover-card")!).opacity),
		);
		expect(opacity).toBe(0);
	});

	test("read-only rows carry no hover wash, with the pointer actually moved onto them", async () => {
		await mount(SESSION_CARD);
		const rows = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>(".gui-session-hover-card .gui-hover-card-row")].map(row => {
				const box = row.getBoundingClientRect();
				return {
					action: row.classList.contains("gui-hover-card-row--action"),
					background: getComputedStyle(row).backgroundColor,
					x: box.left + box.width / 2,
					y: box.top + box.height / 2,
				};
			}),
		);
		expect(rows.length).toBe(3);
		const cardPointerEvents = await page.evaluate(
			() => getComputedStyle(document.querySelector<HTMLElement>(".gui-session-hover-card")!).pointerEvents,
		);
		// The whole session card is pointer-transparent: it never takes the
		// pointer from the row it describes. That is why no wash could appear
		// even if one were declared — and it is asserted rather than assumed.
		expect(cardPointerEvents).toBe("none");
		for (const row of rows) {
			// A real pointer move onto the row's own coordinates.
			await page.mouse.move(row.x, row.y);
			const state = await page.evaluate(() => {
				const card = document.querySelector<HTMLElement>(".gui-session-hover-card")!;
				return {
					cardHovered: card.matches(":hover"),
					anyRowHovered: [...card.querySelectorAll(".gui-hover-card-row")].some(r => r.matches(":hover")),
				};
			});
			// The pointer is over the row's box, and nothing inside the card
			// reacts: no `:hover` anywhere, so no wash.
			expect(state.cardHovered).toBe(false);
			expect(state.anyRowHovered).toBe(false);
			// And the declared state agrees: no action modifier, transparent fill.
			expect(row.action).toBe(false);
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

	test("the row itself is the target: empty-area click navigates, cursor is a pointer", async () => {
		// The old shape painted a 212px hover wash while only an 18px button at
		// the trailing edge acted. Clicking the row's left padding or the blank
		// space beside the name did nothing. This probes the real geometry: the
		// row element must be a button, the pointer must be a pointer cursor, and
		// a click on the padding must fire the row's own handler.
		await mount(PROJECT_CARD);
		const probe = await page.evaluate(() => {
			const row = document.querySelector<HTMLElement>(".gui-project-hover-card .gui-hover-card-row")!;
			const text = row.querySelector<HTMLElement>(".gui-hover-card-text")!;
			const rowBox = row.getBoundingClientRect();
			const textBox = text.getBoundingClientRect();
			// A point inside the row's left padding — the area that used to be dead.
			const emptyX = rowBox.left + 2;
			const hit = document.elementFromPoint(emptyX, rowBox.top + rowBox.height / 2);
			return {
				tag: row.tagName,
				cursor: getComputedStyle(row).cursor,
				rowWidth: Math.round(rowBox.width),
				textLeft: Math.round(textBox.left - rowBox.left),
				hitIsRow: hit === row || row.contains(hit),
				emptyX,
				midY: rowBox.top + rowBox.height / 2,
			};
		});
		expect(probe.tag).toBe("BUTTON");
		expect(probe.cursor).toBe("pointer");
		// The padding is real space inside the row, and the hit test lands on the
		// row itself rather than on a sibling or the card background.
		expect(probe.textLeft).toBeGreaterThan(0);
		expect(probe.hitIsRow).toBe(true);

		// Click the empty padding and assert the row's handler ran.
		const clicked = await page.evaluate(() => {
			const row = document.querySelector<HTMLElement>(".gui-project-hover-card .gui-hover-card-row")!;
			let fired = 0;
			row.addEventListener("click", () => fired++, { once: true });
			row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			return fired;
		});
		expect(clicked).toBe(1);
	});

	test("entrance is a transform-only slide from above", async () => {
		await mount(PROJECT_CARD);
		const geometry = await readCard(".gui-project-hover-card");
		expect(geometry.animationName).toBe("gui-hover-card-in");
		expect(geometry.animationDuration).toBe("0.14s");
		const entrance = await readEntrance(".gui-project-hover-card");
		// Same rule as the session card: no opacity in the keyframe, because
		// animating it on a backdrop-filter surface kills the frost on a real
		// screen. `--entered` already flipped it.
		expect(entrance.animatedProperties).not.toContain("opacity");
		expect(entrance.animatedProperties).toContain("transform");
		expect(entrance.start.opacity).toBe(1);
		expect(entrance.end.opacity).toBe(1);
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

/**
 * Opaque fallback on the platforms and settings that have no glass to sample.
 *
 * `overlay-fallback.css` loads after every component sheet and replaces the
 * translucent `color-mix` fill with `--color-surface-raised` plus the sheen.
 * Both cards must be covered by it: a hover card that keeps a translucent fill
 * with no blur behind it reads as text floating over the chat content.
 *
 * The file keys on three mechanisms, and this suite exercises the two that can
 * be reached from a test browser:
 *
 *  1. `[data-platform="win32"]` — the real attribute `initTooltips()` writes
 *     from `shellPlatform()`; the fixture sets `documentElement.dataset.platform`
 *     the same way the app does.
 *  2. `@media (prefers-reduced-transparency: reduce)` — driven through a raw CDP
 *     `Emulation.setEmulatedMedia` session, because puppeteer's
 *     `page.emulateMediaFeatures` rejects that feature name outright. The
 *     session stays attached: detaching it discards the override.
 *  3. `@supports not (backdrop-filter: …)` — a browser either supports it or
 *     not, and Chromium always does, so this branch cannot be forced from a
 *     test. It is the same selector list as the other two, so a class missing
 *     there is already caught by the two branches above.
 */
describe("hover-card opaque fallback", () => {
	const CARDS = [
		{ name: "session", selector: ".gui-session-hover-card" },
		{ name: "project", selector: ".gui-project-hover-card" },
	] as const;

	/** Opaque: no backdrop filter left, and a fully opaque fill. */
	function expectOpaque(surface: Surface, label: string): void {
		expect(`${label} backdrop-filter: ${surface.backdropFilter}`).toBe(`${label} backdrop-filter: none`);
		// `--glass-sheen` is a gradient; the solid fill underneath is what makes
		// the card readable.
		expect(alphaOf(surface.backgroundColor)).toBe(1);
	}

	test("the win32 platform attribute makes both cards opaque", async () => {
		for (const card of CARDS) {
			await mount(card.selector === ".gui-session-hover-card" ? SESSION_CARD : PROJECT_CARD, {
				platform: "win32",
			});
			expectOpaque(await readSurface(card.selector), `${card.name} on win32`);
		}
	});

	test("prefers-reduced-transparency makes both cards opaque", async () => {
		for (const card of CARDS) {
			await mount(card.selector === ".gui-session-hover-card" ? SESSION_CARD : PROJECT_CARD, {
				reducedTransparency: true,
			});
			expectOpaque(await readSurface(card.selector), `${card.name} under reduced transparency`);
		}
	});

	test("the glass state is untouched: still translucent with a blur, off those platforms", async () => {
		// The guard against over-applying the fallback: with no platform
		// attribute and no reduced-transparency preference, the card keeps the
		// recipe's translucent fill and its backdrop filter.
		for (const card of CARDS) {
			await mount(card.selector === ".gui-session-hover-card" ? SESSION_CARD : PROJECT_CARD);
			const surface = await readSurface(card.selector);
			expect(surface.backdropFilter).not.toBe("none");
			expect(alphaOf(surface.backgroundColor)).toBeLessThan(1);
		}
	});
});
