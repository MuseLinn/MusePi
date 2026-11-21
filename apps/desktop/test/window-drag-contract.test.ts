import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as babelParse } from "@babel/parser";
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

/** Class names a component applies through `className`, in any JSX form:
 *  a string, a template, or an array/expression (`.gui-side-keeper` is built
 *  from an array). Comments and prose are not class names, so they cannot
 *  satisfy a mount check. */
function classNameTokens(source: string): string[] {
	const tokens: string[] = [];
	const pattern = /className\s*=\s*(?:"([^"]*)"|\{([\s\S]*?)\}\s*(?=[/>\n]))/g;
	for (const match of source.matchAll(pattern)) {
		for (const token of (match[1] ?? match[2] ?? "").matchAll(/([A-Za-z][\w-]*)/g)) tokens.push(token[1]);
	}
	return tokens;
}

/** Every JSX opening tag in a source file, as { text, line }.
 *
 *  Parsed, not scanned: `@babel/parser` tokenizes TSX for us, so quotes,
 *  template literals, regex literals, comments, braces and JSX text are the
 *  parser's problem rather than ours. The hand-rolled scanner this replaced
 *  mis-read a regex at `GuiHeader.tsx:399` and silently lost the rest of the
 *  file — including `.gui-header`, a band the contract asserts.
 *
 *  The text is rebuilt from the node's source range, so callers can look for
 *  attributes in it exactly as before. A file that cannot be parsed throws with
 *  its path: a guard that skips a file quietly is the failure mode this test
 *  exists to prevent.
 */
export function jsxTags(
	source: string,
	file: string,
	parseOptions: { sourceType?: "module" | "script"; plugins?: string[] } = {},
): { text: string; line: number }[] {
	let ast: ReturnType<typeof babelParse>;
	try {
		// `jsx` is only legal together with a JS/TS dialect; every file this
		// guard reads is renderer TSX.
		ast = babelParse(source, {
			plugins: parseOptions.plugins ?? ["typescript", "jsx"],
			sourceType: parseOptions.sourceType ?? "module",
			errorRecovery: false,
		});
	} catch (error) {
		throw new Error(`window-drag guard: could not scan ${file}: ${(error as Error).message}`);
	}
	const tags: { text: string; line: number }[] = [];
	const visit = (node: unknown): void => {
		if (node === null || typeof node !== "object") return;
		const record = node as { type?: string; start?: number; end?: number; loc?: { start: { line: number } } };
		if (
			(record.type === "JSXOpeningElement" || record.type === "JSXSelfClosingElement") &&
			record.start !== undefined &&
			record.end !== undefined
		) {
			tags.push({ text: source.slice(record.start, record.end), line: record.loc?.start.line ?? 0 });
		}
		for (const [key, value] of Object.entries(record)) {
			if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
			if (Array.isArray(value)) for (const item of value) visit(item);
			else visit(value);
		}
	};
	try {
		visit(ast);
	} catch (error) {
		throw new Error(`window-drag guard: could not scan ${file}: ${(error as Error).message}`);
	}
	return tags;
}

/** Relative import specifiers in a module, both static and dynamic. */
function relativeImports(source: string): string[] {
	const specifiers: string[] = [];
	for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
		specifiers.push(match[1]);
	}
	return specifiers;
}

/** Every file under `directory` with the given extension, recursively. */
function walkSources(directory: string, extension: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) out.push(...walkSources(full, extension));
		else if (entry.name.endsWith(extension)) out.push(full.replaceAll("\\", "/"));
	}
	return out;
}

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
	/** Every entry point that declares a region outside this owner sheet, with
	 *  the reason it cannot read the owner: the stylesheet it loads instead. */
	const SECOND_ROOTS = {
		"apps/desktop/src/styles/dictation.css": 1,
		"apps/desktop/installer/ui/installer.css": 2,
		"packages/client-core/src/components/shell/shell.css": 1,
	};
	const REPO = path.resolve(SRC, "../../..");
	/** Entry points that load gui.css: the owner sheet must stay their only
	 *  source of the property. */
	const RENDERER_ENTRY_STYLES = [
		"gui-base.css",
		"gui-chat.css",
		"gui-chrome.css",
		"gui-composer.css",
		"gui-settings.css",
	];

	/** Every CSS rule in the sheet, as { selectors, body }. A rule-level parse
	 *  (not a regex over the whole file) is what makes the band list
	 *  unambiguous: the sheet may hold one copy of the list, and the test reads
	 *  the rule that actually applies `drag`. */
	const parseRules = (source: string): { selectors: string; body: string }[] => {
		const rules: { selectors: string; body: string }[] = [];
		const css = stripCssComments(source);
		const depth = 0;
		let start = 0;
		for (let index = 0; index < css.length; index++) {
			const char = css[index];
			if (char === "{") {
				if (depth === 0) {
					const selectors = css.slice(start, index).trim();
					let inner = index + 1;
					let innerDepth = 1;
					for (inner = index + 1; inner < css.length && innerDepth > 0; inner++) {
						if (css[inner] === "{") innerDepth++;
						else if (css[inner] === "}") innerDepth--;
					}
					rules.push({ selectors, body: css.slice(index + 1, inner - 1) });
					index = inner - 1;
					start = inner;
				}
			}
		}
		return rules;
	};

	/** The band list as the sheet applies it: every selector in the rule that
	 *  declares `-webkit-app-region: drag`. Selector text is split on commas so
	 *  a reformat (attribute in its own rule, classes in another) changes the
	 *  list only if the drag declaration moves too. */
	const dragSelectors = (): string[] => {
		const owner = fs.readFileSync(path.join(STYLES, OWNER_STYLE), "utf8");
		const selectors = parseRules(owner)
			.filter(rule => /-webkit-app-region:\s*drag/.test(rule.body))
			.flatMap(rule => rule.selectors.split(","))
			.map(selector => selector.trim())
			.filter(Boolean);
		return selectors;
	};

	const classBands = (selectors: string[]): string[] =>
		selectors.flatMap(selector => Array.from(selector.matchAll(/\.(gui-[\w-]+)/g), match => match[1]));

	const BAND_ATTRIBUTE = '[data-gui-window-drag="band"]';

	it("declares the region only in the owner stylesheet and its second roots", () => {
		const counts: Record<string, number> = {};
		const cssFiles: string[] = [];
		const collect = (directory: string): void => {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				const full = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
					collect(full);
				} else if (entry.name.endsWith(".css")) {
					cssFiles.push(full.replaceAll("\\", "/"));
				}
			}
		};
		collect(path.join(REPO, "apps"));
		collect(path.join(REPO, "packages"));
		for (const file of cssFiles) {
			const relative = path.relative(REPO, file).replaceAll("\\", "/");
			if (relative === `apps/desktop/src/styles/${OWNER_STYLE}`) continue;
			const declarations = stripCssComments(fs.readFileSync(file, "utf8"))
				.split(/\r?\n/)
				.filter(line => DECLARATION.test(line)).length;
			if (declarations > 0) counts[relative] = declarations;
		}
		expect(counts).toEqual(SECOND_ROOTS);
	});

	it("declares the band attribute exactly once, so the list has one copy", () => {
		// A second copy is how the safety net silently fell behind the band
		// rule; the sheet may name the attribute in exactly one selector.
		const selectors = dragSelectors().filter(selector => selector.includes(BAND_ATTRIBUTE));
		expect(selectors).toEqual([BAND_ATTRIBUTE]);
		const owner = stripCssComments(fs.readFileSync(path.join(STYLES, OWNER_STYLE), "utf8"));
		expect(owner.split(BAND_ATTRIBUTE).length - 1).toBe(1);
	});

	it("asserts every band the drag rule actually applies, derived from the sheet", () => {
		const bands = classBands(dragSelectors());
		expect(bands).toEqual([
			"gui-rail-top",
			"gui-header",
			"gui-pane-drag",
			"gui-drag-strip",
			"gui-side-keeper",
			"gui-mini-drag",
			"gui-settings-drag",
			"gui-settings-nav-slot",
			"gui-pin-drag",
			"gui-splash",
		]);
	});

	it("mounts every listed band from a module reachable from a renderer entry", () => {
		// A class mentioned only in prose is not a mount; neither is a component
		// that nothing loads. Mounting means: some module's `className` carries
		// the band AND that module is reachable through the real import graph
		// from an HTML entry point — one hop is not enough, because a two-file
		// orphan also has an importer.
		const sources = new Map(walkSources(SRC, ".tsx").map(file => [file, fs.readFileSync(file, "utf8")]));
		const entryFiles = new Set<string>();
		const appDir = path.resolve(SRC, "..");
		for (const name of fs.readdirSync(appDir).filter(entry => entry.endsWith(".html"))) {
			const html = fs.readFileSync(path.join(appDir, name), "utf8");
			for (const match of html.matchAll(/src="\.?\/?src\/([\w-]+)\.tsx"/g)) {
				entryFiles.add(path.join(SRC, `${match[1]}.tsx`).replaceAll("\\", "/"));
			}
		}
		expect(entryFiles.size).toBeGreaterThan(0);

		/** Resolve a relative specifier against the importing file, trying the
		 *  extensions a bundler would. */
		const resolve = (from: string, specifier: string): string | null => {
			const base = path.resolve(path.dirname(from), specifier).replaceAll("\\", "/");
			for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
				if (sources.has(candidate)) return candidate;
			}
			return null;
		};

		// Breadth-first over the import graph, starting at the entry points.
		const reachable = new Set<string>([...entryFiles].filter(file => sources.has(file)));
		const queue = [...reachable];
		while (queue.length > 0) {
			const file = queue.shift()!;
			for (const specifier of relativeImports(sources.get(file) ?? "")) {
				const resolved = resolve(file, specifier);
				if (resolved && !reachable.has(resolved)) {
					reachable.add(resolved);
					queue.push(resolved);
				}
			}
		}

		const unreachable: string[] = [];
		for (const band of classBands(dragSelectors())) {
			const mounted = [...sources.entries()]
				.filter(([, source]) => classNameTokens(source).includes(band))
				.map(([file]) => file);
			expect({ band, mounted: mounted.length > 0 }).toEqual({ band, mounted: true });
			if (!mounted.some(file => reachable.has(file))) unreachable.push(band);
		}
		expect(unreachable).toEqual([]);
	});

	it("marks the pinned card's drag strip as a band", async () => {
		// The pin window is frameless, transparent and has no IPC move path, so
		// its strip is the window's only way to move. pin.html's real markup.
		await load(`
			<div class="gui-pin" data-tone="default" style="width: 320px; height: 420px; position: relative">
				<div class="gui-pin-drag">
					<div class="gui-pin-actions"><button class="gui-pin-btn" type="button">pin</button></div>
				</div>
				<div class="gui-pin-body" style="padding-top: 48px">body</div>
			</div>`);
		const probes = await probe([
			[150, 40],
			[20, 40],
		]);
		for (const entry of probes)
			expect({ hit: entry.hit, region: entry.region }).toEqual({ hit: entry.hit, region: "drag" });
		// The hover actions keep their clicks.
		expect(await regionOf(".gui-pin-btn")).toBe("no-drag");
	});

	it("never marks one element as both a band and an opt-out", () => {
		// Scanned per JSX TAG, not per line: a formatter puts every attribute on
		// its own line, and the contradiction only becomes visible when the
		// whole tag is read. A spread attribute is out of reach for a string
		// scan; `check:types` rejects the duplicate-attribute spelling (TS17001)
		// and a spread that overrides at runtime is simply the later value.
		const contradictions: string[] = [];
		for (const file of walkSources(SRC, ".tsx")) {
			for (const tag of jsxTags(fs.readFileSync(file, "utf8"), path.relative(SRC, file))) {
				const modes = new Set(Array.from(tag.text.matchAll(/data-gui-window-drag="(band|off)"/g), m => m[1]));
				if (modes.size > 1) contradictions.push(`${path.relative(SRC, file)}:${tag.line}`);
			}
		}
		expect(contradictions).toEqual([]);
	});

	it("reads the shapes that broke the hand-rolled scanner, from real files", () => {
		// Regression cases taken from shipped files, not inline fixtures: the
		// previous scanner lost 121 of GuiHeader.tsx's 123 tags to a regex
		// literal, and an inline fixture could never show that.
		const guiHeader = path.join(SRC, "components/GuiHeader.tsx");
		const headerTags = jsxTags(fs.readFileSync(guiHeader, "utf8"), "GuiHeader.tsx");
		const header = headerTags.find(tag => tag.text.includes('"gui-header'));
		expect(header).toBeDefined();
		// The regex at line 399 used to swallow everything after it.
		expect(headerTags.length).toBeGreaterThan(100);
		expect(headerTags.some(tag => tag.text.includes('"gui-header-spacer"'))).toBe(true);

		const companion = path.join(SRC, "components/settings-sections/companion.tsx");
		const companionTags = jsxTags(fs.readFileSync(companion, "utf8"), "companion.tsx");
		expect(companionTags.length).toBeGreaterThan(80);
		// Past the old desync boundary (~line 668) the scan must still see tags.
		expect(companionTags.filter(tag => tag.line > 668).length).toBeGreaterThan(0);

		// The literal `<svg"` inside this test file's own strings is not a tag:
		// the parser knows it is data, the regex-based opener did not.
		const stringLiteral = path.join(SRC, "components/import-source-glyph.test.tsx");
		const glyphTags = jsxTags(fs.readFileSync(stringLiteral, "utf8"), "import-source-glyph.test.tsx");
		expect(glyphTags.every(tag => !tag.text.startsWith("<svg"))).toBe(true);
	});

	it("still reports a contradiction that a quoted > sits in front of", () => {
		// `title="a > b"` used to truncate the tag so the duplicate never surfaced.
		const source = `const A = () => (
			<div title="a > b" data-gui-window-drag="band" data-gui-window-drag="off" />
		);`;
		const [tag] = jsxTags(source, "fixture.tsx");
		expect(Array.from(tag.text.matchAll(/data-gui-window-drag="(band|off)"/g), m => m[1])).toEqual(["band", "off"]);
	});

	it("does not let a brace inside a string abort the scan", () => {
		// `{"a } b"}` used to drive the depth negative and skip the rest of the file.
		const source = `const A = () => (
			<nav aria-label={"a } b"} data-gui-window-drag="off">x</nav>
		);
		const B = () => <footer className="after" />;`;
		const tags = jsxTags(source, "fixture.tsx");
		expect(tags.some(tag => tag.text.includes("aria-label"))).toBe(true);
		expect(tags.some(tag => tag.text.includes('"after"'))).toBe(true);
	});

	it("fails loudly when a file cannot be parsed instead of skipping it", () => {
		// The guard's whole job is never to fall behind without saying so: an
		// unparsable file names itself rather than contributing zero tags.
		expect(() => jsxTags('const A = () => <div data-gui-window-drag="band"', "broken.tsx")).toThrow(
			/could not scan broken\.tsx/,
		);
	});

	it("keeps the renderer sheets free of the property", () => {
		for (const file of RENDERER_ENTRY_STYLES) {
			const source = stripCssComments(fs.readFileSync(path.join(STYLES, file), "utf8"));
			expect(source).not.toMatch(DECLARATION);
		}
	});
});
