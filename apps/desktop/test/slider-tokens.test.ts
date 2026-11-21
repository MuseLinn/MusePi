import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * One slider contract for the GUI's in-scope sliders (2026-11-22).
 *
 * The thinking ladder used to be a native `<input type=range>` with its own
 * 4px rail and 14px thumb while the settings detent ladder carried a second,
 * unrelated 3px rail, and both roots shared the class name `.gui-ladder` — the
 * later rule silently gave the agent slider the settings ladder's 210px width.
 * They now share ONE token family (`--gui-slider-*`) and one visual
 * vocabulary: thick rail, gradient fill, detent dots, a knob that lifts on
 * hover/drag, the same focus halo and disabled opacity. The two native
 * `.gui-range` opt-ins (notification master volume, companion size) consume
 * the same colours through `accent-color`; the sliders listed under "Slider
 * scope" in `docs/gui-components.md` stay outside the family.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CHAT = "apps/desktop/src/styles/gui-chat.css";
const SETTINGS = "apps/desktop/src/styles/gui-settings.css";
const COMPONENT = "apps/desktop/src/components/LadderSlider.tsx";
const SETTINGS_COMPONENT = "apps/desktop/src/components/settings-controls/LadderSlider.tsx";
const PANE = "apps/desktop/src/lib/surfaces/agent-info-pane.tsx";

const FAMILY = [
	"--gui-slider-track",
	"--gui-slider-dot-size",
	"--gui-slider-knob-size",
	"--gui-slider-inset",
	"--gui-slider-rest",
	"--gui-slider-fill",
	"--gui-slider-dot",
	"--gui-slider-dot-on",
	"--gui-slider-knob",
	"--gui-slider-knob-rim",
	"--gui-slider-focus",
	"--gui-slider-hover-scale",
	"--gui-slider-ease",
	"--gui-slider-disabled-opacity",
] as const;

/** Body of every rule whose selector text contains `className`. */
function rules(css: string, className: string): { selector: string; body: string }[] {
	const out: { selector: string; body: string }[] = [];
	for (const match of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
		const selector = (match[1] ?? "").trim();
		if (selector.includes(className)) out.push({ selector, body: match[2] ?? "" });
	}
	return out;
}

const uses = (body: string, token: string): boolean => body.includes(`var(${token}`);

describe("shared slider tokens", () => {
	test("the token family lives in one place and drives the shared geometry", () => {
		const css = read(CHAT);
		for (const token of FAMILY) {
			expect(new RegExp(`${token}:\\s*[^;]+;`).test(css), `${token} undefined`).toBe(true);
		}
		// A rail, a detent and a knob cannot drift apart: the inset derives
		// from the knob instead of restating a number.
		expect(css).toMatch(/--gui-slider-inset:\s*calc\(var\(--gui-slider-knob-size\)\s*\/\s*2\)/);
		// The knob is the accent, not a hollow ring — that is what makes it
		// readable at a glance in both schemes.
		expect(css).toMatch(/--gui-slider-knob:\s*var\(--color-accent\)/);
	});

	test("both custom ladders draw from the family", () => {
		const chat = read(CHAT);
		const thinkingRail = rules(chat, ".gui-slider-rail");
		expect(thinkingRail.length).toBeGreaterThan(0);
		expect(thinkingRail.some(rule => uses(rule.body, "--gui-slider-track"))).toBe(true);
		const thinkingFill = rules(chat, ".gui-slider-fill");
		expect(thinkingFill.some(rule => uses(rule.body, "--gui-slider-inset"))).toBe(true);

		const thinkingKnob = rules(chat, ".gui-slider-knob");
		expect(thinkingKnob.some(rule => uses(rule.body, "--gui-slider-knob-size"))).toBe(true);
		expect(thinkingKnob.some(rule => uses(rule.body, "--gui-slider-knob"))).toBe(true);

		const settingsRail = rules(chat, ".gui-ladder-rail");
		expect(settingsRail.some(rule => uses(rule.body, "--gui-slider-rest"))).toBe(true);
		const settingsKnob = rules(chat, ".gui-ladder-thumb");
		expect(settingsKnob.some(rule => uses(rule.body, "--gui-slider-knob-size"))).toBe(true);
		expect(settingsKnob.some(rule => uses(rule.body, "--gui-slider-hover-scale"))).toBe(true);
	});

	test("native settings ranges consume the same colours and states", () => {
		const css = read(SETTINGS);
		const range = rules(css, ".gui-range");
		expect(range.some(rule => uses(rule.body, "--gui-slider-fill"))).toBe(true);
		expect(range.some(rule => uses(rule.body, "--gui-slider-disabled-opacity"))).toBe(true);
		// Hover must not paint a disabled input (scripts/check-disabled-hover.ts).
		expect(range.some(rule => rule.selector.includes(":hover:not(:disabled)"))).toBe(true);
	});

	test("the agent slider no longer collides with the settings ladder", () => {
		const chat = read(CHAT);
		const component = read(COMPONENT);
		// The retired native-range classes must not come back.
		expect(chat).not.toContain(".gui-ladder-range");
		expect(component).not.toContain("gui-ladder-range");
		// The agent slider is its own root, so the settings ladder's width and
		// alignment never leak into it again.
		expect(component).toContain('className="gui-slider"');
		expect(rules(chat, ".gui-slider-track").length).toBeGreaterThan(0);
		expect(rules(chat, ".gui-ladder-track").length).toBeGreaterThan(0);
	});

	test("the model disclosure keeps the keyboard contract without :focus-within", () => {
		const chat = read(CHAT);
		const pane = read(PANE);
		expect(chat).toContain(".gui-agent-model-card:focus-visible");
		// `:focus-within` is sticky (a click stays "focused" until focus leaves
		// the subtree), so the card's focus state is its own :focus-visible.
		const uncommented = chat.replace(/\/\*[\s\S]*?\*\//g, "");
		const selectors = [...uncommented.matchAll(/([^{}]*)\{/g)].map(match => match[1] ?? "");
		expect(selectors.some(selector => selector.includes(":focus-within"))).toBe(false);
		expect(pane).toContain("aria-expanded={modelOpen}");
		expect(pane).toContain("active={modelOpen}");
		expect(pane).toContain("onDismiss={collapseModel}");
	});

	test("a disabled slider never lifts its knob on hover", () => {
		const chat = read(CHAT);
		// `scripts/check-disabled-hover.ts` only understands the `:disabled`
		// pseudo-class, so a disabled state carried on `data-disabled` needs its
		// own gate: the hover rule must exclude it at the wrapper.
		const knob = rules(chat, ".gui-slider-knob").filter(rule => rule.body.includes("hover-scale"));
		expect(knob.length).toBeGreaterThan(0);
		for (const rule of knob) {
			expect(rule.selector).toContain(':not([data-disabled="true"])');
		}
		// Same for the settings ladder's `--disabled` modifier class.
		const thumb = rules(chat, ".gui-ladder-thumb").filter(rule => rule.body.includes("hover-scale"));
		expect(thumb.length).toBeGreaterThan(0);
		for (const rule of thumb) {
			expect(rule.selector).toContain(":not(.gui-ladder--disabled)");
		}
	});

	test("pointer math reads the laid-out rail, never a restated knob radius", () => {
		const component = read(COMPONENT);
		// `--gui-slider-inset` is the single authority for the end-stop inset;
		// the shared drag hook measures the CSS-inset rail so a knob-size change
		// moves hit-testing with it.
		expect(component).not.toContain("KNOB_INSET");
		expect(component).toContain("rail.current?.getBoundingClientRect()");
		expect(component).toContain('className="gui-slider-rail"');
		// The drag delta was dead: the drag maps absolute pointer x.
		expect(component).not.toContain("startX");
	});

	test("both ladders draw the thumb from a fractional position, never a rung index", () => {
		const chat = read(CHAT);
		const settings = read(SETTINGS_COMPONENT);
		// One pointer implementation: the settings ladder imports the thinking
		// ladder's hook instead of restating the math.
		expect(settings).toContain('from "../LadderSlider"');
		expect(settings).toContain("useSliderDrag");
		expect(settings).not.toContain("getBoundingClientRect");
		// The rendered position is `--gui-slider-p` / `--gui-ladder-p`, and the
		// knob is placed by it in both primitives.
		const sliderKnob = rules(chat, ".gui-slider-knob");
		expect(sliderKnob.some(rule => uses(rule.body, "--gui-slider-p"))).toBe(true);
		const ladderThumb = rules(chat, ".gui-ladder-thumb");
		expect(ladderThumb.some(rule => uses(rule.body, "--gui-ladder-p"))).toBe(true);
		// A held thumb must not lag its pointer; the release restores the ease so
		// the detent snaps it in.
		expect(chat).toContain(".gui-slider-track[data-dragging] .gui-slider-fill");
		expect(chat).toContain(".gui-ladder-track[data-dragging] .gui-ladder-thumb");
	});

	test("reduced motion drops the new transitions", () => {
		const css = read(CHAT);
		const start = css.indexOf(".gui-motion-off .gui-slider-knob");
		expect(start).toBeGreaterThan(-1);
		const block = css.slice(start, start + 900);
		expect(block).toContain(".gui-agent-model-card-caret");
		expect(block).toContain("@media (prefers-reduced-motion: reduce)");
		expect(block).toContain(".gui-slider-knob");
		expect(block).toContain(".gui-agent-model-card-caret");
	});
});
