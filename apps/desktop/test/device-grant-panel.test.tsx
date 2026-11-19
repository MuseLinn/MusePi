import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { t } from "@musepi/client-core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DeviceGrantPanel } from "../src/components/settings-sections/device-grant-panel";
import type { RpcClient } from "../src/lib/rpc";

const roots: Root[] = [];

function mount(node: ReactNode): Root {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return root;
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
	document.documentElement.classList.remove("gui-view-transition");
});

describe("DeviceGrantPanel", () => {
	test("autoStart paints the pending skeleton immediately, then swaps the code in place", async () => {
		const calls: string[] = [];
		let release: (value: unknown) => void = () => {};
		const started = new Promise(resolve => {
			release = resolve;
		});
		const rpc = {
			request: (method: string) => {
				calls.push(method);
				if (method === "mcp.oauth.device.start") return started;
				return Promise.resolve({ status: "pending" });
			},
		} as unknown as RpcClient;

		mount(
			<DeviceGrantPanel
				rpc={rpc}
				serverName="connector:github"
				open
				autoStart
				onClose={() => {}}
				onDone={() => {}}
			/>,
		);

		// First frame: the same rows the code will occupy — the dialog must not
		// grow later (that growth was the shared-surface flash).
		const openButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
			button => button.textContent === t("settings.mcpDeviceOpen"),
		);
		expect(document.body.textContent).toContain(t("settings.mcpDeviceStarting"));
		expect(openButton?.disabled).toBe(true);
		expect(calls).toContain("mcp.oauth.device.start");

		await act(async () => {
			release({
				flowId: "flow-2",
				userCode: "WXYZ-9876",
				verificationUri: "https://example.test/device",
				interval: 3600,
			});
			await Bun.sleep(10);
		});
		expect(document.body.textContent).toContain(t("settings.mcpDeviceCodeLabel"));
		expect(document.body.textContent).toContain("WXYZ-9876");
		expect(document.body.textContent).not.toContain(t("settings.mcpDeviceStarting"));
	});
});
