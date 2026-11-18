import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionComponent } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ComposerProps } from "../src/components/Composer";
import type { RpcClient } from "../src/lib/rpc";
import { SlotComponentMount } from "../src/lib/slot-host";
import { apply } from "../src/plugins/chat-view/index";

const globals = globalThis as typeof globalThis & { __composerProps?: ComposerProps };

afterEach(() => {
	delete globals.__composerProps;
	document.body.innerHTML = "";
});

describe("composer seat owned by chat-view", () => {
	it("registers the page and its input card from the same plugin", () => {
		const components: ExtensionComponent[] = [];
		apply({
			setLabel() {},
			slots: {
				register(component: ExtensionComponent) {
					components.push(component);
				},
			},
		} as unknown as ExtensionAPI);
		expect(components).toEqual([
			expect.objectContaining({ slot: "main.conversation", moduleUrl: "./page.tsx" }),
			expect.objectContaining({ slot: "conversation.composer.bar", moduleUrl: "./composer.tsx" }),
		]);
	});

	it("hands the exact host-owned composer contract to the contribution", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const onSubmit = (): void => {};
		const composer = {
			mode: "hero",
			busy: false,
			rpc: {} as RpcClient,
			project: null,
			onSubmit,
		} as unknown as ComposerProps;
		const item = {
			slot: "conversation.composer.bar",
			extensionId: "/plugins/chat-view/index.ts",
			code: `export default function Page(props) {
				globalThis.__composerProps = props.composer;
				return null;
			}`,
		};
		await act(async () => {
			root.render(createElement(SlotComponentMount, { item, rpc: null, composer }));
		});
		await act(async () => Bun.sleep(20));
		expect(globals.__composerProps).toBe(composer);
		expect(globals.__composerProps?.mode).toBe("hero");
		await act(async () => root.unmount());
	});
});
