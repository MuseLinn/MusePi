import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Touch-target floors for phone-only controls.
 *
 * HarmonyOS @cross-device-app-dev/touch-target-size requires ≥40vp and
 * recommends 48vp. The shell answers with one `@media (pointer: coarse)`
 * block so the floor follows the input device instead of the viewport width,
 * which means a control left out of that block keeps its desktop size on a
 * phone. These rules resolve the cascade the way the browser does — a
 * declaration that is present but outranked by a later same-specificity rule
 * still leaves the control too small, so presence alone proves nothing.
 */

const CSS = fs.readFileSync(path.resolve(import.meta.dir, "../src/components/shell/shell.css"), "utf8");

/** Comments name the old behaviour, so they must not satisfy an assertion. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

const FLOOR_PX = 48;
const COARSE_OPENER = "@media (pointer: coarse)";

const STRIPPED = stripComments(CSS);

interface Rule {
	selectors: string[];
	declarations: Map<string, string>;
	inCoarse: boolean;
	order: number;
}

/** Half-open character range of the at-rule body at `opener`, brace-matched. */
function atRuleRange(css: string, opener: string): { start: number; end: number } {
	const at = css.indexOf(opener);
	if (at === -1) throw new Error(`missing ${opener}`);
	const open = css.indexOf("{", at);
	if (open === -1) throw new Error(`missing body for ${opener}`);
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}") {
			depth--;
			if (depth === 0) return { start: open + 1, end: i };
		}
	}
	throw new Error(`unclosed ${opener}`);
}

const COARSE_RANGE = atRuleRange(STRIPPED, COARSE_OPENER);

/**
 * Every rule in the sheet, flattened. At-rule preludes never match because
 * their body contains a brace, so only real selector blocks are collected.
 */
const RULES: Rule[] = [...STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match, order) => {
	const declarations = new Map<string, string>();
	for (const raw of match[2]!.split(";")) {
		const separator = raw.indexOf(":");
		if (separator === -1) continue;
		declarations.set(raw.slice(0, separator).trim(), raw.slice(separator + 1).trim());
	}
	return {
		selectors: match[1]!.split(",").map(selector => selector.trim()),
		declarations,
		inCoarse: match.index! >= COARSE_RANGE.start && match.index! < COARSE_RANGE.end,
		order,
	};
});

function pxValue(raw: string | null | undefined): number | null {
	if (raw === null || raw === undefined) return null;
	const match = /^(-?\d+(?:\.\d+)?)px$/.exec(raw.trim());
	return match ? Number(match[1]) : null;
}

function specificity(selector: string): number {
	const ids = (selector.match(/#[\w-]+/g) ?? []).length;
	const classes =
		(selector.match(/\.[\w-]+/g) ?? []).length +
		(selector.match(/\[[^\]]*\]/g) ?? []).length +
		(selector.match(/(?<!:):[\w-]+/g) ?? []).length;
	const elements = (selector.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
	return ids * 10_000 + classes * 100 + elements;
}

/**
 * Whether `selector` can match an element whose class set is `classes`.
 * A descendant combinator would need ancestor context these tests do not
 * model, so every compound part must be satisfied by the element itself.
 */
function matches(selector: string, classes: readonly string[]): boolean {
	const parts = selector.split(/\s+/).map(part => part.split(".").filter(Boolean));
	return parts.every(partClasses => partClasses.every(name => classes.includes(name)));
}

/**
 * The declaration that wins for an element with class set `classes` on a
 * coarse pointer: base rules and coarse-block rules both apply, ordered by
 * specificity, then source order.
 */
function effective(classes: readonly string[], prop: string): string | null {
	let winner: { value: string; specificity: number; order: number } | null = null;
	for (const rule of RULES) {
		const value = rule.declarations.get(prop);
		if (value === undefined) continue;
		for (const selector of rule.selectors) {
			if (!matches(selector, classes)) continue;
			const weight = specificity(selector);
			if (!winner || weight > winner.specificity || (weight === winner.specificity && rule.order >= winner.order)) {
				winner = { value, specificity: weight, order: rule.order };
			}
		}
	}
	return winner?.value ?? null;
}

/** Horizontal padding `border-box` reserves inside an element's width. */
function paddingInline(classes: readonly string[]): number {
	const parts = (effective(classes, "padding") ?? "").split(/\s+/).filter(Boolean);
	if (parts.length === 0) return 0;
	const pick = (index: number): number => pxValue(parts[Math.min(index, parts.length - 1)]) ?? 0;
	// 1 value: all sides. 2: block inline. 3: top inline bottom. 4: top right bottom left.
	if (parts.length === 1) return pick(0) * 2;
	if (parts.length === 2) return pick(1) * 2;
	if (parts.length === 3) return pick(1) * 2;
	return pick(1) + pick(3);
}

/** Horizontal borders `border-box` reserves inside an element's width. */
function borderInline(classes: readonly string[]): number {
	const raw = effective(classes, "border");
	if (!raw) return 0;
	const width = raw
		.split(/\s+/)
		.map(pxValue)
		.find(value => value !== null);
	return (width ?? 0) * 2;
}

/** Vertical padding `border-box` reserves inside an element's height. */
function paddingBlock(classes: readonly string[]): number {
	const parts = (effective(classes, "padding") ?? "").split(/\s+/).filter(Boolean);
	if (parts.length === 0) return 0;
	const pick = (index: number): number => pxValue(parts[Math.min(index, parts.length - 1)]) ?? 0;
	// 1 value: all sides. 2: block inline. 3: top inline bottom. 4: top right bottom left.
	if (parts.length === 1) return pick(0) * 2;
	return pick(0) + (parts.length >= 3 ? pick(2) : pick(0));
}

/** Vertical borders `border-box` reserves inside an element's height. */
function borderBlock(classes: readonly string[]): number {
	return borderInline(classes);
}

/** Class name a selector list is built from, e.g. ".sh-jobaction" -> "sh-jobaction". */
const classOf = (selector: string): string => selector.replace(/^\./, "");

/** An element's real class attribute, which is what the cascade matches on. */
const classesOf = (selector: string): string[] =>
	selector === ".sh-ws-sidebar--closed" ? ["sh-ws-sidebar", "sh-ws-sidebar--closed"] : [classOf(selector)];

describe("touch targets that fell outside the coarse-pointer floor", () => {
	const iconControls = [".sh-jobaction", ".sh-tree-toggle", ".qr-close"];
	const rail = ".sh-ws-sidebar--closed";

	for (const selector of [...iconControls, rail]) {
		test(`${selector} is named inside the coarse-pointer block`, () => {
			const named = RULES.some(rule => rule.inCoarse && rule.selectors.some(s => matches(s, classesOf(selector))));
			expect(named, `${selector} is not declared in ${COARSE_OPENER}`).toBe(true);
		});
	}

	test("the small icon controls win the floor on both axes", () => {
		for (const selector of iconControls) {
			const classes = classesOf(selector);
			// The base rules set a fixed width/height (22px, 16px, 40px); a
			// min-width that loses the cascade would leave those sizes intact.
			expect(pxValue(effective(classes, "min-width")), `${selector} min-width`).toBeGreaterThanOrEqual(FLOOR_PX);
			expect(pxValue(effective(classes, "min-height")), `${selector} min-height`).toBeGreaterThanOrEqual(FLOOR_PX);
		}
	});

	test("the collapsed rail keeps its toggle unclipped", () => {
		// The rail is `overflow: hidden` and only its toggle is clickable, so the
		// rail's content box — width minus inline padding and borders, every
		// element being border-box — has to hold a 48px target.
		const classes = classesOf(rail);
		const minWidth = pxValue(effective(classes, "min-width"));
		expect(minWidth, `${rail} has no effective min-width under a coarse pointer`).not.toBeNull();
		const contentBox = minWidth! - paddingInline(classes) - borderInline(classes);
		expect(contentBox, `collapsed rail content box is ${contentBox}px, toggle is clipped`).toBeGreaterThanOrEqual(
			FLOOR_PX,
		);
	});

	test("the rail's height caps leave room for the same toggle", () => {
		// The rail has no explicit height: it grows to padding plus the toggle's
		// 48px box. Only a fixed cap can cut that short, so every px cap has to
		// stay above 48 + block padding + borders. The calc() cap scales with the
		// viewport and cannot bind unless the viewport is absurdly short.
		const classes = classesOf(rail);
		const needed = FLOOR_PX + paddingBlock(classes) + borderBlock(classes);
		for (const prop of ["height", "max-height"]) {
			const raw = effective(classes, prop);
			if (raw === null || raw.includes("calc(")) continue;
			const cap = pxValue(raw);
			expect(cap, `${rail} ${prop}: ${raw} is not a px length`).not.toBeNull();
			expect(cap!, `collapsed rail ${prop} is ${raw}, toggle needs ${needed}px`).toBeGreaterThanOrEqual(needed);
		}
		expect(pxValue(effective(["sh-ws-sidebar-toggle"], "min-height"))).toBeGreaterThanOrEqual(FLOOR_PX);
	});
});
