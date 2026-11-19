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
	test("renders a primed device code on the first frame without starting a second flow", () => {
		const calls: string[] = [];
		const rpc = {
			request: (method: string) => {
				calls.push(method);
				return Promise.resolve({ status: "pending" });
			},
		} as unknown as RpcClient;

		mount(
			<DeviceGrantPanel
				rpc={rpc}
				serverName="connector:github"
				open
				autoStart
				initialFlow={{
					flowId: "flow-1",
					userCode: "ABCD-1234",
					verificationUri: "https://example.test/device",
					interval: 3600,
				}}
				onClose={() => {}}
				onDone={() => {}}
			/>,
		);

		// The one-take opens on the final layout: the code is already there and
		// the panel did not ask the daemon for another one.
		expect(document.body.textContent).toContain(t("settings.mcpDeviceCode", { code: "ABCD-1234" }));
		expect(calls).not.toContain("mcp.oauth.device.start");
	});

	test("without a primed flow the panel starts one and shows the pending label", async () => {
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

		await act(async () => Bun.sleep(10));
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
		expect(document.body.textContent).toContain(t("settings.mcpDeviceCode", { code: "WXYZ-9876" }));
	});
});
