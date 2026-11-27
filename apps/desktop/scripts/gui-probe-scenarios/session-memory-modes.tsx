import type { CSSProperties, ReactNode } from "react";
import { SessionSidebar } from "../../src/components/SessionSidebar";
import { SidebarToggleButton } from "../../src/components/SidebarToggleButton";
import { MemoryModeChip } from "../../src/components/MemoryModePicker";
import type { GuiScenario } from "../gui-probe-helpers";
import { mount, readElement, sleep } from "../gui-probe-helpers";

const shell = (): ReactNode => (
	<div className="gui-main relative flex min-h-0 flex-1" style={{ width: 1100, height: 700, "--gui-side-w": "300px" } as CSSProperties}>
		<div className="gui-rail"><div className="gui-rail-top" /></div>
		<div className="gui-side-keeper" data-panel="home">
			<SidebarToggleButton collapsed={false} onToggle={() => {}} sessions={[]} onSelectSession={() => {}} onNewSession={() => {}} />
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
		capture: "body",
		async render(root: HTMLElement) {
			await mount(
				<div style={{ width: 720, padding: 24 }}>
					<div className="gui-memory-chip-row"><MemoryModeChip value="persistent" onChange={() => {}} /></div>
					<div className="gui-welcome-input" style={{ height: 100 }} />
				</div>,
				root,
			);
		},
		async measure(body: ParentNode) {
			body.querySelector<HTMLButtonElement>(".gui-memory-chip")?.click();
			await sleep(100);
			return measurements(body);
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
