import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionComponent } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ChatViewProps } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";
import { SlotComponentMount } from "../src/lib/slot-host";
import { apply } from "../src/plugins/chat-view/index";

const globals = globalThis as typeof globalThis & { __chatViewProps?: ChatViewProps };

afterEach(() => {
	delete globals.__chatViewProps;
	document.body.innerHTML = "";
});

describe("chat-view Cordis plugin", () => {
	it("registers the welcome and session surface in one single slot", () => {
		const components: ExtensionComponent[] = [];
		apply({
			setLabel() {},
			slots: {
				register(component: ExtensionComponent) {
					components.push(component);
				},
			},
		} as unknown as ExtensionAPI);
		expect(components).toEqual([expect.objectContaining({ slot: "app.chat", moduleUrl: "./page.tsx" })]);
	});

	it("passes the exact host-owned chat contract through the real slot mount", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const onToggleFocus = (): void => {};
		const chatView = {
			store: null,
			rpc: {} as RpcClient,
			busy: false,
			project: null,
			onProject() {},
			onSubmitNewSession() {},
			onSend() {},
			onStop() {},
			onDecideApproval() {},
			rightPanelOpen: false,
			terminalOpen: false,
			focusMode: false,
			onToggleFocus,
		} satisfies ChatViewProps;
		const item = {
			slot: "app.chat",
			extensionId: "/plugins/chat-view/index.ts",
			code: `export default function Page(props) {
				globalThis.__chatViewProps = props.chatView;
				return null;
			}`,
		};
		await act(async () => {
			root.render(createElement(SlotComponentMount, { item, rpc: null, chatView }));
		});
		await act(async () => Bun.sleep(20));
		expect(globals.__chatViewProps).toBe(chatView);
		expect(globals.__chatViewProps?.onToggleFocus).toBe(onToggleFocus);
		await act(async () => root.unmount());
	});
});
