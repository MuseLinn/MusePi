import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Two reported UI defects (2026-11-08):
 *
 * 1. The transcript's top fade was an OPAQUE slab of `--gui-card-surface-fade`
 *    while the 对话/地图/信息 head showed the card's glass composite — a hard
 *    color seam, plus 24px of hidden content. Both edges now stack three
 *    masked backdrop layers with growing blur radii (progressive blur), and
 *    the head controls switched from `--color-bg` to the shared glass tokens.
 * 2. The collapsed terminal dock left a 1px hairline at the window bottom.
 *    gui-glass.css re-armed all four L1 borders on a `height: 0` element;
 *    the older fix only zeroed `border-top-width`.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CHAT = "packages/desktop-app/src/styles/gui-chat.css";
const GLASS = "packages/desktop-app/src/styles/gui-glass.css";
const WORKSPACE = "packages/desktop-app/src/styles/gui-workspace.css";
const TOKENS = "packages/client-core/src/styles/tokens.css";
const CHAT_VIEW = "packages/desktop-app/src/components/ChatView.tsx";
const GUI_CSS = "packages/desktop-app/src/styles/gui.css";

/** Body of the first rule whose selector text matches exactly. */
function rule(css: string, selector: string): string | null {
	const at = css.indexOf(selector);
	if (at < 0) return null;
	const open = css.indexOf("{", at);
	const close = css.indexOf("}", open);
	return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

describe("progressive-blur edge bands", () => {
	test("the three radii are globally defined tokens", () => {
		const css = read(TOKENS);
		expect(css).toContain("--gui-blur-progressive-1: 2px;");
		expect(css).toContain("--gui-blur-progressive-2: 6px;");
		expect(css).toContain("--gui-blur-progressive-3: 14px;");
		expect(css).toContain("--gui-card-surface-veil:");
	});

	test("both edges stack three masked layers with shrinking ramps", () => {
		const css = read(CHAT);
		const block = css.slice(css.indexOf("/* ── Progressive-blur edge bands"), css.indexOf("/* ── Focus mode"));
		expect(block, "progressive-blur block missing").not.toBe("");
		for (const edge of ["top", "end"]) {
			for (const step of [1, 2, 3]) {
				const body = rule(block, `.gui-chat-fade--${edge} .gui-chat-fade-layer--${step}`);
				expect(body, `${edge} layer ${step} missing`).not.toBeNull();
				expect(body).toContain(`blur(var(--gui-blur-progressive-${step}))`);
				expect(body).toContain("mask-image: linear-gradient(");
				expect(body).toContain(edge === "top" ? "to bottom" : "to top");
			}
		}
		expect(block).toContain("transparent 62%");
		expect(block).toContain("transparent 34%");
		expect(block).toContain("@supports not");
		expect(block).toContain("var(--gui-card-surface-fade)");
		expect(block, "no raw theme surface in the blur bands").not.toContain("var(--color-surface)");
	});

	test("both bands render exactly three sibling layers (no scroller mask)", () => {
		const tsx = read(CHAT_VIEW);
		expect(tsx.match(/gui-chat-fade-layer--\$\{step\}/g)?.length).toBe(2);
		expect(tsx.match(/\[1, 2, 3\]\.map/g)?.length).toBe(2);
		expect(tsx).not.toContain("maskImage");
	});

	test("head and controls share the derived card surface, not --color-bg", () => {
		const chat = read(CHAT);
		const head = rule(chat, ".gui-chat-head {");
		expect(head, ".gui-chat-head rule missing").not.toBeNull();
		expect(head).toContain("var(--gui-card-surface-veil)");
		expect(head).toContain("padding: 6px 12px 2px;");
		const toggle = rule(chat, ".gui-chat-info-toggle {");
		expect(toggle).toContain("var(--glass-hover)");
		expect(toggle).toContain("var(--glass-hairline)");
		expect(toggle).not.toContain("var(--color-bg)");
		const mode = rule(read(WORKSPACE), ".gui-surface-mode {");
		expect(mode).toContain("var(--glass-hover)");
		expect(mode).toContain("var(--glass-hairline)");
		expect(mode).not.toContain("var(--color-bg)");
	});

	test("gui-glass.css is still the last stylesheet", () => {
		const css = read(GUI_CSS);
		const imports = [...css.matchAll(/@import\s+"([^"]+)"/g)].map(m => m[1]);
		expect(imports[imports.length - 1]).toBe("./gui-glass.css");
	});
});

describe("collapsed terminal dock paints no hairline", () => {
	test("the last sheet zeroes EVERY border width, fill and shadow", () => {
		const css = read(GLASS);
		const selector = ".gui-terminal-dock:not(.gui-terminal-dock--open)";
		const body = rule(css, selector);
		expect(body, "closed-dock override missing from gui-glass.css").not.toBeNull();
		expect(body).toContain("border-width: 0;");
		expect(body).toContain("background: none;");
		expect(body).toContain("box-shadow: none;");
		// Must come after the L1 shorthand it overrides (this sheet loads last).
		expect(css.indexOf(selector)).toBeGreaterThan(css.indexOf("border: 1px solid var(--glass-hairline)"));
		// The high-contrast L1 list only changes border-color; width 0 wins.
		expect(css).toContain("border-color: var(--glass-hairline-strong)");
	});

	test("gui-chat.css closed state is a second line of defence", () => {
		const css = read(CHAT);
		const body = rule(css, ".gui-terminal-dock:not(.gui-terminal-dock--open)");
		expect(body).toContain("border-width: 0;");
		expect(body).toContain("background: none;");
		expect(body).toContain("box-shadow: none;");
		expect(css).toContain(".gui-terminal-dock:not(.gui-terminal-dock--open) {\n\tmargin: 0;");
	});
});
