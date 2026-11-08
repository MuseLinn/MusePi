/** Cordis-owned managed browser pane and persistent guest host. */
interface ManagedBrowserPluginApi {
	readonly slots: {
		register(component: { slot: string; moduleUrl: string; label: string; availability?: string }): void;
	};
	setLabel(label: string): void;
}

export const name = "musepi-browser-ui";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ManagedBrowserPluginApi): void {
	ctx.setLabel("MusePi 内置浏览器");
	ctx.slots.register({ slot: "browser.host", moduleUrl: "./host.tsx", label: "浏览器宿主" });
	ctx.slots.register({
		slot: "panel.tab.browser",
		moduleUrl: "./page.tsx",
		label: "浏览器",
		availability: "always",
	});
}
