import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * One grip contract for every user-resizable seam (2026-11-16).
 *
 * The sidebar|chat seam, the chat|right-panel seam and the chat|terminal dock
 * used to carry three unrelated affordances: a 3px transparent span, a
 * `::after` hairline that only existed on hover, and a whole-band accent tint
 * on hover. None of them sat on the seam, and none of them moved. They now
 * mount ONE `.gui-split-grip` pill inside a positioning hit band, with one
 * rest / hover+focus / drag vocabulary. Geometry lives in `tokens.css`
 * (`--gui-grip-*`), the primitive in `gui-settings.css`, and the bands only
 * decide where the seam is.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const TOKENS = "packages/client-core/src/styles/tokens.css";
const SETTINGS = "apps/desktop/src/styles/gui-settings.css";
const CHAT = "apps/desktop/src/styles/gui-chat.css";
const SIDE_SEAM = "apps/desktop/src/app.tsx";
const PANEL_SEAM = "apps/desktop/src/components/ContextPanel.tsx";
const DOCK_SEAM = "apps/desktop/src/components/ChatView.tsx";

const SEAM_BANDS = [".gui-resize-x--side", ".gui-pane-resize-x", ".gui-dock-handle"] as const;

/** Body of the first rule whose selector text matches exactly. */
function rule(css: string, selector: string): string | null {
	const at = css.indexOf(selector);
	if (at < 0) return null;
	const open = css.indexOf("{", at);
	const close = css.indexOf("}", open);
	return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

/** Every rule that styles a grip CHILD of a hit band, as { selector, body }.
 *  Matches both `> .gui-split-grip` and the descendant form: the interaction
 *  states use a descendant combinator on purpose (the minifier mangles
 *  `:is(…)>`, so status is propagated onto the pill instead). */
function gripChildRules(css: string): { selector: string; body: string }[] {
	const out: { selector: string; body: string }[] = [];
	for (const match of css.matchAll(/([^{}]*\s>?\s*\.gui-split-grip[^{}]*)\{([^}]*)\}/g)) {
		out.push({ selector: match[1].trim(), body: match[2] });
	}
	return out;
}

describe("splitter grip tokens", () => {
	test("tokens.css owns the grip geometry and its three-state colour", () => {
		const css = read(TOKENS);
		for (const token of [
			"--gui-grip-thickness",
			"--gui-grip-length",
			"--gui-grip-rest",
			"--gui-grip-hover",
			"--gui-grip-drag",
			"--gui-grip-transition",
		]) {
			expect(new RegExp(`${token}:\\s*[^;]+;`).test(css), `${token} undefined`).toBe(true);
		}

		// Hover and drag enlarge the pill; the exact millimetres are a designer's
		// call, the direction is the contract.
		const px = (token: string): number => Number(css.match(new RegExp(`${token}:\\s*([\\d.]+)px;`))?.[1] ?? NaN);
		expect(px("--gui-grip-thickness-active")).toBeGreaterThan(px("--gui-grip-thickness"));
		expect(px("--gui-grip-length-active")).toBeGreaterThan(px("--gui-grip-length"));

		// Colours derive from the active theme's foreground, so every palette and
		// both schemes get a grip that is visible on its own card.
		const rest = css.match(/--gui-grip-rest:[^;]+;/)?.[0] ?? "";
		const hover = css.match(/--gui-grip-hover:[^;]+;/)?.[0] ?? "";
		const drag = css.match(/--gui-grip-drag:[^;]+;/)?.[0] ?? "";
		expect(rest).toContain("color-mix(");
		expect(rest).toContain("var(--fg");
		expect(hover).toContain("color-mix(");
		expect(hover).toContain("var(--fg");
		expect(drag).toContain("var(--color-accent)");
	});
});

describe("splitter grip primitive", () => {
	test("gui-settings.css defines the vertical pill and the horizontal variant", () => {
		const css = read(SETTINGS);
		const grip = rule(css, ".gui-split-grip {");
		expect(grip, ".gui-split-grip rule missing").not.toBeNull();
		// Centred inside its hit band; the band owns the seam coordinate.
		expect(grip).toContain("position: absolute;");
		expect(grip).toContain("top: 50%;");
		expect(grip).toContain("left: 50%;");
		expect(grip).toContain("transform: translate(-50%, -50%);");
		expect(grip).toContain("width: var(--gui-grip-thickness);");
		expect(grip).toContain("height: var(--gui-grip-length);");
		expect(grip).toContain("border-radius: var(--radius-full);");
		expect(grip).toContain("background: var(--gui-grip-rest);");
		// Decoration only: the band receives the gesture.
		expect(grip).toContain("pointer-events: none;");
		expect(grip).toContain("transition:");

		const row = rule(css, ".gui-split-grip--row {");
		expect(row, ".gui-split-grip--row rule missing").not.toBeNull();
		expect(row).toContain("width: var(--gui-grip-length);");
		expect(row).toContain("height: var(--gui-grip-thickness);");
	});

	test("all three seam bands share the same hover and focus-visible state", () => {
		const css = read(SETTINGS);
		// The hover/focus state is declared once over the shared band group and
		// reaches the pill through a descendant rule. `:hover` and
		// `:focus-visible` both live on the band; `:focus-within` must not (a
		// pointer grab must never leave the grip lit).
		const hoverRules = [...css.matchAll(/([^{}]*:hover[^{}]*\.gui-split-grip[^{}]*)\{([^}]*)\}/g)].map(m => ({
			selector: m[1].trim(),
			body: m[2],
		}));
		expect(hoverRules.length, "no hover rule reaches a grip").toBeGreaterThan(0);
		const selector = hoverRules.map(r => r.selector).join("\n");
		const body = hoverRules.map(r => r.body).join("\n");
		for (const band of SEAM_BANDS) expect(selector).toContain(band);
		// The dock's right-docked edge is the same seam in its other placement.
		expect(selector).toContain(".gui-terminal-right-handle");
		expect(selector).toContain(":focus-visible");
		expect(selector).not.toContain(":focus-within");
		// Hover must yield to the drag state instead of fighting it.
		expect(selector).toContain(":not([data-resizing])");
		expect(body).toContain("background: var(--gui-grip-hover);");
		expect(body).toContain("width: var(--gui-grip-thickness-active);");
		expect(body).toContain("height: var(--gui-grip-length-active);");
	});

	test("the horizontal grip promotes the length axis, not the thickness axis", () => {
		const css = read(SETTINGS);
		const row = rule(css, ".gui-split-grip--row {");
		expect(row, "row grip base rule missing").not.toBeNull();
		expect(row).toContain("width: var(--gui-grip-length);");
		expect(row).toContain("height: var(--gui-grip-thickness);");
		const rowHot = rule(css, ".gui-split-grip--row[data-hot] {");
		expect(rowHot, "row hover state missing").not.toBeNull();
		expect(rowHot).toContain("width: var(--gui-grip-length-active);");
		expect(rowHot).toContain("height: var(--gui-grip-thickness-active);");
	});

	test("dragging turns ONLY the dragged seam's grip to the accent", () => {
		const css = read(SETTINGS);
		// Per-seam, not global: `body.gui-resizing` only means "a resize is in
		// flight" (resize cursor + selection lock), so keying the grip look on
		// it lit every seam at once.
		expect(css.includes("body.gui-resizing .gui-split-grip"), "drag state is still global").toBe(false);
		const drag = rule(css, ".gui-split-grip[data-resizing] {");
		expect(drag, "per-seam drag state missing").not.toBeNull();
		expect(drag).toContain("background: var(--gui-grip-drag);");
		expect(drag).toContain("width: var(--gui-grip-thickness-active);");
		expect(drag).toContain("height: var(--gui-grip-length-active);");

		const dragRow = rule(css, ".gui-split-grip--row[data-resizing] {");
		expect(dragRow, "row drag state missing").not.toBeNull();
		expect(dragRow).toContain("width: var(--gui-grip-length-active);");
		expect(dragRow).toContain("height: var(--gui-grip-thickness-active);");
	});

	test("reduced motion drops the grip transition", () => {
		expect(read(SETTINGS)).toMatch(
			/@media \(prefers-reduced-motion: reduce\) \{\s*\.gui-split-grip \{\s*transition: none;\s*\}\s*\}/,
		);
	});
});

describe("sidebar seam geometry", () => {
	test("the hit band centres on the gap BETWEEN the two cards", () => {
		const band = rule(read(SETTINGS), ".gui-resize-x--side {");
		expect(band, ".gui-resize-x--side rule missing").not.toBeNull();

		// The keeper's right edge is the panel card's right edge. The chat card
		// adds one gutter, so the midpoint is half a gutter beyond the keeper.
		const left = band?.match(/left:\s*([^;]+);/)?.[1] ?? "";
		expect(left).toBe("calc(100% + var(--gui-card-gutter) / 2)");
	});

	test("the right-panel band escapes the clip and sits ON the seam", () => {
		// The panel clips overflow, so an in-flow band could only ever grab at the
		// panel's own edge — the pill moved to the seam, the pointer did not.
		// Both the band and its pill are `fixed` and placed from the measured
		// seam variables, so what you see and what you can grab are the same box.
		// Anchor on the standalone rule: `indexOf` also matches the
		// `.gui-pane-right--inner--closed .gui-pane-resize-x` override below it.
		const chatCss = read(CHAT);
		const start = chatCss.search(/\n\.gui-pane-resize-x \{\n/);
		expect(start, "right-panel band missing").toBeGreaterThan(-1);
		const band = chatCss.slice(chatCss.indexOf("{", start), chatCss.indexOf("}", start) + 1);
		expect(band, "right-panel band missing").not.toBeNull();
		expect(band).toContain("position: fixed;");
		expect(band).toContain("left: var(--gui-pane-resize-seam");
		expect(band).toContain("top: var(--gui-pane-resize-seam-y");
		// Centred on the seam in both axes rather than offset inside the edge.
		expect(band).toContain("transform: translate(-50%, -50%);");
		expect(band, "band still tucked inside the panel").not.toContain("left: 0;");
	});

	test("the dock band escapes the clip and sits ON the horizontal seam", () => {
		// Same anchor problem as the panel band: `indexOf` would land on the
		// `.gui-terminal-dock:not(…) .gui-dock-handle` rule first.
		const chatCss = read(CHAT);
		const start = chatCss.search(/\n\.gui-dock-handle \{\n/);
		expect(start, "dock band missing").toBeGreaterThan(-1);
		const band = chatCss.slice(chatCss.indexOf("{", start), chatCss.indexOf("}", start) + 1);
		expect(band).toContain("position: fixed;");
		expect(band).toContain("top: var(--gui-dock-resize-seam");
		expect(band).toContain("transform: translateY(-50%);");
	});

	test("the vertical span binds to the card, not to the workspace", () => {
		const band = rule(read(SETTINGS), ".gui-resize-x--side {") ?? "";
		// A workspace-relative `top: 50%` rides header + gutters above the seam.
		expect(band).not.toContain("top: 50%");
		const top = band.match(/top:\s*([^;]+);/)?.[1] ?? "";
		expect(top).toContain("calc(");
		expect(top).toContain("var(--gui-header-h)");
		expect(top).toContain("var(--gui-card-gutter)");
		const bottom = band.match(/bottom:\s*([^;]+);/)?.[1] ?? "";
		expect(bottom).toContain("calc(");
		expect(bottom).toContain("var(--gui-card-gutter)");
	});
});

describe("the old per-seam affordances are gone", () => {
	test("gui-chat.css paints no ::after grip on the right-pane edge", () => {
		// Comments may still explain the removal; selectors may not survive.
		const css = read(CHAT).replace(/\/\*[\s\S]*?\*\//g, "");
		expect(css.includes(".gui-pane-resize-x::after"), "gui-chat.css still styles a ::after grip").toBe(false);
	});

	test("no component still mounts the retired .gui-resize-grip span", () => {
		expect(read(SIDE_SEAM)).not.toContain("gui-resize-grip");
	});

	test("every seam mounts the SplitterGrip component, never a copied span", () => {
		// The pill used to be a hand-written `<span className="gui-split-grip" />`
		// at four call sites — the copy count that the repo's convergence rule
		// calls a defect. Mounting the component is the contract now; a fifth
		// hand-rolled span is exactly what this catches.
		for (const rel of [SIDE_SEAM, PANEL_SEAM, DOCK_SEAM]) {
			const src = read(rel);
			expect(src.includes("<SplitterGrip"), `${rel} does not mount <SplitterGrip />`).toBe(true);
			expect(src.includes('className="gui-split-grip'), `${rel} still hand-writes a grip span`).toBe(false);
		}
		// The horizontal seam is the one variant, and it is requested by prop.
		expect(read(DOCK_SEAM)).toContain('orientation="horizontal"');
		// Exactly one place defines the markup.
		const component = read("apps/desktop/src/components/SplitterGrip.tsx");
		expect(component).toContain("gui-split-grip");
		expect(component).toContain("gui-split-grip--row");
	});
});
