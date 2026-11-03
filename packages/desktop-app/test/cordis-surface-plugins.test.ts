import { describe, expect, it } from "bun:test";
import { apply as applyBrowser } from "../src/plugins/browser-ui/index";
import { apply as applyPanel } from "../src/plugins/panel/index";

function registrations(
	apply: (api: { setLabel(label: string): void; registerComponent(component: unknown): void }) => void,
) {
	const components: Array<{ slot: string; moduleUrl: string }> = [];
	apply({
		setLabel: () => {},
		registerComponent: component => components.push(component as { slot: string; moduleUrl: string }),
	});
	return components;
}

describe("Cordis surface plugin boundaries", () => {
	it("registers panel, browser pane, and persistent browser host independently", () => {
		expect(registrations(applyPanel)).toEqual([{ slot: "panel.shell", moduleUrl: "./page.tsx", label: "右侧面板" }]);
		expect(registrations(applyBrowser)).toEqual([
			{ slot: "browser.host", moduleUrl: "./host.tsx", label: "浏览器宿主" },
			{ slot: "panel.tab.browser", moduleUrl: "./page.tsx", label: "浏览器", availability: "always" },
		]);
	});
});
