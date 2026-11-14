import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserDeviceToolbar, readBrowserDeviceToolbarVisibility } from "../src/components/browser-device-toolbar";

const HIDDEN_KEY = "musepi-gui-browser-device-toolbar";

describe("controlled browser device toolbar visibility", () => {
	it("omits the controls when its parent hides the toolbar", () => {
		const html = renderToStaticMarkup(
			<BrowserDeviceToolbar
				preset="tools.browserViewportFit"
				width={null}
				height={null}
				displayScale="fit"
				background="auto"
				visible={false}
				onPresetChange={() => {}}
				onSizeChange={() => {}}
				onDisplayScaleChange={() => {}}
				onBackgroundChange={() => {}}
			/>,
		);

		expect(html).toBe("");
		expect(html).not.toContain("gui-browser-toolbar-toggle");
	});

	it("reads the persisted collapse choice for the controlled parent", () => {
		window.localStorage.setItem(HIDDEN_KEY, "hidden");
		expect(readBrowserDeviceToolbarVisibility()).toBe(false);
		window.localStorage.removeItem(HIDDEN_KEY);
		expect(readBrowserDeviceToolbarVisibility()).toBe(true);
	});
});
