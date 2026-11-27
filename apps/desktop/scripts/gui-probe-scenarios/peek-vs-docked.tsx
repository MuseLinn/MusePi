/**
 * The peek card versus the docked card — the pair a shared-element transition
 * would morph.
 *
 * `gui-side-panel.css` says the floating peek is "the SAME rounded card as the
 * docked one", so whether a view transition would show any travel at all is a
 * geometry question. Measuring both boxes answers it: identical rects mean the
 * transition would add nothing, and the honest answer is to leave the CSS
 * transition alone rather than ship a morph that does not move.
 */
import type { CSSProperties } from "react";
import { ScheduledTasksPanel } from "../../src/components/ScheduledTasksPanel";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, readBox } from "../gui-probe-helpers";

const PANE_W = 256;

const shell = (attrs: { panel?: string; peek?: boolean; peekOpen?: boolean }) => (
	<div className="gui-workspace-keeper" style={{ width: 1000, height: 640 }}>
		<div className="gui-main relative flex min-h-0 flex-1">
			<nav className="gui-rail" aria-label="rail">
				<div className="gui-rail-top" aria-hidden="true" />
			</nav>
			<div
				className="gui-side-keeper"
				data-panel={attrs.panel}
				data-peek={attrs.peek ? "true" : undefined}
				data-peek-open={attrs.peekOpen ? "true" : undefined}
				style={{ "--gui-side-w": `${PANE_W}px` } as CSSProperties}
			>
				<ScheduledTasksPanel width={PANE_W} collapsed={false} />
			</div>
			<div className="gui-chat-col flex min-w-0 flex-1 flex-col">
				<div className="gui-header flex h-12 flex-shrink-0 items-center px-4" />
				<div className="gui-chat-column flex-1" />
			</div>
		</div>
	</div>
);

const scenarios = {
	"peek-card": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell({ panel: "scheduled", peek: true, peekOpen: true }), root);
		},
		async measure(body: ParentNode) {
			const pane = body.querySelector(".gui-pane-side");
			const rail = body.querySelector(".gui-rail");
			return { pane: readBox(pane), rail: readBox(rail), position: pane ? getComputedStyle(pane).position : null };
		},
	},
	"docked-card": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell({ panel: "scheduled" }), root);
		},
		async measure(body: ParentNode) {
			const pane = body.querySelector(".gui-pane-side");
			const rail = body.querySelector(".gui-rail");
			return { pane: readBox(pane), rail: readBox(rail), position: pane ? getComputedStyle(pane).position : null };
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
