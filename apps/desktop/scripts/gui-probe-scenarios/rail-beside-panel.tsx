/**
 * The left column as a person sees it: the 52px rail beside the session panel.
 *
 * The two-tier shell is deliberate, but the rail used to paint no material at
 * all — `background: transparent`, no border, no radius — while the panel beside
 * it was a rounded card. This scenario measures the column as paint and as
 * geometry, because "the rail reads as leftover space" is a claim about paint
 * that reading the JSX cannot settle.
 */
import type { CSSProperties, ReactNode } from "react";
import { AppRail } from "../../src/components/AppRail";
import { ScheduledTasksPanel } from "../../src/components/ScheduledTasksPanel";
import type { GuiScenario } from "../gui-probe-helpers";
import { measure, mount } from "../gui-probe-helpers";

const PANE_W = 256;

/** The rail as `app.tsx` mounts it: destinations only (footer needs rpc). */
const rail = (panelAvailable: boolean, expanded = false, onToggleExpanded?: () => void) => (
	<AppRail
		destinations={[
			{ id: "home", label: "general.home", icon: "home", active: true, panelId: "home", onSelect: () => {} },
			{
				id: "scheduled",
				label: "settings.scheduledTasks",
				icon: "calendar-schedule",
				panelId: "scheduled",
				onSelect: () => {},
			},
			{ id: "board", label: "settings.board", icon: "layout-column", onSelect: () => {} },
		]}
		panelAvailable={panelAvailable}
		onTogglePanel={() => {}}
		expanded={expanded}
		onToggleExpanded={onToggleExpanded}
	/>
);

/** The shell as `app.tsx` stacks it: `.gui-main` holds the rail and the slot;
 *  the header lives inside the chat column, NOT above `.gui-main`. Getting this
 *  wrong makes the rail's own 48px band look like an inter-pane gap. */
const column = (collapsed: boolean, pane: ReactNode, railExpanded = false) => (
	<div className="gui-workspace-keeper" style={{ width: 1100, height: 640 }}>
		<div className="gui-main relative flex min-h-0 flex-1">
			{rail(!collapsed, railExpanded, () => {})}
			<div
				className="gui-side-keeper"
				data-panel={collapsed ? undefined : "scheduled"}
				style={{ "--gui-side-w": `${PANE_W}px` } as CSSProperties}
			>
				{pane}
			</div>
			<div className="gui-chat-col flex min-w-0 flex-1 flex-col">
				<div className="gui-header flex h-12 flex-shrink-0 items-center px-4" />
				<div className="gui-chat-column flex-1" />
			</div>
		</div>
	</div>
);

const SELECTORS = { rail: ".gui-rail", firstButton: ".gui-rail-btn", btn: ".gui-rail-btn", pane: ".gui-pane-side" };

/** Paint facts the shared vocabulary does not collect, flattened onto the row. */
function withPaint(root: ParentNode) {
	const elements = measure(root, SELECTORS);
	const railNode = root.querySelector<HTMLElement>(".gui-rail");
	const paneNode = root.querySelector<HTMLElement>(".gui-pane-side");
	const railStyle = railNode ? getComputedStyle(railNode) : null;
	const paneStyle = paneNode ? getComputedStyle(paneNode) : null;
	const railRow = elements.rail as Record<string, unknown> | null;
	if (railRow) {
		railRow.background = railStyle?.backgroundColor;
		railRow.border = railStyle?.borderTopWidth;
		railRow.radius = railStyle?.borderTopLeftRadius;
	}
	const paneRow = elements.pane as Record<string, unknown> | null;
	if (paneRow) {
		paneRow.background = paneStyle?.backgroundColor;
		paneRow.radius = paneStyle?.borderTopLeftRadius;
	}
	return elements;
}

const scenarios = {
	"rail-beside-panel": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(column(false, <ScheduledTasksPanel width={PANE_W} collapsed={false} />), root);
		},
		async measure(body: ParentNode) {
			return { elements: withPaint(body) };
		},
		expect: {
			// The strip keeps its geometry and becomes a card: same radius ladder
			// as the pane, and a fill instead of transparent.
			rail: { "box.w": 52, radius: "16px" },
			firstButton: { "box.w": 36 },
			pane: { "box.w": PANE_W, radius: "16px" },
		},
	},
	"rail-beside-folded-panel": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(column(true, <ScheduledTasksPanel width={PANE_W} collapsed={true} />), root);
		},
		async measure(body: ParentNode) {
			return { elements: withPaint(body) };
		},
		expect: {
			// Folded, the rail is the whole left column; it must still be a card.
			rail: { "box.w": 52, radius: "16px" },
		},
	},
	/** The footer's controls must follow the wide rail's row geometry. Left as a
	 *  36px centred square inside a widened rail, the button reads as a different
	 *  control rather than the same one with room ("变一个居中图标"). */
	"wide-rail-footer": {
		capture: ".gui-rail",
		async render(root: HTMLElement) {
			await mount(column(false, <ScheduledTasksPanel width={PANE_W} collapsed={false} />, true), root);
		},
		async measure(body: ParentNode) {
			return {
				elements: measure(body, {
					group: ".gui-rail-group",
					btn: ".gui-rail-btn",
				}),
			};
		},
	},
	"wide-rail": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(column(false, <ScheduledTasksPanel width={PANE_W} collapsed={false} />, true), root);
		},
		async measure(body: ParentNode) {
			const elements = withPaint(body);
			const labels = Array.from(body.querySelectorAll<HTMLElement>(".gui-rail-label")).map(
				node => node.textContent ?? "",
			);
			const head = body.querySelector(".gui-rail-head");
			const brand = body.querySelector(".gui-rail-brand");
			return {
				elements,
				labels,
				labelCount: labels.length,
				headWidth: head ? Math.round(head.getBoundingClientRect().width) : null,
				brandExpanded: brand?.getAttribute("aria-expanded") ?? null,
				hasTopBand: body.querySelector(".gui-rail-top") !== null,
			};
		},
		expect: {
			// Tier one widens to its own token and renders one label per row; the
			// empty drag band is replaced by the brand header.
			rail: { "box.w": 208, radius: "16px" },
			btn: { "box.w": { min: 150 } },
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
