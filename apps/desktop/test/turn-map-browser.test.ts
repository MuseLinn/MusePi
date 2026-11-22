import "./happy-dom-shim";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setLocale } from "@musepi/client-core";
import type { BunPlugin } from "bun";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

setLocale("zh-CN");

/**
 * The map in a real browser, with React handlers attached.
 *
 * This file exists because three of the four M83 r1 blockers are invisible to
 * SSR markup: a server-rendered page has no React event handlers (so keyboard
 * traversal cannot fire), no paint resolution you can trust (computed `stroke`
 * still reads `url(#…)` when it resolves to nothing), and no hit-testing
 * against transparent layers. The fixture mounts the real component through
 * `Bun.build` + `createRoot` (the pattern `quote-cards-browser.test.ts` uses),
 * so every assertion here is something a browser actually does.
 *
 * Coverage:
 *  1. **paint** — pixel probe on a main edge + arrow, plus both gradients exist.
 *  2. **keyboard** — real Tab reaches the canvas, ArrowDown selects and opens
 *     the inspector, Enter jumps, Escape clears.
 *  3. **hit targets** — a point over the hidden action strip resolves to the card.
 *  4. **off-path legibility** — pixel contrast of the tag ≥ 4.5:1.
 *  5. **routing** — no painted edge segment crosses a non-endpoint card.
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = ["gui-base.css", "gui-workspace.css", "gui-chat.css"]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

const reactAliases: Record<string, string> = {
	react: path.resolve(import.meta.dir, "../node_modules/react/index.js"),
	"react/jsx-runtime": path.resolve(import.meta.dir, "../node_modules/react/jsx-runtime.js"),
	"react/jsx-dev-runtime": path.resolve(import.meta.dir, "../node_modules/react/jsx-dev-runtime.js"),
	"react-dom": path.resolve(import.meta.dir, "../node_modules/react-dom/index.js"),
	"react-dom/client": path.resolve(import.meta.dir, "../node_modules/react-dom/client.js"),
};
const reactAliasPlugin: BunPlugin = {
	name: "turn-map-react-alias",
	setup(build) {
		build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => {
			const aliased = reactAliases[args.path];
			return aliased ? { path: aliased } : undefined;
		});
	},
};

const executablePath = await ensureChromiumExecutable();
if (!executablePath) throw new Error("No Chromium executable resolved");
const build = await Bun.build({
	entrypoints: [path.resolve(import.meta.dir, "turn-map-browser.fixture.tsx")],
	target: "browser",
	format: "esm",
	define: { "process.env.NODE_ENV": '"development"' },
	plugins: [reactAliasPlugin],
});
if (!build.success) throw new AggregateError(build.logs, "Turn map browser fixture did not build");
const fixtureSource = await build.outputs[0]!.text();

// `--bg` is set at runtime by the theme system, so a fixture that omits it
// leaves `:root[data-platform="win32"] body { background: var(--bg) }` resolving
// to nothing — and Chromium's WHITE page becomes the backdrop. A paint claim
// measured against that backdrop is worse than blind: deleting the gradients
// then *raises* the measured contrast, because the sample is the white page.
// Pin both the platform and the surface so the backdrop is the production one.
const ROOT_STYLE = `:root{
	--bg:rgb(24,24,26);--color-bg:rgb(24,24,26);--color-surface:rgb(32,32,34);
	--color-text:rgb(235,235,235);--color-text-muted:rgb(160,160,160);--color-text-faint:rgb(120,120,120);
	--color-accent:rgb(90,150,240);--color-warning:rgb(230,180,90);--border:rgb(70,70,70);
	--radius-xs:3px;--radius-sm:4px;--radius-md:8px;--radius-lg:12px;--radius-xl:14px;--radius-full:999px;
	--spring:cubic-bezier(0.22,0.8,0.3,1);
	--gui-glass-bg:color-mix(in oklab, rgb(24,24,26) 80%, transparent);
	--gui-glass-border:color-mix(in oklab, rgb(235,235,235) 12%, transparent);
	--font-mono:ui-monospace,monospace;
}`;

let browser: Browser;
let page: Page;
let pageErrors: string[] = [];

beforeAll(async () => {
	browser = await puppeteer.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
	await browser.close();
}, 60_000);

/** Mount the fixture at `shape` and wait for the canvas to exist. */
async function open(shape: "linear" | "nested", turns = 3): Promise<void> {
	// A fresh page per mount: `setContent` on a reused page detaches the frame
	// under puppeteer-core when the previous document's React root is torn down.
	if (page) await page.close().catch(() => {});
	page = await browser.newPage();
	await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 });
	pageErrors = [];
	page.on("pageerror", (error: unknown) => pageErrors.push(String(error)));
	await page.setContent(
		`<!doctype html><html data-platform="win32" data-turn-map-shape="${shape}" data-turn-map-turns="${turns}"><head><style>${ROOT_STYLE}${CASCADE}
		body{margin:0}#stage{position:relative;width:1040px;height:720px}
		/* Deterministic coordinates: the entrance animation shifts the world by
		 * 8px and tm-breathe never finishes. Motion is not under test. */
		*,*::before,*::after{animation:none !important;transition:none !important}</style></head>
		<body><div id="stage"><div id="root"></div></div></body></html>`,
	);
	await page.addScriptTag({ content: fixtureSource });
	await page.waitForSelector(".tm-node", { timeout: 5000 }).catch((error: unknown) => {
		throw new Error(`map did not mount\n${pageErrors.join("\n")}\n${String(error)}`);
	});
	// Two frames for layout to settle (no animations are running).
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
}

/** Screenshot the stage and read pixels through a canvas. */
async function pixels(): Promise<{ width: number; data: Uint8ClampedArray }> {
	const clip = await page.evaluate(() => {
		const rect = document.querySelector("#stage")!.getBoundingClientRect();
		return { x: 0, y: 0, width: Math.round(rect.width), height: Math.round(rect.height) };
	});
	const shot = Buffer.from(await page.screenshot({ encoding: "base64", clip }), "base64");
	const data = await page.evaluate(async (b64: string) => {
		const image = new Image();
		image.src = `data:image/png;base64,${b64}`;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext("2d")!;
		context.drawImage(image, 0, 0);
		const raw = context.getImageData(0, 0, image.width, image.height);
		return { width: image.width, data: Array.from(raw.data) };
	}, shot.toString("base64"));
	return { width: data.width, data: Uint8ClampedArray.from(data.data) };
}

function at(px: { width: number; data: Uint8ClampedArray }, x: number, y: number): [number, number, number] {
	const i = (Math.round(y) * px.width + Math.round(x)) * 4;
	return [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
}

function luminance([r, g, b]: [number, number, number]): number {
	const channel = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("P1-1 — the connector paints", () => {
	test("both gradients the CSS references exist and use userSpaceOnUse", async () => {
		await open("linear");
		const ids = await page.evaluate(() => ({
			main: document.querySelectorAll("#tm-main-line").length,
			branch: document.querySelectorAll("#tm-branch-line").length,
			mainUnits: document.querySelector("#tm-main-line")?.getAttribute("gradientUnits") ?? null,
			branchUnits: document.querySelector("#tm-branch-line")?.getAttribute("gradientUnits") ?? null,
		}));
		expect(ids.main).toBe(1);
		expect(ids.branch).toBe(1);
		// A vertical line has a zero-width bounding box; without userSpaceOnUse the
		// gradient degenerates and the stroke disappears again.
		expect(ids.mainUnits).toBe("userSpaceOnUse");
		expect(ids.branchUnits).toBe("userSpaceOnUse");
	});

	test("a main edge paints warm pixels that are lighter than the background", async () => {
		await open("linear", 5);
		// Read the probe window from the LIVE geometry, not from world constants:
		// the mounted canvas runs fitView, so the world is translated and a fixed
		// coordinate lands on the topbar or a card instead of the edge. Take the
		// painted path's own client rect and sample its middle band.
		const window = await page.evaluate(() => {
			const path = document.querySelector<SVGPathElement>("path.tm-edge")!;
			const len = path.getTotalLength();
			const mid = path.getPointAtLength(len / 2);
			const matrix = path.getScreenCTM()!;
			const client = new DOMPoint(mid.x, mid.y).matrixTransform(matrix);
			return { x: Math.round(client.x), y: Math.round(client.y) };
		});
		const px = await pixels();
		const background = at(px, 900, 700);
		const samples: [number, number, number][] = [];
		for (let x = window.x - 4; x <= window.x + 4; x++) {
			for (let y = window.y - 4; y <= window.y + 4; y++) samples.push(at(px, x, y));
		}
		// The stroke paints: some pixel in the window is clearly lighter than the
		// background (the edge is a 2px line, so it never fills the window).
		const brightest = samples.reduce((a, b) => (luminance(b) > luminance(a) ? b : a));
		expect(luminance(brightest)).toBeGreaterThan(luminance(background) + 0.05);
		// And it carries the gradient's gold end, not a flat grey: the main
		// gradient runs gold → 55% gold + accent, so warmth varies along the
		// line — assert the warm end exists rather than that every sample is warm.
		const warmest = samples.reduce((a, b) => (b[0] - b[2] > a[0] - a[2] ? b : a));
		expect(warmest[0] - warmest[2]).toBeGreaterThan(15);
	});

	test("an arrowhead paints: its own box holds warm pixels that vanish when hidden", async () => {
		await open("linear", 5);
		// The claim is "this triangle paints", so it must be measured against the
		// same triangle absent — not against some other surface at a fixed
		// coordinate. A fixed reference can never carry a paint claim: it is a
		// different surface, and on a white page it even rises when the paint is
		// removed.
		const box = await page.evaluate(() => {
			const poly = document.querySelector<SVGPolygonElement>("polygon.tm-arrow")!;
			const r = poly.getBoundingClientRect();
			return {
				left: Math.floor(r.left),
				top: Math.floor(r.top),
				width: Math.max(1, Math.ceil(r.width)),
				height: Math.max(1, Math.ceil(r.height)),
			};
		});

		/** Warm pixels (gold family) inside the arrow's own client box. */
		const warmInside = async (): Promise<number> => {
			const px = await pixels();
			let warm = 0;
			for (let y = box.top; y < box.top + box.height; y++) {
				for (let x = box.left; x < box.left + box.width; x++) {
					const [r, g, b] = at(px, x, y);
					if (r > g && g > b && r - b > 20) warm += 1;
				}
			}
			return warm;
		};

		const shown = await warmInside();
		expect(shown).toBeGreaterThan(0);

		// Hide the arrow the way a missing paint hides it (no fill resolves), and
		// count the same box again. The box also contains the last few pixels of
		// the edge line, so the residual is not zero — the arrow's contribution is
		// the DIFFERENCE, and it must be substantial.
		await page.evaluate(() => {
			const poly = document.querySelector<SVGPolygonElement>("polygon.tm-arrow")!;
			poly.style.display = "none";
		});
		const hidden = await warmInside();
		expect(shown - hidden).toBeGreaterThanOrEqual(10);
	});
});

describe("P1-2 — keyboard traversal is reachable and works", () => {
	test("Tab reaches the canvas, ArrowDown selects and opens the inspector", async () => {
		await open("linear");
		// Focus the body so Tab starts from the top of the document.
		await page.evaluate(() => {
			(document.activeElement as HTMLElement | null)?.blur();
			(document.body as HTMLElement).focus?.();
		});
		let landedInMap = false;
		for (let i = 0; i < 12 && !landedInMap; i++) {
			await page.keyboard.press("Tab");
			landedInMap = await page.evaluate(() => {
				const active = document.activeElement as HTMLElement | null;
				return active !== null && active.closest(".tm-wrap") !== null;
			});
		}
		expect(landedInMap).toBe(true);

		// The canvas itself owns the traversal keys.
		await page.evaluate(() => document.querySelector<HTMLElement>(".tm-wrap")!.focus());
		await page.keyboard.press("ArrowDown");
		expect(await page.evaluate(() => document.querySelectorAll(".tm-node--selected").length)).toBe(1);
		expect(await page.evaluate(() => document.querySelectorAll(".tm-inspector").length)).toBe(1);
	});

	test("ArrowDown moves through turns, Home/End reach the ends, Escape clears", async () => {
		await open("linear");
		await page.evaluate(() => document.querySelector<HTMLElement>(".tm-wrap")!.focus());
		const turn = () =>
			page.evaluate(
				() => document.querySelector<HTMLElement>(".tm-node--selected")?.getAttribute("data-turn") ?? null,
			);
		await page.keyboard.press("ArrowDown");
		expect(await turn()).toBe("1");
		await page.keyboard.press("ArrowDown");
		expect(await turn()).toBe("2");
		await page.keyboard.press("End");
		expect(await turn()).toBe("3");
		await page.keyboard.press("Home");
		expect(await turn()).toBe("1");
		await page.keyboard.press("Escape");
		expect(await page.evaluate(() => document.querySelectorAll(".tm-inspector").length)).toBe(0);
	});

	test("a real Enter on a focused card reaches onJumpToEntry", async () => {
		await open("linear");
		// The fixture records jumps in the DOM, so this asserts the callback a
		// user's Enter produces — not merely that the event was not swallowed.
		const expected = await page.evaluate(() => {
			const card = document.querySelector<HTMLElement>(".tm-node")!;
			card.focus();
			return card.getAttribute("data-turn");
		});
		expect(expected).toBe("1");
		await page.keyboard.press("Enter");
		const jumps = await page.evaluate(
			() => document.querySelector<HTMLElement>("#turn-map-jumps")?.dataset.jumps ?? "",
		);
		expect(jumps).toBe("u1");
	});

	test("End on a long map keeps the selected turn inside the viewport", async () => {
		// Mission task 5: "the selected turn stays visible when the map scrolls".
		// `fitView` already centres the leaf on mount, so pressing End alone is
		// satisfied by the initial viewport and would pass with centering removed.
		// The map must therefore be PANNED AWAY first: then only `centerOnTurn`
		// can put the selection back on screen.
		await open("linear", 30);
		const start = await page.evaluate(() => {
			const world = document.querySelector<HTMLElement>(".tm-world")!;
			return world.style.transform;
		});
		// Drag from blank canvas (right of the cards, below the topbar) far upward,
		// so the tail of the map leaves the view.
		const blank = await page.evaluate(() => {
			const wrap = document.querySelector<HTMLElement>(".tm-wrap")!;
			for (let y = 200; y < 640; y += 20) {
				for (let x = 960; x > 660; x -= 20) {
					const el = document.elementFromPoint(x, y) as HTMLElement | null;
					if (el === wrap) return { x, y };
				}
			}
			return null;
		});
		expect(blank).not.toBeNull();
		// Drag DOWNWARD: the world moves down, so the tail leaves the viewport
		// through the bottom edge. (Dragging up moves the tail further into view.)
		await page.mouse.move(blank!.x, blank!.y);
		await page.mouse.down();
		await page.mouse.move(blank!.x, Math.min(700, blank!.y + 560), { steps: 12 });
		await page.mouse.up();
		const panned = await page.evaluate(() => ({
			transform: document.querySelector<HTMLElement>(".tm-world")!.style.transform,
			tailVisible: (() => {
				const card = [...document.querySelectorAll<HTMLElement>(".tm-node")].find(
					el => el.getAttribute("data-turn") === "30",
				);
				if (!card) return false;
				const wrap = document.querySelector<HTMLElement>(".tm-wrap")!.getBoundingClientRect();
				const rect = card.getBoundingClientRect();
				return rect.bottom > wrap.top && rect.top < wrap.bottom;
			})(),
		}));
		expect(panned.transform).not.toBe(start);
		expect(panned.tailVisible).toBe(false);

		await page.evaluate(() => document.querySelector<HTMLElement>(".tm-wrap")!.focus());
		await page.keyboard.press("End");
		const fit = await page.evaluate(() => {
			const wrap = document.querySelector<HTMLElement>(".tm-wrap")!.getBoundingClientRect();
			const card = document.querySelector<HTMLElement>(".tm-node--selected");
			if (!card) return null;
			const rect = card.getBoundingClientRect();
			return {
				turn: card.getAttribute("data-turn"),
				inside:
					rect.left >= wrap.left - 1 &&
					rect.right <= wrap.right + 1 &&
					rect.top >= wrap.top - 1 &&
					rect.bottom <= wrap.bottom + 1,
				rect: {
					left: Math.round(rect.left),
					top: Math.round(rect.top),
					right: Math.round(rect.right),
					bottom: Math.round(rect.bottom),
				},
				wrap: {
					left: Math.round(wrap.left),
					top: Math.round(wrap.top),
					right: Math.round(wrap.right),
					bottom: Math.round(wrap.bottom),
				},
			};
		});
		expect(fit).not.toBeNull();
		expect(fit!.turn).toBe("30");
		expect(fit!.inside).toBe(true);
	});
});

describe("P1-4 — hidden actions do not intercept clicks", () => {
	test("with the pointer away, a point over the actions area resolves to the card", async () => {
		await open("linear");
		const probe = await page.evaluate(() => {
			const card = document.querySelector<HTMLElement>(".tm-node")!;
			const actions = card.querySelector<HTMLElement>(".tm-card-actions")!;
			const rect = actions.getBoundingClientRect();
			const hit = document.elementFromPoint(
				rect.left + rect.width / 2,
				rect.top + rect.height / 2,
			) as HTMLElement | null;
			return {
				opacity: getComputedStyle(actions).opacity,
				pointerEvents: getComputedStyle(actions).pointerEvents,
				hitIsAction: hit !== null && hit.closest(".tm-card-act") !== null,
				hitIsCard: hit !== null && hit.closest(".tm-node") !== null,
			};
		});
		expect(probe.opacity).toBe("0");
		expect(probe.pointerEvents).toBe("none");
		expect(probe.hitIsAction).toBe(false);
		expect(probe.hitIsCard).toBe(true);
	});

	test("a pointer press on a hidden action's centre reaches the card, not the button", async () => {
		await open("linear");
		// Aim at a SPECIFIC button's centre. The strip's own centre is the 2px gap
		// between buttons, so a click there resolves to the strip and lands on the
		// card whether or not the buttons intercept — a guard that cannot fail.
		const geometry = await page.evaluate(() => {
			const acts = [...document.querySelectorAll<HTMLElement>(".tm-node .tm-card-act")];
			const target = acts[2]!;
			const rect = target.getBoundingClientRect();
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			return {
				label: target.getAttribute("aria-label"),
				x,
				y,
				hitIsAction: (document.elementFromPoint(x, y) as HTMLElement)?.closest(".tm-card-act") !== null,
			};
		});
		expect(geometry.label).toBeTruthy();
		expect(geometry.hitIsAction).toBe(false);

		// `page.mouse.click` MOVES the pointer first, which hovers the card and
		// reveals the strip — so it can never exercise the hidden state. Press and
		// release at the point without moving, which is what a tap/laptop click on
		// an already-resting pointer does.
		const client = await page.createCDPSession();
		await client.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: geometry.x,
			y: geometry.y,
			button: "left",
			clickCount: 1,
		});
		await client.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: geometry.x,
			y: geometry.y,
			button: "left",
			clickCount: 1,
		});
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
		const pressed = await page.evaluate(() => ({
			selected: document.querySelectorAll(".tm-node--selected").length,
			// No action ran: switching branch / re-answer would move the leaf or
			// open a dialog, neither of which happens on a plain selection.
			confirmDialog: document.querySelectorAll(".gui-dialog--confirm").length,
		}));
		// The press reached the CARD. With the r1 defect (pointer-events auto on a
		// transparent strip) the button swallows it and `selected` stays 0.
		expect(pressed.selected).toBe(1);
		expect(pressed.confirmDialog).toBe(0);

		// Revealed, the same point must reach the button instead.
		await page.mouse.move(geometry.x, geometry.y);
		await page.evaluate(
			() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
		);
		const revealed = await page.evaluate(() => {
			const acts = [...document.querySelectorAll<HTMLElement>(".tm-node .tm-card-act")];
			const target = acts[2]!;
			const rect = target.getBoundingClientRect();
			return {
				pointerEvents: getComputedStyle(target).pointerEvents,
				hitIsAction:
					(
						document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) as HTMLElement
					)?.closest(".tm-card-act") !== null,
			};
		});
		expect(revealed.pointerEvents).toBe("auto");
		expect(revealed.hitIsAction).toBe(true);
	});
});

describe("P2-1 — the off-path tag is legible", () => {
	test("its text pixels reach 4.5:1 against the card", async () => {
		await open("nested");
		const box = await page.evaluate(() => {
			const tag = document.querySelector<HTMLElement>(".tm-card-off");
			if (!tag) return null;
			const rect = tag.getBoundingClientRect();
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		});
		expect(box).not.toBeNull();
		const px = await pixels();
		// Text is the darkest cluster inside the pill; the pill surface is the
		// lighter cluster. Sample both from the real pixels.
		const samples: [number, number, number][] = [];
		for (let y = Math.ceil(box!.y) + 1; y < box!.y + box!.height - 1; y++) {
			for (let x = Math.ceil(box!.x) + 1; x < box!.x + box!.width - 1; x++) {
				samples.push(at(px, x, y));
			}
		}
		expect(samples.length).toBeGreaterThan(20);
		const byLuminance = [...samples].sort((a, b) => luminance(a) - luminance(b));
		const darkest = byLuminance[Math.floor(byLuminance.length * 0.05)]!;
		const lightest = byLuminance[Math.floor(byLuminance.length * 0.95)]!;
		expect(contrast(darkest, lightest)).toBeGreaterThanOrEqual(4.5);
	});
});

describe("P1-3 — no painted edge crosses a card", () => {
	test("the nested-branch shape draws every edge outside every non-endpoint card", async () => {
		await open("nested");
		const crossings = await page.evaluate(() => {
			const cards = [...document.querySelectorAll<HTMLElement>(".tm-node")].map(el => {
				const r = el.getBoundingClientRect();
				return { turn: el.getAttribute("data-turn"), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
			});
			// Endpoint identity comes from the layout's own data attributes: an
			// edge's first/last point touches its two cards, and those two must be
			// excluded — otherwise the approach leg along a gutter is reported as
			// "crossing" the card it is heading for.
			// Endpoint turns come from the layout itself (`data-from-turn` /
			// `data-to-turn`), not from screen distance: after fitView scales the
			// world, a nearest-card guess picks the wrong card and the approach leg
			// is then reported as crossing the card it is heading for.
			const edgeEndpoints = [...document.querySelectorAll<SVGGElement>(".tm-edge-group")].map(group => ({
				path: group.querySelector("path.tm-edge")!,
				endpoints: new Set([group.getAttribute("data-from-turn"), group.getAttribute("data-to-turn")]),
			}));
			const bad: string[] = [];
			for (const { path, endpoints } of edgeEndpoints) {
				const len = path.getTotalLength();
				const steps = Math.max(2, Math.ceil(len / 3));
				// `getPointAtLength` is in the path's OWN (world) coordinates; the
				// card rects are client (screen) coordinates after fitView's
				// translate/scale. Comparing them directly reports phantom
				// crossings, so project every sample through the CTM first.
				const matrix = path.getScreenCTM()!;
				for (let i = 1; i < steps; i++) {
					const local = path.getPointAtLength(len * (i / steps));
					const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
					const x = point.x;
					const y = point.y;
					for (const card of cards) {
						if (endpoints.has(card.turn)) continue;
						// 2px inset: a segment running along a card's border is not a crossing.
						if (x > card.left + 2 && x < card.right - 2 && y > card.top + 2 && y < card.bottom - 2) {
							bad.push(`${path.getAttribute("d")} → card ${card.turn} @${Math.round(x)},${Math.round(y)}`);
						}
					}
				}
			}
			return bad;
		});
		expect(crossings).toEqual([]);
	});
});
