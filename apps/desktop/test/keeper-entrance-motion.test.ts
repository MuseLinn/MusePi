import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Keepers hide with `display: none`; they must not carry an entrance animation.
 *
 * `display` change restarts any animation on the element, so an animation on a
 * keeper's base class replays every time the keeper is shown again. The chat
 * column keeper did exactly that with the shared `.gui-view-blur-in`
 * (`filter: blur(10px)` → `blur(0)`): closing Settings replayed a 300ms
 * full-column blur over header + transcript + composer — an offscreen
 * rasterization of a surface that was merely hidden, not entering.
 *
 * The contract: an element that toggles `display` to hide itself carries no
 * `animation` in its own rule. Surfaces that really enter opt in with a
 * modifier (`.gui-view-enter`, `.gui-chat-keeper--enter`, …).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const BOARD_CSS = path.join(REPO_ROOT, "apps/desktop/src/styles/gui-board.css");

/**
 * Body of the rule whose selector LIST contains `selector` (the keepers share
 * rules with a comma, e.g. `.gui-chat-keeper--enter, .gui-workspace-keeper--enter`).
 * Returns the first match; `--hidden` variants are separate rules.
 */
function ruleBody(css: string, selector: string): string | undefined {
	// Comments sit between rules and would otherwise be captured as part of the
	// next selector list.
	const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const match of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
		const selectors = (match[1] ?? "")
			.split(",")
			.map(part => part.trim())
			.filter(Boolean);
		if (selectors.includes(selector)) return match[2];
	}
	return undefined;
}

describe("keeper display toggles and entrance animations", () => {
	const css = fs.readFileSync(BOARD_CSS, "utf8");

	test("the recipe still exists: keepers hide with display:none", () => {
		expect(ruleBody(css, ".gui-chat-col-keeper--hidden")).toContain("display: none");
		expect(ruleBody(css, ".gui-side-keeper--hidden")).toContain("display: none");
	});

	test("the chat-column keeper carries no animation of its own", () => {
		const body = ruleBody(css, ".gui-chat-col-keeper");
		expect(body).toBeDefined();
		expect(body).not.toContain("animation");
	});

	test("the sidebar keeper next to it carries none either", () => {
		const body = ruleBody(css, ".gui-side-keeper");
		expect(body).toBeDefined();
		expect(body).not.toContain("animation");
	});

	test("keepers reveal with opacity, never with a full-surface blur", () => {
		for (const selector of [".gui-chat-keeper--enter", ".gui-workspace-keeper--enter"]) {
			const body = ruleBody(css, selector);
			expect(body).toContain("gui-keeper-reveal");
			expect(body).not.toContain("gui-view-blur-in");
		}
	});

	test("a real view entrance keeps the blur", () => {
		expect(ruleBody(css, ".gui-view-enter")).toContain("gui-view-blur-in");
	});

	test("the full-surface view transition follows the motion contract", () => {
		// `filter: blur()` re-rasterizes the whole surface every frame; it must
		// not run for a user who asked for reduced motion, in either form.
		for (const selector of [
			".gui-motion-off .gui-view-enter",
			".gui-motion-off .gui-chat-keeper--enter",
			".gui-motion-off .gui-workspace-keeper--enter",
		]) {
			expect(ruleBody(css, selector)).toContain("animation: none");
		}
	});

	test("a leaving surface disappears instead of lingering at full opacity", () => {
		// The leave keyframes end at opacity 0 with `fill: forwards`. Dropping
		// the animation alone would leave the surface fully visible for the
		// 150ms its JS window keeps it mounted.
		for (const selector of [".gui-motion-off .gui-view-leave", ".gui-motion-off .gui-slot-leave"]) {
			const body = ruleBody(css, selector);
			expect(body).toContain("animation: none");
			expect(body).toContain("opacity: 0");
		}
	});
});
