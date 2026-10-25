import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkspacePageHeader } from "../src/components/WorkspacePageHeader";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
	if (root) act(() => root!.unmount());
	host?.remove();
	host = null;
	root = null;
});

describe("WorkspacePageHeader", () => {
	test("keeps back, title, description, tabs, and actions in one page skeleton", () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		let backs = 0;
		act(() => {
			root!.render(
				createElement(WorkspacePageHeader, {
					icon: "star",
					title: "能力中心",
					description: "技能、插件与市场",
					onBack: () => backs++,
					tabs: createElement("div", { className: "test-tabs" }, "技能"),
					actions: createElement("button", { className: "test-action" }, "新建"),
				}),
			);
		});
		expect(host.querySelectorAll("h1").length).toBe(1);
		expect(host.querySelector("h1")?.textContent).toBe("能力中心");
		expect(host.querySelector(".gui-workspace-header-description")?.textContent).toBe("技能、插件与市场");
		expect(host.querySelector(".gui-workspace-header-tabs .test-tabs")?.textContent).toBe("技能");
		host.querySelector<HTMLButtonElement>(".gui-workspace-header-back")?.click();
		expect(backs).toBe(1);
	});
});
