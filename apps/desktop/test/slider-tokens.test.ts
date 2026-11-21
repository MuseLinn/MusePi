import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * One slider contract for every slider in the GUI (2026-11-22).
 *
 * The thinking ladder used to be a native `<input type=range>` with its own
 * 4px rail and 14px thumb while the settings detent ladder carried a second,
 * unrelated 3px rail, and both roots shared the class name `.gui-ladder` — the
 * later rule silently gave the agent slider the settings ladder's 210px width.
 * They now share ONE token family (`--gui-slider-*`) and one visual
 * vocabulary: thick rail, gradient fill, detent dots, a knob that lifts on
 * hover/drag, the same focus halo and disabled opacity. The native
 * `.gui-range` inputs (sound, voice, pet size, notifications) consume the
 * same colours through `accent-color`.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CHAT = "apps/desktop/src/styles/gui-chat.css";
const SETTINGS = "apps/desktop/src/styles/gui-settings.css";
const COMPONENT = "apps/desktop/src/components/LadderSlider.tsx";
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
