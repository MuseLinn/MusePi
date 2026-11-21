import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";
import { SettingsNav } from "../src/components/SettingsNav";

/**
 * Window-chrome drag contract (gui-window-drag.css).
 *
 * Chromium computes `-webkit-app-region` as an INHERITED property: a `drag`
 * element makes every descendant compute `drag` as well, and only an explicit
 * `no-drag` descendant escapes it. So a chrome band either declares the region
 * itself or inherits one from an ancestor — a strip with neither is dead, and
 * the pointer falls through to nothing the window can grab.
 *
 * The settings rail used to be exactly that: the nav column portals into
 * `.gui-settings-nav-slot`, the slot declared no region, and the nav painted
 * from the slot's top edge — every pixel of the strip above 返回 / 搜索
 * computed `none` while the main view's equivalent strip dragged.
 *
 * These checks measure the real cascade at real coordinates: which element
 * owns each band, what region it computes, and whether a control inside keeps
 * its click.
 */

const SRC = path.resolve(import.meta.dir, "../src");
const STYLES = path.join(SRC, "styles");
export const OWNER_STYLE = "gui-window-drag.css";

/** The real cascade in gui.css order, owner sheet included. */
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
	OWNER_STYLE,
	"gui-glass.css",
]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

const TOKENS = `
	:root {
		--bg-overlay: rgb(24, 24, 24);
		--bg: rgb(20, 20, 20);
		--color-surface: rgb(32, 32, 32);
		--color-surface-sunken: rgb(28, 28, 28);
		--color-surface-raised: rgb(40, 40, 40);
		--color-text: rgb(235, 235, 235);
		--color-text-muted: rgb(160, 160, 160);
		--color-text-faint: rgb(120, 120, 120);
		--color-accent: rgb(90, 150, 240);
		--border: rgb(70, 70, 70);
		--backdrop: rgba(0, 0, 0, 0.5);
		--radius-md: 8px;
		--radius-lg: 12px;
		--radius-2xl: 20px;
		--spring: ease;
		--ui-font-size: 15px;
		--ui-font-size-sm: 13px;
		--font-ui: system-ui, sans-serif;
		--gui-glass-alpha: 1;
		--gui-glass-blur: 12px;
		--gui-glass-saturate: 140%;
		--control-height-field: 34px;
		--control-height-compact: 28px;
		--control-fill: rgba(255, 255, 255, 0.04);
		--control-hairline: rgb(70, 70, 70);
		--control-rim: inset 0 1px 0 rgba(255, 255, 255, 0.08);
		--control-font-size: 13px;
	}
	*, ::before, ::after { box-sizing: border-box; }
	body { margin: 0; }
	svg { display: block; }
	.flex { display: flex; }
	.flex-col { flex-direction: column; }
	.flex-1 { flex: 1 1 0%; }
	.flex-none { flex: none; }
	.flex-shrink-0 { flex-shrink: 0; }
	.min-h-0 { min-height: 0; }
	.min-w-0 { min-width: 0; }
	.h-12 { height: 48px; }
	.h-9 { height: 36px; }
	.h-full { height: 100%; }
	.w-full { width: 100%; }
	.h-4 { width: 16px; height: 16px; }
	.w-4 { width: 16px; }
	.items-center { align-items: center; }
	.justify-end { justify-content: flex-end; }
	.gap-0\\.5 { gap: 2px; }
	.gap-2 { gap: 8px; }
	.px-2 { padding-left: 8px; padding-right: 8px; }
	.px-4 { padding-left: 16px; padding-right: 16px; }
	.py-2 { padding-top: 8px; padding-bottom: 8px; }
	.pr-2 { padding-right: 8px; }
	.p-0\\.5 { padding: 2px; }
	.mb-0\\.5 { margin-bottom: 2px; }
	.mb-1 { margin-bottom: 4px; }
	.rounded-md { border-radius: 6px; }
	.border-t { border-top: 1px solid var(--border); }
	.relative { position: relative; }
	.overflow-hidden { overflow: hidden; }
	.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.text-left { text-align: left; }
`;

/** The workspace shell (AppRail + session sidebar + chat column). */
const MAIN_SHELL = `
	<div class="gui-shell" style="width: 1200px; height: 800px; --gui-side-w: 256px">
		<div class="gui-main relative flex min-h-0 flex-1">
			<div class="gui-rail">
				<div class="gui-rail-top" aria-hidden="true"></div>
				<button class="gui-rail-btn" id="rail-btn" type="button">A</button>
			</div>
			<div class="gui-side-keeper" data-panel="home">
				<div class="gui-pane-side gui-pane-side--immersive flex h-full flex-shrink-0 flex-col overflow-hidden">
					<div class="gui-pane-drag flex h-9 flex-shrink-0 items-center justify-end pr-2"></div>
					<div class="gui-side-menu flex flex-col gap-2 px-4">
						<button class="gui-menu-item" id="main-new" type="button">新建任务</button>
					</div>
				</div>
			</div>
			<div class="gui-chat-col relative flex min-w-0 flex-1 flex-col">
				<div class="gui-chat-col-keeper">
					<header class="gui-header flex h-12 flex-shrink-0 items-center gap-2 px-4">
						<button class="gui-sidebar-toggle" id="main-header-btn" type="button">T</button>
					</header>
					<div class="gui-surface-area relative flex min-h-0 flex-1 flex-col">
						<main class="gui-pane-center relative flex min-h-0 min-w-0 flex-1 flex-col">
							<div class="gui-drag-strip" aria-hidden></div>
							<div class="gui-chat-surface flex min-h-0 flex-1 flex-col">
								<div class="gui-chat-column gui-float-card flex min-h-0 min-w-0 flex-1 flex-col"></div>
							</div>
						</main>
					</div>
				</div>
			</div>
		</div>
	</div>`;

/** The settings shell: nav portalled into the sidebar slot (its real markup),
 *  content in the chat column. `app.tsx` marks the slot as the band. */
function settingsShell(navHtml: string): string {
	return `
	<div class="gui-shell" style="width: 1200px; height: 800px; --gui-side-w: 256px">
		<div class="gui-main relative flex min-h-0 flex-1">
			<div class="gui-rail">
				<div class="gui-rail-top" aria-hidden="true"></div>
				<button class="gui-rail-btn" id="rail-btn" type="button">A</button>
			</div>
			<div id="gui-settings-nav-slot" class="gui-settings-nav-slot" style="width: 256px">${navHtml}</div>
			<div class="gui-chat-col relative flex min-w-0 flex-1 flex-col">
				<div class="gui-view-enter">
					<div class="gui-settings-view">
						<div class="gui-settings-drag" aria-hidden></div>
						<div class="flex min-h-0 flex-1">
							<div class="gui-settings-main">
								<div class="gui-settings-surface">
									<div class="gui-settings-content"><button id="settings-content-btn" type="button">Open</button></div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>`;
}

/** ChatSurfaceShell: a page destination over the chat column. */
const PAGE_SHELL = `
	<div class="gui-chat-col" style="width: 1000px; height: 800px; display: flex; flex-direction: column">
		<div class="gui-chat-col-keeper" style="display: flex; flex-direction: column; flex: 1; min-height: 0">
			<header class="gui-header flex h-12 flex-shrink-0">h</header>
			<div class="gui-surface-area relative flex min-h-0 flex-1 flex-col">
				<div class="gui-view-enter" style="display: flex; flex-direction: column; flex: 1; min-height: 0">
					<div class="gui-chat-col relative flex min-w-0 flex-1 flex-col">
						<div class="gui-drag-strip" aria-hidden></div>
						<div class="gui-chat-surface flex min-h-0 flex-1 flex-col" style="margin: var(--gui-card-gutter)">
							<div class="gui-page-card flex min-h-0 flex-1 flex-col"><button id="page-btn" type="button">x</button></div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>`;

const navMarkup = (): string => {
	const React = require("react");
	const { renderToStaticMarkup } = require("react-dom/server");
	return renderToStaticMarkup(
		React.createElement(SettingsNav, {
			extTabs: [],
			activeSection: "general",
			onSelect: () => {},
			onBack: () => {},
			query: "",
			onQueryChange: () => {},
		}),
	);
};

const executablePath = await ensureChromiumExecutable();
if (!executablePath) throw new Error("No Chromium executable resolved");
const browser: Browser = await puppeteer.launch({ executablePath, headless: true });
const page: Page = await browser.newPage();

afterAll(async () => {
	await browser.close();
}, 60_000);

async function load(html: string): Promise<void> {
	await page.setViewport({ width: 1280, height: 800 });
	await page.setContent(`<style>${TOKENS}${CASCADE}</style>${html}`);
	// Entrance animations scale the columns; measure the settled frame.
	await page.evaluate(() =>
		Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
	);
}

interface Probe {
	hit: string;
	region: string;
}

async function probe(points: ReadonlyArray<readonly [number, number]>): Promise<Probe[]> {
	return page.evaluate(
		(pts: ReadonlyArray<readonly [number, number]>) =>
			pts.map(([x, y]) => {
				const hit = document.elementFromPoint(x, y);
				const classes = hit ? Array.from(hit.classList).slice(0, 2) : [];
				return {
					hit: hit ? `${hit.tagName.toLowerCase()}${classes.map(name => `.${name}`).join("")}` : "none",
					region: hit ? getComputedStyle(hit).webkitAppRegion : "none",
				};
			}),
		points as ReadonlyArray<readonly [number, number]>,
	);
}

async function regionOf(selector: string): Promise<string> {
	return page.evaluate((sel: string) => {
		const element = document.querySelector(sel);
		return element ? getComputedStyle(element).webkitAppRegion : "missing";
	}, selector);
}

async function topOf(selector: string): Promise<number> {
	return page.evaluate(
		(sel: string) => Math.round(document.querySelector(sel)?.getBoundingClientRect().top ?? Number.NaN),
		selector,
	);
}

describe("window drag — main workspace", () => {
	it("drags every point of the band above the sidebar card", async () => {
		await load(MAIN_SHELL);
		const probes = await probe([
			[26, 24], // rail band
			[150, 24], // sidebar band, above the card
			[150, 50], // sidebar band, just above the card
			[700, 24], // chat header
			[700, 50], // chat drag strip over the card gutter
		]);
		for (const entry of probes)
			expect({ hit: entry.hit, region: entry.region }).toEqual({ hit: entry.hit, region: "drag" });
	});

	it("keeps the sidebar's first row and the rail button clickable", async () => {
		await load(MAIN_SHELL);
		expect(await regionOf("#main-new")).toBe("no-drag");
		expect(await regionOf("#rail-btn")).toBe("no-drag");
		expect(await regionOf("#main-header-btn")).toBe("no-drag");
	});

	it("starts the sidebar's first row one band below the window top", async () => {
		await load(MAIN_SHELL);
		// Card top (56) + the pane's own clearance row (8) + menu margin (4).
		expect(await topOf("#main-new")).toBe(68);
	});
});

describe("window drag — settings workspace", () => {
	it("drags the band above the settings nav's first row", async () => {
		await load(settingsShell(navMarkup()));
		// The reported dead zone: the strip holding 返回 / 搜索, left column.
		const probes = await probe([
			[150, 12],
			[150, 24],
			[150, 48],
			[300, 24], // right of the rail, still the nav column's width
		]);
		for (const entry of probes)
			expect({ hit: entry.hit, region: entry.region }).toEqual({ hit: entry.hit, region: "drag" });
	});

	it("keeps the back button, the search field and the rows clickable", async () => {
		await load(settingsShell(navMarkup()));
		// Inside the band: the nav column opts out, so controls keep their clicks.
		expect(await regionOf(".gui-settings-back")).toBe("no-drag");
		expect(await regionOf(".gui-settings-search")).toBe("no-drag");
		expect(await regionOf(".gui-settings-nav")).toBe("no-drag");
		// Outside the band entirely: a region of `none` is just as clickable.
		expect(await regionOf("#settings-content-btn")).not.toBe("drag");
	});

	it("keeps the settings content column's top strip draggable", async () => {
		await load(settingsShell(navMarkup()));
		// Right of the nav column: the shell has no chat header, so this strip
		// is the only band over the content card's gutter.
		const [strip, onCard] = await probe([
			[700, 24],
			[700, 40],
		]);
		expect(strip).toEqual({ hit: "div.gui-settings-drag", region: "drag" });
		expect(onCard.region).toBe("drag");
	});

	it("aligns the nav's first row with the main sidebar's", async () => {
		await load(settingsShell(navMarkup()));
		const settingsTop = await topOf(".gui-settings-back");
		await load(MAIN_SHELL);
		expect(settingsTop).toBe(await topOf("#main-new"));
	});
});

describe("window drag — page destinations", () => {
	it("drags the strip above a page card", async () => {
		await load(PAGE_SHELL);
		const [strip, aboveCard] = await probe([
			[500, 50],
			[500, 54],
		]);
		expect(strip).toEqual({ hit: "div.gui-drag-strip", region: "drag" });
		expect(aboveCard.region).toBe("drag");
	});

	it("keeps the page card and its controls out of the band", async () => {
		await load(PAGE_SHELL);
		expect(await regionOf("#page-btn")).not.toBe("drag");
		expect(await regionOf(".gui-page-card")).not.toBe("drag");
	});
});

describe("window drag — one owner for the property", () => {
	/** Comments legitimately discuss the property; declarations do not. */
	const stripCssComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "");
	const DECLARATION = /(?:^|[\s;{])(?:-webkit-)?app-region\s*:/;
	/** Entry points that load gui.css. */
	const RENDERER_ENTRY_STYLES = [
		"gui-base.css",
		"gui-chat.css",
		"gui-chrome.css",
		"gui-composer.css",
		"gui-settings.css",
	];

	it("declares the region only in the owner stylesheet", () => {
		const counts: Record<string, number> = {};
		for (const file of fs.readdirSync(STYLES).filter(name => name.endsWith(".css"))) {
			if (file === OWNER_STYLE) continue;
			const declarations = stripCssComments(fs.readFileSync(path.join(STYLES, file), "utf8"))
				.split("\n")
				.filter(line => DECLARATION.test(line)).length;
			if (declarations > 0) counts[file] = declarations;
		}
		// dictation.css is a separate HTML entry point (it does not load gui.css),
		// so it keeps its own opt-out; no renderer sheet may declare the property.
		expect(counts).toEqual({ "dictation.css": 1 });
	});

	it("covers every band its components mount", () => {
		const owner = fs.readFileSync(path.join(STYLES, OWNER_STYLE), "utf8");
		const bands = [
			"gui-rail-top",
			"gui-header",
			"gui-pane-drag",
			"gui-drag-strip",
			"gui-side-keeper",
			"gui-mini-drag",
			"gui-settings-drag",
			"gui-settings-nav-slot",
			"gui-splash",
		];
		for (const band of bands) expect(owner).toContain(`.${band}`);
	});

	it("never marks one element as both a band and an opt-out", () => {
		// The owner sheet reads the attribute; an element claiming both would
		// be a contradiction whose winner depends on source order inside it.
		const contradictions: string[] = [];
		for (const file of fs.readdirSync(SRC).filter(name => name.endsWith(".tsx"))) {
			const source = fs.readFileSync(path.join(SRC, file), "utf8");
			for (const [index, line] of source.split("\n").entries()) {
				const modes = new Set(Array.from(line.matchAll(/data-gui-window-drag="(band|off)"/g), m => m[1]));
				if (modes.size > 1) contradictions.push(`${file}:${index + 1}`);
			}
		}
		expect(contradictions).toEqual([]);
	});

	it("keeps the renderer sheets free of the property", () => {
		for (const file of RENDERER_ENTRY_STYLES) {
			const source = stripCssComments(fs.readFileSync(path.join(STYLES, file), "utf8"));
			expect(source).not.toMatch(DECLARATION);
		}
	});
});
