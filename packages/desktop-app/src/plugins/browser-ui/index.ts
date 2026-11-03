/** Cordis-owned managed browser pane and persistent guest host. */
interface ManagedBrowserPluginApi {
	setLabel(label: string): void;
	registerComponent(component: { slot: string; moduleUrl: string; label: string; availability?: "always" }): void;
}

export const name = "musepi-browser-ui";
export const inject = [] as const;
export const provide = [] as const;

export function apply(pi: ManagedBrowserPluginApi): void {
	pi.setLabel("MusePi 内置浏览器");
	pi.registerComponent({ slot: "browser.host", moduleUrl: "./host.tsx", label: "浏览器宿主" });
	pi.registerComponent({
		slot: "panel.tab.browser",
		moduleUrl: "./page.tsx",
		label: "浏览器",
		availability: "always",
	});
}

export default apply;
