import type { CSSProperties, ReactNode } from "react";
import { AppRail } from "../../src/components/AppRail";
import { CapabilitySidePanel } from "../../src/components/CapabilitySidePanel";
import { ScheduledTasksPanel } from "../../src/components/ScheduledTasksPanel";
import { SidebarToggleButton } from "../../src/components/SidebarToggleButton";
import { publishCapabilityNav } from "../../src/lib/capability-nav";
import type { SidebarPanelId } from "../../src/lib/rail-peek";
import { publishTaskNav } from "../../src/lib/scheduled-task-nav";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, readElement, sleep } from "../gui-probe-helpers";
import { morphSurfaceClip, withViewTransition } from "../../src/lib/view-transition";

const PANE_W = 256;

type TransitionRecord = { entered: boolean; classes: string[]; finished: boolean };

function installStub(sink: TransitionRecord): void {
	const doc = document as unknown as {
		startViewTransition?: (update: () => void) => { finished: Promise<void> };
	};
	doc.startViewTransition = (update: () => void) => {
		sink.entered = true;
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

const shell = (collapsed: boolean, wide: boolean, peek = false, panelId: SidebarPanelId = "scheduled"): ReactNode => (
	<div className="gui-workspace-keeper" style={{ width: 1100, height: 640 }}>
		<div className="gui-main relative flex min-h-0 flex-1">
			{rail(wide)}
			<div
				className={`gui-side-keeper${collapsed ? " gui-side-keeper--peek" : ""}`}
				data-panel={collapsed ? (peek ? panelId : undefined) : panelId}
				data-docked-panel={panelId}
				data-peek={collapsed ? "true" : undefined}
				data-peek-open={collapsed && peek ? "true" : undefined}
				style={{ "--gui-side-w": `${PANE_W}px` } as CSSProperties}
			>
				<SidebarToggleButton
					collapsed={collapsed}
					panelId={panelId}
					onToggle={() => {}}
					sessions={[{ id: "demo", label: "Demo session" }]}
					onSelectSession={() => {}}
					onNewSession={() => {}}
				/>
				{panelId === "capability" ? (
					<CapabilitySidePanel width={PANE_W} collapsed={collapsed && !peek} />
				) : (
					<ScheduledTasksPanel width={PANE_W} collapsed={collapsed && !peek} />
				)}
			</div>
			<div className="gui-chat-col flex min-w-0 flex-1 flex-col">
				<div className="gui-header flex h-12 flex-shrink-0 items-center px-4" />
				<div className="gui-chat-column flex-1" />
			</div>
		</div>
	</div>
);

function panelMeasurements(body: ParentNode): Record<string, unknown> {
	return {
		elements: {
			toggle: readElement(body.querySelector(".gui-sidebar-toggle")),
			pane: readElement(body.querySelector(".gui-pane-side")),
		},
	};
}

const scenarios = {
	"rail-expand-transition": {
		capture: ".gui-main",
		async render(root: HTMLElement) {},
		async measure() {
			const sink: TransitionRecord = { entered: false, classes: [], finished: false };
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
	},
	"pane-folded": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell(true, false), root);
		},
		async measure(body: ParentNode) {
			return panelMeasurements(body);
		},
	},
	"pane-docked": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell(false, false), root);
		},
		async measure(body: ParentNode) {
			return panelMeasurements(body);
		},
	},
	"quick-scheduled-menu": {
		capture: "body",
		async render(root: HTMLElement) {
			publishTaskNav({
				tasks: [
					{ id: "nightly", name: "Nightly build", enabled: true, cwd: "/work/demo" },
					{ id: "report", name: "Weekly report", enabled: false, cwd: "/work/demo" },
				],
				selectedId: "nightly",
				view: "tasks",
				busy: false,
			});
			await mount(shell(true, false, false), root);
		},
		async measure(body: ParentNode) {
			body.querySelector(".gui-sidebar-toggle")?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
			await sleep(80);
			return {
				...panelMeasurements(body),
				quickMenu: readElement(body.querySelector(".gui-session-quick-menu")),
				quickRows: Array.from(body.querySelectorAll(".gui-session-quick-row")).map(row => row.textContent?.trim()),
			};
		},
	},
	"quick-capability-menu": {
		capture: "body",
		async render(root: HTMLElement) {
			publishCapabilityNav({ tab: "plugins", skillsCount: 4, pluginsCount: 2 });
			await mount(shell(true, false, false, "capability"), root);
		},
		async measure(body: ParentNode) {
			body.querySelector(".gui-sidebar-toggle")?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
			await sleep(80);
			return {
				...panelMeasurements(body),
				quickMenu: readElement(body.querySelector(".gui-session-quick-menu")),
				quickRows: Array.from(body.querySelectorAll(".gui-session-quick-row")).map(row => row.textContent?.trim()),
			};
		},
	},
	"panel-clip-midframe": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell(false, false), root);
		},
		async measure(body: ParentNode) {
			const keeper = body.querySelector<HTMLElement>(".gui-side-keeper")!;
			const pane = body.querySelector<HTMLElement>(".gui-pane-side")!;
			const anchor = body.querySelector<HTMLButtonElement>(".gui-sidebar-toggle")!;
			morphSurfaceClip(
				pane,
				anchor,
				"gui-sidebar-surface",
				() => {
					keeper.removeAttribute("data-panel");
					pane.classList.add("gui-pane-side--collapsed");
					pane.style.width = "0px";
					anchor.dataset.collapsed = "true";
				},
				{ direction: "to-anchor", surfaceOnly: true, extraClass: "gui-vt-left-col" },
			);
			await sleep(90);
			return {
				...panelMeasurements(body),
				clip: document.documentElement.style.getPropertyValue("--gui-vt-anchor-clip"),
				transitioning: document.documentElement.classList.contains("gui-vt-clip-to-anchor"),
			};
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
