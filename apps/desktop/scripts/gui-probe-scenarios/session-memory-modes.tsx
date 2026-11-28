import type { CSSProperties, ReactNode } from "react";
import { SessionSidebar } from "../../src/components/SessionSidebar";
import { SidebarToggleButton } from "../../src/components/SidebarToggleButton";
import { HeroComposer } from "../../src/components/HeroComposer";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, readElement, sleep } from "../gui-probe-helpers";

const shell = (): ReactNode => (
	<div className="gui-main relative flex min-h-0 flex-1" style={{ width: 1100, height: 700, "--gui-side-w": "300px" } as CSSProperties}>
		<div className="gui-rail"><div className="gui-rail-top" /></div>
		<div className="gui-side-keeper" data-panel="home">
			<SidebarToggleButton collapsed={false} panelId="home" onToggle={() => {}} sessions={[]} onSelectSession={() => {}} onNewSession={() => {}} />
			<SessionSidebar
				nodes={[]}
				sessionMeta={new Map()}
				selectedId={null}
				onSelect={() => {}}
				onNewSession={() => {}}
				onDisconnect={() => {}}
				onOpenConnect={() => {}}
				onOpenWorkspace={() => {}}
				onOpenSettings={() => {}}
				onOpenInstanceManager={() => {}}
				onOpenRemoteDisclaimer={() => {}}
				onOpenSearch={() => {}}
				collapsed={false}
				width={300}
				onDeleteArchived={async () => true}
				onImportSessions={() => {}}
				connected
				daemonUrl="ws://127.0.0.1"
				onReconnect={() => {}}
				hosts={[]}
				onSwitchHost={() => {}}
				onAddTarget={() => {}}
				onRemoveHost={() => {}}
				showFooter={false}
			/>
		</div>
		<div className="gui-chat-column flex-1" />
	</div>
);

function measurements(body: ParentNode): Record<string, unknown> {
	return {
		elements: {
			toggle: readElement(body.querySelector(".gui-sidebar-toggle")),
			header: readElement(body.querySelector(".gui-sidebar-header")),
			newButton: readElement(body.querySelector(".gui-sidebar-new")),
			newMenu: readElement(body.querySelector(".gui-sidebar-new-menu")),
			memoryMenu: readElement(body.querySelector(".gui-memory-mode-menu")),
		},
		newMenuItems: body.querySelectorAll(".gui-sidebar-new-menu button").length,
		memoryOptions: body.querySelectorAll(".gui-memory-mode-option").length,
	};
}

const scenarios = {
	"sidebar-leading-header": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell(), root);
		},
		async measure(body: ParentNode) {
			return measurements(body);
		},
	},
	"new-session-memory-menu": {
		capture: ".gui-main",
		async render(root: HTMLElement) {
			await mount(shell(), root);
		},
		async measure(body: ParentNode) {
			body.querySelector<HTMLButtonElement>(".gui-sidebar-new-more")?.click();
			await sleep(100);
			return measurements(body);
		},
	},
	"welcome-memory-mode-menu": {
		capture: ".gui-welcome-inner",
		async render(root: HTMLElement) {
			const rpc = {
				request: async (method: string) => {
					if (method === "connectors.list") return { servers: [{ name: "workspace" }], selected: null };
					if (method === "git.branches") return { current: "main", branches: ["main"] };
					return null;
				},
				addEventListener: () => () => {},
			};
			await mount(
				<HeroComposer
					onSubmit={() => {}}
					rpc={rpc as never}
					project="/workspace"
					onProject={() => {}}
					modes={[{ id: "work", label: "Work" }]}
					memoryMode="persistent"
					onMemoryModeChange={() => {}}
				/>,
				root,
			);
		},
		async measure(body: ParentNode) {
			const elements = {
				row: readElement(body.querySelector(".gui-project-row")),
				memory: readElement(body.querySelector(".gui-memory-chip")),
				connector: readElement(body.querySelector(".gui-connector-chip")),
				project: readElement(body.querySelector(".gui-project-chip")),
				frame: readElement(body.querySelector(".gui-composer-frame")),
				beam: readElement(body.querySelector(".gui-border-beam")),
			};
			const chips = [
				...Array.from(body.querySelectorAll(".gui-project-chip")),
				body.querySelector(".gui-memory-chip"),
				body.querySelector(".gui-connector-chip"),
			].filter((chip): chip is Element => chip !== null);
			const chipReadings = chips.map(chip => readElement(chip));
			const row = {
				...elements.row,
				direction: getComputedStyle(body.querySelector(".gui-project-row")!).flexDirection,
				sameRow: chipReadings.every(chip => chip?.box.top === chipReadings[0]?.box.top),
				leftAligned: ["normal", "flex-start"].includes(getComputedStyle(body.querySelector(".gui-project-row")!).justifyContent),
				sharedMaterial: new Set(chipReadings.map(chip => chip?.background)).size === 1,
				liquidChipCount: chips.filter(chip => chip.classList.contains("gui-liquid-glass")).length,
			};
			const frame = body.querySelector(".gui-composer-frame")!;
			const beam = body.querySelector(".gui-border-beam")!;
			const glow = body.querySelector(".gui-spotlight-glow")!;
			return {
				elements: {
					...elements,
					row,
					layers: {
						text: "",
						box: { w: 0, h: 0, top: 0, left: 0 },
						frameTint: getComputedStyle(frame).backgroundColor,
						frameWarp: getComputedStyle(frame, "::before").backdropFilter,
						frameEdge: getComputedStyle(frame, "::after").backgroundImage,
						beamEdge: getComputedStyle(beam, "::after").backgroundImage,
						spotlight: getComputedStyle(glow).backgroundImage,
						spotlightOpacity: getComputedStyle(glow).opacity,
					},
				},
			};
		},
		expect: {
			row: {
				display: "flex",
				direction: "row",
				sameRow: true,
				leftAligned: true,
				sharedMaterial: true,
				liquidChipCount: 5,
			},
			layers: { spotlightOpacity: "0" },
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
