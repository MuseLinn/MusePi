/** Cordis-owned right-panel shell; tabs and browser pages stay independent. */
interface RightPanelPluginApi {
	setLabel(label: string): void;
	registerComponent(component: { slot: "panel.shell"; moduleUrl: "./page.tsx"; label: string }): void;
}

export const name = "musepi-panel";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: RightPanelPluginApi): void {
	pi.setLabel("MusePi 右侧面板");
	pi.registerComponent({ slot: "panel.shell", moduleUrl: "./page.tsx", label: "右侧面板" });
}

export default apply;
