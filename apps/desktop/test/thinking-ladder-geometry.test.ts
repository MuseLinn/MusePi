import "./happy-dom-shim";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setLocale } from "@musepi/client-core";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

// The ladder's label and rung names come from the dictionaries; pin the
// locale so a machine-bound default cannot make the assertions locale-dependent.
setLocale("zh-CN");

/**
 * Thinking ladder geometry (puppeteer, real cascade).
 *
 * The complaint that produced this file was visual, so the facts are measured
 * on a laid-out page:
 *  1. the head is ONE line — the section label and the current level sit side
 *     by side, and neither wraps under the other, at the NARROWEST Agent-pane
 *     width (260px panel − its padding);
 *  2. there is no caption row under the track, and every rung is a dot that
 *     carries its own name, so removing the row did not remove the labels;
 *  3. the track is the inline shape rather than a form field: a 28px hit pill
 *     whose groove is inset top and bottom, exactly what the reference menu
 *     does, with the fill ending under the knob;
 *  4. capped rungs stay named and `off` stays reachable — a shorter ladder must
 *     not lose its ends.
 *
 * Markup comes from the real component (`renderToStaticMarkup`) wherever the
 * shape matters; the reference's 28px pill is asserted against the cascade, not
 * against a hand-written fixture that could drift from it.
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = ["gui-base.css", "gui-settings.css", "gui-chat.css"]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { SliderTrack, LadderSlider } = require("../src/components/LadderSlider");
const { LadderSlider: SettingsLadder } = require("../src/components/settings-controls/LadderSlider");

/** A drag state as the hook would hand it to the track at rung `value`. */
const slider = (value: number, dragging = false) => ({
	setRail: () => {},
	position: value,
	target: value,
	dragging,
	handlers: {},
	step: () => {},
});

/** The thinking ladder as the Agent tab mounts it: `off | minimal … high | auto`. */
const LADDER = () =>
	React.createElement(LadderSlider, {
		efforts: ["minimal", "low", "medium", "high"],
		value: "medium",
		resolved: null,
		ceiling: "high",
		onCommit: () => {},
	});

/** The settings detent ladder as a settings row mounts it. */
const DETENT = () =>
	React.createElement(SettingsLadder, {
		steps: [
			{ value: 0, label: "0" },
			{ value: 0.2, label: "0.2" },
			{ value: 0.5, label: "0.5" },
			{ value: 0.7, label: "0.7" },
			{ value: 1, label: "1" },
		],
		value: 0.7,
		onChange: () => {},
		ariaLabel: "Temperature",
	});

/** The pane at its narrowest: a 260px panel minus the pane's 12px side padding
 *  (`.gui-agent-info` is `padding: 10px 12px 16px`), inside the section's own
 *  flex column. */
const NARROW_PANE = 260;
const NARROW_CONTENT = NARROW_PANE - 24;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 900, height: 700 });
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

/** Mount `html` at the narrowest panel width and read the geometry back. */
async function measure(html: string, paneWidth = NARROW_PANE) {
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
				--color-accent-fg: rgb(20, 30, 50);
				--color-warning: rgb(230, 180, 90);
				--border: rgb(70, 70, 70);
				--radius-sm: 4px;
				--radius-md: 8px;
				--radius-lg: 12px;
				--radius-full: 999px;
				--ui-font-size-xs: 11px;
				--ui-font-size-sm: 13px;
				--ui-font-size: 13px;
			}
			${CASCADE}
			body { margin: 0; }
			#panel { width: ${paneWidth}px; background: var(--color-surface); }
		</style>
		<div id="panel"><div class="gui-agent-info">${html}</div></div>`);
	await page.evaluate(() =>
		Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))),
	);
	return page.evaluate(() => {
		const box = (element: Element | null): Box | null => {
			if (!element) return null;
			const rect = element.getBoundingClientRect();
			return {
				top: Math.round(rect.top * 100) / 100,
				left: Math.round(rect.left * 100) / 100,
				width: Math.round(rect.width * 100) / 100,
				height: Math.round(rect.height * 100) / 100,
				bottom: Math.round(rect.bottom * 100) / 100,
				right: Math.round(rect.right * 100) / 100,
			};
		};
		const one = (selector: string) => document.querySelector<HTMLElement>(selector);
		const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
		const head = one(".gui-slider-head");
		const label = one(".gui-slider-label");
		const value = one(".gui-slider-value");
		const track = one(".gui-slider-track");
		const rail = one(".gui-slider-rail");
		const groove = one(".gui-slider-groove");
		const numbers = (selector: string) =>
			[...document.querySelectorAll<HTMLElement>(selector)].map(element => ({
				label: element.getAttribute("title"),
				capped: element.hasAttribute("data-capped"),
				on: element.classList.contains("gui-slider-dot--on"),
				box: box(element),
			}));
		return {
			pane: box(one("#panel")),
			slider: box(one(".gui-slider")),
			head: box(head),
			// Specific primitives: a CSSStyleDeclaration does not survive the
			// Puppeteer serialization boundary.
			headDisplay: head ? getComputedStyle(head).display : null,
			headWhiteSpace: head ? getComputedStyle(head).whiteSpace : null,
			headLineHeight: head ? Number.parseFloat(getComputedStyle(head).lineHeight) : 0,
			label: box(label),
			labelText: label?.textContent ?? null,
			labelScrollWidth: label?.scrollWidth ?? null,
			value: box(value),
			valueText: value?.textContent ?? null,
			track: box(track),
			rail: box(rail),
			groove: box(groove),
			grooveShadow: groove ? getComputedStyle(groove).boxShadow : null,
			grooveBorderTop: groove ? getComputedStyle(groove).borderTopWidth : null,
			fill: box(one(".gui-slider-fill")),
			knob: box(one(".gui-slider-knob")),
			dots: numbers(".gui-slider-dot"),
			// Nothing else may sit between the track and the end of the block.
			afterTrack: track?.nextElementSibling?.className ?? null,
			tickRows: all(".gui-slider-ticks").length,
		};
	});
}

describe("thinking ladder geometry", () => {
	test("the head is one line at the narrowest pane: label and level side by side", async () => {
		const narrow = await measure(renderToStaticMarkup(LADDER()));
		expect(narrow.headDisplay).toBe("flex");
		expect(narrow.headWhiteSpace).toBe("nowrap");
		// One line tall: the head cannot grow into the two-row stack the user
		// saw. A wrapped row would roughly double this height.
		expect(narrow.head!.height).toBeLessThanOrEqual(Math.max(narrow.headLineHeight, 18) + 1);
		// Both texts are inside the row, on the same baseline, and neither is
		// pushed under the other.
		expect(narrow.labelText).toBe("思考强度");
		expect(narrow.valueText).toBe("中");
		for (const part of [narrow.label!, narrow.value!]) {
			expect(part.top).toBeGreaterThanOrEqual(narrow.head!.top);
			expect(part.bottom).toBeLessThanOrEqual(narrow.head!.bottom);
		}
		expect(narrow.label!.right).toBeLessThanOrEqual(narrow.value!.left + 1);
		// Reading order left to right, with the level at the row's end.
		expect(narrow.label!.left).toBeLessThan(narrow.value!.left);
		// The value is never clipped by the narrow column, and the label gives way
		// first (it is the one that may ellipsize).
		expect(narrow.value!.right).toBeLessThanOrEqual(narrow.head!.right + 0.5);
		expect(narrow.labelScrollWidth!).toBeLessThanOrEqual(narrow.label!.width + 1);
	});

	test("no caption row under the track; each rung names itself on its dot", async () => {
		const narrow = await measure(renderToStaticMarkup(LADDER()));
		expect(narrow.tickRows).toBe(0);
		// The track is followed by the capped note or by nothing — never a label
		// strip. Here the model ceiling is the top rung, so no note is needed.
		expect(narrow.afterTrack === null || !narrow.afterTrack.includes("tick")).toBe(true);
		// Six rungs (off, four efforts, auto) all keep their names.
		expect(narrow.dots.map(dot => dot.label)).toEqual(["关闭思考", "最低", "低", "中", "高", "Auto"]);
		// The filled portion is marked on the rungs themselves: every rung up to
		// and including the current one is on, and the one after it is not.
		expect(narrow.dots.map(dot => dot.on)).toEqual([true, true, true, true, false, false]);
	});

	test("the track is the inline pill: a 28px hit pad with an inset groove", async () => {
		const narrow = await measure(renderToStaticMarkup(LADDER()));
		// The hit area the pointer gets, and the band drawn inside it.
		expect(narrow.track!.height).toBe(28);
		expect(narrow.groove!.height).toBe(22);
		// Inset by 3px a side inside the pill, the reference's `top/bottom: 3px`.
		expect(narrow.groove!.top - narrow.track!.top).toBeCloseTo(3, 1);
		expect(narrow.track!.bottom - narrow.groove!.bottom).toBeCloseTo(3, 1);
		// The VISIBLE band is full-bleed: the handle travels between the pill's
		// capped ends, so a band stopping short of them reads as dead ears.
		expect(narrow.groove!.left).toBeCloseTo(narrow.track!.left, 0);
		expect(narrow.groove!.right).toBeCloseTo(narrow.track!.right, 0);
		// The MEASURED rail is inset by half a handle, so an end stop never
		// overhangs the pill — and it is invisible, existing only for the pointer.
		expect(narrow.rail!.left - narrow.track!.left).toBeCloseTo(9, 1);
		expect(narrow.track!.right - narrow.rail!.right).toBeCloseTo(9, 1);
		expect(narrow.rail!.width).toBeCloseTo(NARROW_CONTENT - 18, 0);
		// An inset hairline on the band, not a border (a border would change the
		// band's box and the pill's cap).
		expect(narrow.grooveShadow).toContain("inset");
		expect(narrow.grooveBorderTop).toBe("0px");
		// Dots sit ON the groove, centered in the pill.
		for (const dot of narrow.dots) {
			expect(dot.box!.top + dot.box!.height / 2).toBeCloseTo(narrow.track!.top + 14, 0);
		}
		// Detents are the 4px family size, not a second size for this ladder.
		for (const dot of narrow.dots) expect(dot.box!.width).toBe(4);
	});

	test("the fill ends under the knob, and the knob rides the groove at every rung", async () => {
		for (const rung of [0, 2, 3, 5]) {
			const html = renderToStaticMarkup(
				React.createElement(SliderTrack, {
					slider: slider(rung),
					last: 5,
					labels: ["关闭思考", "最低", "低", "中", "高", "Auto"],
					valueText: "中",
				}),
			);
			const narrow = await measure(html);
			// The fill runs THROUGH the handle: its right edge is the handle's right
			// edge, so the filled end is a filled cap and the handle never straddles
			// the boundary between accent and groove.
			expect(Math.abs(narrow.fill!.right - narrow.knob!.right)).toBeLessThanOrEqual(1);
			// The fill always starts at the pill's left edge, so even rung 0 sits on
			// accent rather than bare groove, and it never leaves the pill.
			expect(narrow.fill!.left).toBeCloseTo(narrow.track!.left, 0);
			expect(narrow.fill!.right).toBeLessThanOrEqual(narrow.groove!.right + 0.5);
			// The knob is vertically centered in the groove.
			expect(narrow.knob!.top + narrow.knob!.height / 2).toBeCloseTo(
				narrow.track!.top + narrow.track!.height / 2,
				1,
			);
		}
	});

	test("the ends stay reachable: `off` is the first dot and a capped top keeps its name", async () => {
		// A model whose ceiling is below its ladder: the rungs above are drawn as
		// hollow, unreachable dots that still carry their labels.
		const capped = await measure(
			renderToStaticMarkup(
				React.createElement(LadderSlider, {
					efforts: ["minimal", "low", "medium", "high", "max"],
					value: "low",
					ceiling: "medium",
					onCommit: () => {},
				}),
			),
		);
		expect(capped.dots.map(dot => dot.capped)).toEqual([false, false, false, false, true, true, false]);
		expect(capped.dots.filter(dot => dot.capped).map(dot => dot.label)).toEqual(["高", "极限"]);
		// The capped rungs keep a drawing of their own (a hollow ring), so the
		// rung is not simply missing from the ladder.
		expect(capped.dots[4]!.box!.width).toBe(4);
		// The first dot is `off` and sits at the groove's left cap: the end stop is
		// on the track, not outside it.
		expect(capped.dots[0]!.label).toBe("关闭思考");
		expect(capped.dots[0]!.box!.left + capped.dots[0]!.box!.width / 2).toBeCloseTo(capped.rail!.left, 0);
		// The last dot (auto) is at the right cap.
		expect(capped.dots.at(-1)!.box!.left + capped.dots.at(-1)!.box!.width / 2).toBeCloseTo(capped.rail!.right, 0);
		expect(capped.dots.at(-1)!.label).toBe("Auto");
	});

	test("the auto readout spends the value slot instead of adding a line", async () => {
		const auto = await measure(
			renderToStaticMarkup(
				React.createElement(LadderSlider, {
					efforts: ["minimal", "low", "medium", "high"],
					value: "auto",
					resolved: "high",
					ceiling: "high",
					onCommit: () => {},
				}),
			),
		);
		// One readout string: the auto rung plus what it resolved to this turn.
		expect(auto.valueText).toBe("Auto · 高");
		expect(auto.head!.height).toBeLessThanOrEqual(19);
		// Still a single row at the narrowest width.
		expect(auto.label!.right).toBeLessThanOrEqual(auto.value!.left + 1);
		expect(auto.value!.right).toBeLessThanOrEqual(auto.head!.right + 0.5);
	});

	test("the settings detent ladder is the same track under its own head", async () => {
		// The real row: a label column first, then the control — which is where
		// the ladder's own 210px width applies (the row's label column owns the
		// free width).
		const detent = await measure(
			`<div class="gui-settings-row"><div class="min-w-0 flex-1"><div class="gui-settings-row-label"><span class="gui-settings-row-label-text">Temperature</span></div></div>${renderToStaticMarkup(DETENT())}</div>`,
		);
		const thinking = await measure(renderToStaticMarkup(LADDER()));
		// Same pill, same groove, same dots, same knob: the two ladders are one
		// control. A second look would be the convergence defect this family
		// exists to remove.
		expect(detent.track!.height).toBe(thinking.track!.height);
		expect(detent.rail!.height).toBe(thinking.rail!.height);
		expect(detent.dots[0]!.box!.width).toBe(thinking.dots[0]!.box!.width);
		expect(detent.knob!.width).toBe(thinking.knob!.width);
		// It differs by its head only: no section label to sit beside, so the value
		// takes the row above the track, and the row keeps its 210px width.
		expect(detent.labelText).toBeNull();
		expect(detent.valueText).toBe("0.7");
		expect(detent.slider!.width).toBeLessThanOrEqual(211);
	});

	test("the ladder fills the pane at every panel width, never wrapping its head", async () => {
		for (const width of [260, 320, 420, 620]) {
			const measured = await measure(renderToStaticMarkup(LADDER()), width);
			const content = width - 24;
			// The rail spans the content width minus half a knob a side.
			expect(measured.rail!.width).toBeCloseTo(content - 18, 0);
			// The head stays a single row at every width.
			expect(measured.label!.right).toBeLessThanOrEqual(measured.value!.left + 1);
			expect(measured.head!.height).toBeLessThanOrEqual(19);
		}
	});
});
