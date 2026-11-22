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
	"--gui-slider-hit",
	"--gui-slider-track",
	"--gui-slider-dot-size",
	"--gui-slider-knob-size",
	"--gui-slider-inset",
	"--gui-slider-rest",
	"--gui-slider-fill",
	"--gui-slider-dot",
	"--gui-slider-dot-on",
	"--gui-slider-knob",
	"--gui-slider-hairline",
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
		// The handle sits on the accent fill and takes text ink: the accent is
		// mid-luminance, so text always contrasts with it while an accent disc
		// would need a rim that reads as a ring at 18px.
		expect(css).toMatch(/--gui-slider-knob:\s*var\(--color-text\)/);
		// Filled detents sit on that same fill, so they share the ink.
		expect(css).toMatch(/--gui-slider-dot-on:\s*color-mix\(in oklab, var\(--color-accent-fg\)/);
	});

	test("one track markup draws both ladders from the family", () => {
		const chat = read(CHAT);
		const thinking = read(COMPONENT);
		const settings = read(SETTINGS_COMPONENT);
		// The track is ONE component: the settings ladder renders the thinking
		// ladder's `SliderTrack` instead of carrying a second track, so the two
		// cannot drift into two controls that merely resemble each other.
		expect(settings).toContain("SliderTrack");
		expect(settings).not.toContain("gui-ladder");
		// Two layers, two jobs: an INVISIBLE measured rail inset by the handle
		// radius (so hit-testing follows the token), and a full-bleed visible band
		// inset top/bottom inside the 28px hit pad.
		const rail = rules(chat, ".gui-slider-rail");
		expect(rail.length).toBeGreaterThan(0);
		expect(rail.some(rule => uses(rule.body, "--gui-slider-hit"))).toBe(true);
		const groove = rules(chat, ".gui-slider-groove");
		expect(groove.length).toBeGreaterThan(0);
		expect(groove.some(rule => uses(rule.body, "--gui-slider-track"))).toBe(true);
		expect(groove.some(rule => uses(rule.body, "--gui-slider-rest"))).toBe(true);
		expect(groove.some(rule => rule.body.includes("--gui-slider-hairline"))).toBe(true);
		const fill = rules(chat, ".gui-slider-fill");
		// The fill runs from the pill's edge and grows by the handle's diameter,
		// so even the first rung sits on accent instead of bare groove.
		expect(fill.some(rule => uses(rule.body, "--gui-slider-knob-size"))).toBe(true);
		expect(fill.some(rule => uses(rule.body, "--gui-slider-p"))).toBe(true);
		const knob = rules(chat, ".gui-slider-knob");
		expect(knob.some(rule => uses(rule.body, "--gui-slider-knob-size"))).toBe(true);
		expect(knob.some(rule => uses(rule.body, "--gui-slider-knob"))).toBe(true);
		// Both rungs are dots on the groove, not tick marks beside it.
		expect(thinking).toContain("gui-slider-dot${index <= slider.target");
		expect(chat).toContain(".gui-slider-dot::after");
	});

	test("native settings ranges consume the same colours and states", () => {
		const css = read(SETTINGS);
		const range = rules(css, ".gui-range");
		expect(range.some(rule => uses(rule.body, "--gui-slider-fill"))).toBe(true);
		expect(range.some(rule => uses(rule.body, "--gui-slider-disabled-opacity"))).toBe(true);
		// Hover must not paint a disabled input (scripts/check-disabled-hover.ts).
		expect(range.some(rule => rule.selector.includes(":hover:not(:disabled)"))).toBe(true);
	});

	test("the two ladders differ by their head, never by a second track", () => {
		const chat = read(CHAT);
		const component = read(COMPONENT);
		const settings = read(SETTINGS_COMPONENT);
		// The retired native-range classes must not come back.
		expect(chat).not.toContain(".gui-ladder-range");
		expect(component).not.toContain("gui-ladder-range");
		// One root class, one track; the settings ladder adds only a head/width
		// modifier, because two ladders that look like two controls is the
		// convergence defect this family exists to remove.
		expect(component).toContain('className="gui-slider"');
		expect(settings).toContain('className="gui-slider gui-slider--detent"');
		expect(rules(chat, ".gui-slider-track").length).toBeGreaterThan(0);
		// The settings ladder still owns its own width, so a 210px control never
		// leaks into the Agent pane.
		const detent = rules(chat, ".gui-slider--detent");
		expect(detent.some(rule => rule.body.includes("width: 210px"))).toBe(true);
		// No caption strip under the track: it was the row that read as
		// misaligned and pushed the head onto two lines.
		expect(chat).not.toContain(".gui-slider-ticks");
		expect(chat).not.toContain(".gui-slider-tick");
		expect(component).not.toContain("gui-slider-tick");
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
		// The settings ladder renders the same track, so the same gate covers it —
		// there is no second thumb rule left to guard separately.
		expect(chat).not.toContain(".gui-ladder-thumb");
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
		// The rendered position is `--gui-slider-p`, and the knob AND the fill are
		// placed by it — one property, so the fill always ends under the knob.
		const sliderKnob = rules(chat, ".gui-slider-knob");
		expect(sliderKnob.some(rule => uses(rule.body, "--gui-slider-p"))).toBe(true);
		const sliderFill = rules(chat, ".gui-slider-fill");
		expect(sliderFill.some(rule => uses(rule.body, "--gui-slider-p"))).toBe(true);
		// A held knob must not lag its pointer; the release restores the ease so
		// the detent snaps it in.
		expect(chat).toContain(".gui-slider-track[data-dragging] .gui-slider-fill");
		expect(chat).toContain(".gui-slider-track[data-dragging] .gui-slider-knob");
	});

	test("the thinking head is one line; no rung label sits under the track", () => {
		const chat = read(CHAT);
		const component = read(COMPONENT);
		// The head carries the section label and the current level together, and
		// the row cannot wrap: the level was the line the narrow Agent pane
		// pushed underneath the label.
		const head = rules(chat, ".gui-slider-head");
		expect(head.length).toBeGreaterThan(0);
		expect(head.some(rule => rule.body.includes("white-space: nowrap"))).toBe(true);
		expect(component).toContain('className="gui-slider-label"');
		expect(component).toContain('className="gui-slider-value"');
		// The pane no longer prints a second section head above the slider: that
		// stacked label was what made the value look like a caption.
		const pane = read(PANE);
		const sliderAt = pane.indexOf("<LadderSlider");
		expect(sliderAt).toBeGreaterThan(-1);
		// Nothing between the slider and the end of its section may print a head:
		// the control owns the label, so the pane cannot stack a second one above
		// it. Only the loading/unsupported branch keeps a head, and that branch
		// renders no slider.
		const thinkingSection = pane.slice(sliderAt, pane.indexOf("</section>", sliderAt));
		expect(thinkingSection).not.toContain("gui-agent-info-section-head");
		// Every rung names itself on its dot, which is the only label surface.
		expect(component).toContain("title={label}");
		expect(component).toContain("aria-valuetext={valueText}");
	});

	test("the auto readout replaces the value instead of adding a second line", () => {
		const component = read(COMPONENT);
		// One readout string feeds the head, `aria-valuetext` and the dots, so the
		// visible value and the announcement cannot disagree — and `Auto · <level>`
		// spends the same slot as a plain level rather than a row of its own.
		expect(component).toContain("const readout = rung.auto && resolved ?");
		expect(component).toContain("valueText={readout}");
		expect(component).not.toContain("gui-slider-resolved");
	});

	test("a capped rung stays named and the off rung stays reachable", () => {
		const chat = read(CHAT);
		const component = read(COMPONENT);
		// Capped is a SHAPE change, not a disappearance: the dot keeps its title,
		// so a rung above the model's ceiling is still readable by hover.
		expect(chat).toContain(".gui-slider-dot[data-capped]");
		expect(chat).toContain(".gui-slider-dot::after");
		expect(component).toContain("capped?.[index]");
		// `off` is rung 0 of the ladder and the ladders' first stop, never a
		// filtered-out label.
		expect(component).toContain("{ level: null, label: labelFor(null), capped: false, auto: false }");
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
