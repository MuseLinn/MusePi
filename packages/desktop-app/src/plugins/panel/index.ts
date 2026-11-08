/** Cordis-owned right-panel shell; tabs and browser pages stay independent. */
interface RightPanelPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-panel";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: RightPanelPluginApi): void {
	ctx.setLabel("MusePi 右侧面板");
	ctx.slots.register({ slot: "panel.shell", moduleUrl: "./page.tsx", label: "右侧面板" });
}
