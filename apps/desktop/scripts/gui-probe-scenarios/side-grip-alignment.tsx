/**
 * Where the side grip sits versus the seam it is supposed to run along.
 *
 * The grip is a child of the panel keeper and centres itself in the card gap.
 * This measures the pane's real right edge, the chat's left edge and the grip's
 * centre, which is the only triple that answers "is the handle on the divider".
 */
import type { CSSProperties, ReactNode } from "react";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount } from "../gui-probe-helpers";

/** The left column as the shell lays it out: rail card, keeper, chat column. */
const shell = (railExpanded = false, sideWidth = 256, wideRail = false): ReactNode => (
	<div
		className="gui-main relative flex min-h-0 flex-1"
		// As in the shell: the token lives on a shared ancestor of the keeper AND
		// the band, or the band cannot resolve it.
		style={
			{
				width: 1200,
				height: 700,
				"--gui-side-w": `${sideWidth}px`,
				// The band reads `--gui-rail-w-current`; the shell publishes it from
				// the rail's live state, which is what this mirrors.
				"--gui-rail-w-current": wideRail ? "var(--gui-rail-w-wide)" : "var(--gui-rail-w)",
			} as CSSProperties
		}
	>
		<nav className={`gui-rail${wideRail ? " gui-rail--wide" : ""}`} aria-label="rail" style={{ paddingInline: 6 }}>
			<div className="gui-rail-top" aria-hidden="true" />
		</nav>
		<div
			className="gui-side-keeper"
			data-panel="home"
		>
			<div className="gui-resize-x gui-resize-x--side" role="separator" aria-orientation="vertical">
				<span className="gui-split-grip" />
			</div>
			<aside className="gui-pane-side" style={{ width: sideWidth }} />
		</div>
		<div className="gui-chat-col flex min-w-0 flex-1 flex-col">
			<div className="gui-chat-column" style={{ flex: 1 }} />
		</div>
	</div>
);

function geometry(body: ParentNode, railExpanded: boolean) {
	const root = body.querySelector<HTMLElement>(".gui-main");
	const panel = body.querySelector<HTMLElement>(".gui-pane-side");
	const grip = body.querySelector<HTMLElement>(".gui-resize-x--side");
	const pill = body.querySelector<HTMLElement>(".gui-split-grip");
	if (!root || !panel || !grip || !pill) return null;
	const rb = root.getBoundingClientRect();
	const round = (n: number) => Math.round(n * 100) / 100;
	const pb = panel.getBoundingClientRect();
	const gb = grip.getBoundingClientRect();
	const lb = pill.getBoundingClientRect();
	const chat = body.querySelector<HTMLElement>(".gui-chat-column");
	const cb = chat?.getBoundingClientRect();
	const chatLeft = cb ? round(cb.left - rb.left) : null;
	const gapMid = cb ? round((pb.right - rb.left + (cb.left - rb.left)) / 2) : null;
	return {
		railExpanded,
		panelRight: round(pb.right - rb.left),
		chatLeft,
		// The seam the reader perceives: the MIDDLE of the gap between the two
		// cards. Anchoring to either edge reads as "inside the panel" or "inside
		// the chat", which is the reported misplacement.
		gapMid,
		// Where the seam actually is: the pane's right edge.
		gripCentre: round(gb.left + gb.width / 2 - rb.left),
		pillCentre: round(lb.left + lb.width / 2 - rb.left),
		// The number that must be ~0 for the handle to look attached.
		offsetFromSeam: gapMid === null ? null : round(gb.left + gb.width / 2 - rb.left - gapMid),
		// The hint line: present as a pseudo-element, transparent at rest.
		bandLeft: round(gb.left - rb.left),
		bandW: round(gb.width),
		pillLeft: round(lb.left - rb.left),
		computedLeft: getComputedStyle(grip).left,
		hintWidth: getComputedStyle(grip, "::before").width,
		hintOpacity: getComputedStyle(grip, "::before").opacity,
		hintBackground: getComputedStyle(grip, "::before").backgroundImage !== "none",
	};
}

function measuredGeometry(body: ParentNode, railExpanded: boolean) {
	const value = geometry(body, railExpanded);
	if (!value) throw new Error("side grip geometry is incomplete");
	if (value.offsetFromSeam === null || Math.abs(value.offsetFromSeam) > 1) {
		throw new Error(`side grip is off the card seam by ${value.offsetFromSeam}px`);
	}
	if (Math.abs(value.gripCentre - value.pillCentre) > 1) throw new Error("grip pill is not centred in its band");
	return value;
}

const scenarios = {
	"grip-on-seam": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell(false), root);
		},
		async measure(body: ParentNode) {
			return { geometry: measuredGeometry(body, false) };
		},
	},
	/** The hint must be VISIBLE while the band is active — the state the reader
	 *  actually sees. Rendering with `data-resizing` proves the same rule set the
	 *  hover path uses lights up. */
	"grip-hint-on-hover": {
		capture: ".gui-resize-x--side",
		async render(root: HTMLElement) {
			const node = shell(false) as React.ReactElement;
			await mount(node, root);
			document.querySelector(".gui-resize-x--side")?.setAttribute("data-resizing", "");
		},
		async measure(body: ParentNode) {
			const grip = body.querySelector<HTMLElement>(".gui-resize-x--side");
			if (!grip) return { missing: true };
			const style = getComputedStyle(grip, "::before");
			return {
				opacity: style.opacity,
				width: style.width,
				background: style.backgroundImage !== "none",
			};
		},
	},
	/** A resized panel: the constant must not be tuned to 256px. */
	"grip-on-seam-resized": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			const node = shell(false, 340) as React.ReactElement;
			await mount(node, root);
		},
		async measure(body: ParentNode) {
			return { geometry: measuredGeometry(body, false) };
		},
	},
	"grip-on-seam-wide-rail": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			const node = shell(true, 256, true) as React.ReactElement;
			await mount(node, root);
		},
		async measure(body: ParentNode) {
			return { geometry: measuredGeometry(body, true) };
		},
	},
	/** The reported case: with a WIDE rail and the token NOT republished, the band
	 *  still computes from 52px and sits 156px inside the panel. */
	"grip-with-wide-rail-unpublished": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			const node = shell(true, 256, false) as React.ReactElement;
			await mount(node, root);
		},
		async measure(body: ParentNode) {
			return { geometry: measuredGeometry(body, true) };
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
