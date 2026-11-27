/**
 * Left edges of the rail's three bands: header, destinations, footer.
 *
 * Each band was written at a different time with its own padding chain, so the
 * mark, the destination glyphs and the footer controls do not share a left
 * edge — and because the chains differ BETWEEN widths, they also do not line up
 * with themselves across a fold. This measures the GLYPH x of each band in both
 * states, which is the fact the eye actually reads as "aligned".
 */
import type { ReactNode } from "react";
import { AppRail, RailCommunityLinks } from "../../src/components/AppRail";
import { InstanceButton } from "../../src/components/InstanceButton";
import { UserAccountButton } from "../../src/components/AppRail";
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
		community={<RailCommunityLinks expanded={expanded} />}
		account={
			<UserAccountButton
				rpc={null}
				cwd="."
				connected
				onOpenSettings={() => {}}
				onDisconnect={() => {}}
				instanceMenu={
					<InstanceButton
						embedded
						rpc={null}
						connected
						daemonUrl="http://localhost:1"
						hosts={[]}
						onSwitchHost={() => {}}
						onAddTarget={() => {}}
						onRemoveHost={() => {}}
						onReconnect={() => {}}
						onDisconnect={() => {}}
						onOpenWorkspace={() => {}}
						onOpenManager={() => {}}
						onOpenDisclaimer={() => {}}
					/>
				}
			/>
		}
	/>
);

const shell = (expanded: boolean) => (
	<div className="gui-main" style={{ width: 900, height: 700, padding: 8 }}>{rail(expanded)}</div>
);

/** Left edge of a band's leading glyph, relative to the rail's content box. */
function bandEdges(body: ParentNode) {
	const railNode = body.querySelector<HTMLElement>(".gui-rail");
	if (!railNode) return null;
	const railBox = railNode.getBoundingClientRect();
	const round = (n: number) => Math.round(n * 100) / 100;
	const edge = (selector: string): number | null => {
		const node = body.querySelector<HTMLElement>(selector);
		if (!node) return null;
		return round(node.getBoundingClientRect().left - railBox.left);
	};
	/** CENTRE x, which is what "aligned on the column axis" means. A left edge
	 *  differs by half the element's width, so it cannot compare a 36px mark with
	 *  an 18px glyph. */
	const centre = (selector: string): number | null => {
		const node = body.querySelector<HTMLElement>(selector);
		if (!node) return null;
		const r = node.getBoundingClientRect();
		return round(r.left + r.width / 2 - railBox.left);
	};
	return {
		railLeft: round(railBox.left),
		railWidth: round(railBox.width),
		// The brand mark inside the header button.
		headerGlyph: centre(".gui-rail-brand-mark"),
		headerCentre: centre(".gui-rail-brand-mark"),
		rowCentre: centre(".gui-rail-btn .gui-rail-icon"),
		headerButton: edge(".gui-rail-brand"),
		// A destination's glyph.
		rowButton: edge(".gui-rail-btn"),
		rowGlyph: edge(".gui-rail-btn .gui-rail-icon"),
		// Footer controls.
		instanceGlyph: edge(".gui-instance-btn .gui-rail-icon, .gui-instance-btn > *"),
		accountGlyph: edge(".gui-account-btn .gui-user-avatar"),
		accountCentre: centre(".gui-account-face"),
		dotCentre: centre(".gui-account-dot"),
		accountInner: edge(".gui-account-btn"),
		instanceInner: edge(".gui-instance-btn"),
		// Computed padding shows WHICH rule won, which the edge alone cannot say.
		headPad: (() => {
			const n = body.querySelector<HTMLElement>(".gui-rail-head");
			return n ? getComputedStyle(n).paddingLeft : null;
		})(),
		brandPad: (() => {
			const n = body.querySelector<HTMLElement>(".gui-rail-brand");
			return n ? getComputedStyle(n).paddingLeft : null;
		})(),
		// The mark: square box, hairline ring, and a hover scale rather than a tilt.
		markBox: (() => {
			const n = body.querySelector<HTMLElement>(".gui-rail-brand-mark");
			if (!n) return null;
			const r = n.getBoundingClientRect();
			const cs = getComputedStyle(n);
			return {
				w: Math.round(r.width),
				h: Math.round(r.height),
				radius: cs.borderTopLeftRadius,
				shadow: cs.boxShadow !== "none",
				transition: cs.transitionProperty,
			};
		})(),
		headComputed: (() => {
			const n = body.querySelector<HTMLElement>(".gui-rail-head");
			if (!n) return null;
			const cs = getComputedStyle(n);
			const b = body.querySelector<HTMLElement>(".gui-rail-brand");
			const bs = b ? getComputedStyle(b) : null;
			return {
				headJustify: cs.justifyContent,
				headPadL: cs.paddingLeft,
				brandW: bs?.width,
				brandPadL: bs?.paddingLeft,
				brandJustify: bs?.justifyContent,
			};
		})(),
		railPad: (() => {
			const n = body.querySelector<HTMLElement>(".gui-rail");
			return n ? getComputedStyle(n).paddingLeft : null;
		})(),
	};
}

const scenarios = {
	"bands-collapsed": {
		capture: ".gui-rail",
		async render(root: HTMLElement) {
			await mount(shell(false), root);
		},
		async measure(body: ParentNode) {
			return { edges: bandEdges(body) };
		},
	},
	"bands-expanded": {
		capture: ".gui-rail",
		async render(root: HTMLElement) {
			await mount(shell(true), root);
		},
		async measure(body: ParentNode) {
			return { edges: bandEdges(body) };
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
