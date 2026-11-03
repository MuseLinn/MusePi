import { describe, expect, it } from "bun:test";
import { selectPanelTabComponent } from "../src/lib/slot-host";

const components = [
	{ slot: "panel.tab.browser", extensionId: "browser-ui", code: "" },
	{ slot: "panel.tab.files", extensionId: "file-workspace", code: "" },
	{ slot: "panel.tab.example", extensionId: "example", code: "" },
];

describe("panel tab component selector", () => {
	it("resolves built-in aliases and extension surface ids", () => {
		expect(selectPanelTabComponent(components, "browser")?.extensionId).toBe("browser-ui");
		expect(selectPanelTabComponent(components, "files")?.extensionId).toBe("file-workspace");
		expect(selectPanelTabComponent(components, "ext:panel.tab.example")?.extensionId).toBe("example");
	});
});
