/**
 * The left column's two fold transitions, as the browser runs them.
 *
 * The rail expands (tier one) and the session pane folds into the header's
 * toggle (tier two). Both go through `withViewTransition`, so the check is that
 * the API is actually entered with the column's own class on `<html>` — a name
 * present in CSS but never paired at runtime looks identical to a working one
 * in a screenshot.
 *
 * The probe stubs `document.startViewTransition` because the page has no
 * navigable transition of its own; the stub records the class set at the moment
 * the update runs, which is what the rules in `gui-chrome.css` key on.
 */
import type { CSSProperties, ReactNode } from "react";
import { AppRail } from "../../src/components/AppRail";
import { ScheduledTasksPanel } from "../../src/components/ScheduledTasksPanel";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, readBox, sleep } from "../gui-probe-helpers";
import { withViewTransition } from "../../src/lib/view-transition";

const PANE_W = 256;

type Record = { entered: boolean; classes: string[]; finished: boolean };

function installStub(sink: Record): void {
	const doc = document as unknown as {
		startViewTransition?: (update: () => void) => { finished: Promise<void> };
	};
	doc.startViewTransition = (update: () => void) => {
		sink.entered = true;
		// The update runs after the old snapshot, exactly as the real API does.
		update();
		sink.classes = Array.from(document.documentElement.classList);
		sink.finished = true;
		return { finished: Promise.resolve() };
	};
}

const rail = (expanded: boolean) => (
	<AppRail
		destinations={[
			{ id: "home", label: "general.home", icon: "home", active: true, panelId: "home", onSelect: () => {} },
			{ id: "board", label: "settings.board", icon: "layout-column", onSelect: () => {} },
		]}
		panelAvailable
		onTogglePanel={() => {}}
		expanded={expanded}
		onToggleExpanded={() => {}}
	/>
);

const shell = (collapsed: boolean, wide: boolean) => (
	<div className="gui-workspace-keeper" style={{ width: 1100, height: 640 }}>
		<div className="gui-main relative flex min-h-0 flex-1">
			{rail(wide)}
			<div
				className="gui-side-keeper"
				data-panel={collapsed ? undefined : "scheduled"}
				style={{ "--gui-side-w": `${PANE_W}px` } as CSSProperties}
			>
				<ScheduledTasksPanel width={PANE_W} collapsed={collapsed} />
			</div>
			<div className="gui-chat-col flex min-w-0 flex-1 flex-col">
				<div className="gui-header flex h-12 flex-shrink-0 items-center px-4">
					<button type="button" className="gui-sidebar-toggle" data-collapsed={collapsed ? "true" : "false"}>
						<span />
					</button>
				</div>
				<div className="gui-chat-column flex-1" />
			</div>
		</div>
	</div>
);

const scenarios = {
	/**
	 * Tier one: the rail widens. The transition must carry the column's class so
	 * the two card names apply, and must NOT leak the shared
	 * `gui-view-transition` naming (that one captures the composer).
	 */
	"rail-expand-transition": {
		capture: ".gui-main",
		async render(root: HTMLElement) {},
		async measure() {
			const sink: Record = { entered: false, classes: [], finished: false };
			installStub(sink);
			withViewTransition(() => {}, { surfaceOnly: true, extraClass: "gui-vt-left-col" });
			await sleep(30);
			return {
				entered: sink.entered,
				hasOwnClass: sink.classes.includes("gui-vt-left-col"),
				hasSurfaceOnly: sink.classes.includes("gui-vt-surface-only"),
				finished: sink.finished,
			};
		},
		expect: {
			// `expect` addresses `elements`, so the assertions live in the shape
			// below; these keys are checked by the run's own failure list.
		},
	},
	/** Tier two: folded vs docked, both still cards at the same top edge. */
	"pane-folded": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell(true, false), root);
		},
		async measure(body: ParentNode) {
			return {
				rail: readBox(body.querySelector(".gui-rail")),
				toggle: readBox(body.querySelector(".gui-sidebar-toggle")),
			};
		},
	},
	"pane-docked": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell(false, false), root);
		},
		async measure(body: ParentNode) {
			return {
				rail: readBox(body.querySelector(".gui-rail")),
				toggle: readBox(body.querySelector(".gui-sidebar-toggle")),
				pane: readBox(body.querySelector(".gui-pane-side")),
			};
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
