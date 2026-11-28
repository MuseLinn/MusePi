/**
 * Where the rail's icons land, collapsed vs expanded.
 *
 * The rail switches `align-items: center` (52px strip) to `stretch` plus extra
 * inline padding (208px). Those two models do not agree about the ICON's x
 * position: centring puts a 36px button at (52-36)/2 = 8, while the stretched
 * row starts after 6px of padding and puts its glyph 8px into the row — so the
 * icon's centre moves sideways as the rail opens. A reader sees that as the
 * icons sliding, which is the "跳动" report.
 *
 * This measures the glyph's centre in both states. The contract is that it does
 * not move: the row may grow, the contents must stay put.
 */
import type { CSSProperties, ReactNode } from "react";
import { AppRail } from "../../src/components/AppRail";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount } from "../gui-probe-helpers";

const rail = (expanded: boolean): ReactNode => (
	<AppRail
		destinations={[
			{ id: "home", label: "general.home", icon: "home", active: true, onSelect: () => {} },
			{ id: "board", label: "settings.board", icon: "layout-column", onSelect: () => {} },
		]}
		panelAvailable
		onTogglePanel={() => {}}
		expanded={expanded}
		onToggleExpanded={() => {}}
	/>
);

const shell = (expanded: boolean) => (
	<div className="gui-main" style={{ width: 900, height: 600, padding: 8 }}>
		{rail(expanded)}
	</div>
);

/** The glyph's box relative to the rail: x says "slid sideways", y says "jumped". */
function glyphBox(body: ParentNode) {
	const railNode = body.querySelector(".gui-rail");
	if (!railNode) return null;
	const railBox = railNode.getBoundingClientRect();
	const round = (n: number) => Math.round(n * 100) / 100;
	// EVERY row, because a per-row change of a couple of pixels compounds: with
	// six destinations a 2px row-height difference moves the last row 10px, and
	// that accumulative shift is what a reader perceives as the rail jumping.
	const rows = Array.from(body.querySelectorAll<HTMLElement>(".gui-rail-btn")).map(row => {
		const box = row.getBoundingClientRect();
		return { top: round(box.top - railBox.top), left: round(box.left - railBox.left), h: round(box.height) };
	});
	return {
		rowCount: rows.length,
		firstTop: rows[0]?.top ?? null,
		lastTop: rows[rows.length - 1]?.top ?? null,
		lefts: rows.map(r => r.left),
		heights: rows.map(r => r.h),
	};
}

const scenarios = {
	"icon-anchor-collapsed": {
		capture: ".gui-rail",
		async render(root: HTMLElement) {
			await mount(shell(false), root);
		},
		async measure(body: ParentNode) {
			return { box: glyphBox(body) };
		},
	},
	"icon-anchor-expanded": {
		capture: ".gui-rail",
		async render(root: HTMLElement) {
			await mount(shell(true), root);
		},
		async measure(body: ParentNode) {
			return { box: glyphBox(body) };
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
