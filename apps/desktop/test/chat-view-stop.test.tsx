/**
 * Stop must reach the host without a confirmation dialog.
 *
 * The click interrupts immediately, matching bare Escape. The old confirm
 * also depended on the host React context, which a compiled chat-view plugin
 * does not share: its bundled `useConfirm` fell back to the silent `false`
 * default, so the button did nothing at all. Mounting without `PromptProvider`
 * pins that contract.
 */
import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

const rpc = {
	request: async (method: string) => {
		if (method.startsWith("models.list")) return [];
		if (method === "git.branches") return { error: "not a repository" };
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

const mounted: Root[] = [];

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.length = 0;
	document.body.innerHTML = "";
});

describe("composer stop", () => {
	it("aborts the running turn on the click without a confirm dialog", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		mounted.push(root);
		const store = new GuiSessionStore("session-1", { entries: [], cursor: 0, state: { isStreaming: true } }, "/w");
		let stops = 0;
		await act(async () =>
			root.render(
				<ChatView
					store={store}
					rpc={rpc}
					onSend={() => {}}
					onStop={() => {
						stops += 1;
					}}
					onDecideApproval={() => {}}
					busy={false}
					project="/w"
					onProject={() => {}}
					onSubmitNewSession={() => {}}
					rightPanelOpen={false}
					terminalOpen={false}
					focusMode={false}
					onToggleFocus={() => {}}
				/>,
			),
		);
		await act(async () => Bun.sleep(60));
		const stop = host.querySelector<HTMLButtonElement>(".gui-composer-send--working");
		expect(stop).not.toBeNull();

		await act(async () => stop!.click());
		await act(async () => Bun.sleep(20));

		expect(stops).toBe(1);
		expect(document.querySelector(".gui-dialog--confirm")).toBeNull();
		store.dispose();
	});
});
