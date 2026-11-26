/**
 * The three left-panel destinations, folded and expanded.
 *
 * All three share `gui-side-panel.css` as one surface language, but only the
 * session sidebar used to carry the region cascade; the scheduled and
 * capability panels were cut by `overflow: hidden` alone. Reading the JSX cannot
 * tell the difference — both shapes produce identical markup — so the check is
 * the computed transition on each region plus the layout the narrowing pane
 * leaves behind.
 *
 * The assertions are the contract: each region declares the fold transition,
 * the body's is delayed behind the head's, and the folded regions keep their
 * expanded width instead of reflowing into the shrinking column.
 */
import type { CSSProperties, ReactNode } from "react";
import { CapabilitySidePanel } from "../../src/components/CapabilitySidePanel";
import { ScheduledTasksPanel } from "../../src/components/ScheduledTasksPanel";
import type { GuiScenario } from "../gui-probe-helpers";
import { measure, mount } from "../gui-probe-helpers";

const PANE_W = 256;

const REGIONS = {
	pane: ".gui-pane-side",
	head: ".gui-side-panel-head",
	scroll: ".gui-side-panel-scroll",
};

/** A keeper as `app.tsx` mounts it: one visible pane, the others out of flow. */
const keeper = (panel: string, collapsed: boolean, pane: ReactNode) => (
	<div className="gui-main" style={{ width: 1000, height: 600 }}>
		<div
			className="gui-side-keeper"
			data-panel={collapsed ? undefined : panel}
			style={{ "--gui-side-w": `${PANE_W}px` } as CSSProperties}
		>
			{pane}
		</div>
	</div>
);

/**
 * The fold facts `measure()` does not collect: each region's declared transition.
 * They are flattened onto the same row `measure()` produces, because `expect`
 * addresses `elements.<key>.<property>` and nothing else.
 */
function withFoldStyles(root: ParentNode) {
	const elements = measure(root, REGIONS);
	for (const [key, row] of Object.entries(elements)) {
		const node = root.querySelector<HTMLElement>(REGIONS[key as keyof typeof REGIONS]);
		if (!row || !node) continue;
		const style = getComputedStyle(node);
		(row as Record<string, unknown>).transitionProperty = style.transitionProperty;
		(row as Record<string, unknown>).transitionDelay = style.transitionDelay;
	}
	return elements;
}

const scenarios = {
	"scheduled-expanded": {
		capture: ".gui-side-keeper",
		async render(root: HTMLElement) {
			await mount(keeper("scheduled", false, <ScheduledTasksPanel width={PANE_W} collapsed={false} />), root);
		},
		async measure(body: ParentNode) {
			return { elements: withFoldStyles(body) };
		},
		expect: {
			pane: { "box.w": PANE_W },
		},
	},
	"scheduled-folded": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(keeper("scheduled", true, <ScheduledTasksPanel width={PANE_W} collapsed={true} />), root);
		},
		async measure(body: ParentNode) {
			return { elements: withFoldStyles(body) };
		},
		expect: {
			// A folded pane is out of flow and invisible; only its border box can
			// still report a couple of pixels, so the clip is the assertion.
			pane: { "box.w": { max: 4 }, opacity: "0" },
			// A region that was never given a transition reports `all`; the shape,
			// not the timing, is what tells the two situations apart.
			head: { transitionProperty: "opacity, transform" },
			scroll: { transitionProperty: "opacity, transform", transitionDelay: "0.025s" },
		},
	},
	"capability-expanded": {
		capture: ".gui-side-keeper",
		async render(root: HTMLElement) {
			await mount(keeper("capability", false, <CapabilitySidePanel width={PANE_W} collapsed={false} />), root);
		},
		async measure(body: ParentNode) {
			return { elements: withFoldStyles(body) };
		},
		expect: {
			pane: { "box.w": PANE_W },
		},
	},
	"capability-folded": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(keeper("capability", true, <CapabilitySidePanel width={PANE_W} collapsed={true} />), root);
		},
		async measure(body: ParentNode) {
			return { elements: withFoldStyles(body) };
		},
		expect: {
			pane: { "box.w": { max: 4 }, opacity: "0" },
			head: { transitionProperty: "opacity, transform" },
			scroll: { transitionProperty: "opacity, transform" },
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
