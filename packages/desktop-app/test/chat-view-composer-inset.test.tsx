import "./happy-dom-shim";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
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

function view(store: GuiSessionStore | null) {
	return (
		<ChatView
			store={store}
			rpc={rpc}
			onSend={() => {}}
			onStop={() => {}}
			onDecideApproval={() => {}}
			busy={false}
			project="C:/workspace"
			onProject={() => {}}
			onSubmitNewSession={() => {}}
			rightPanelOpen={false}
			terminalOpen={false}
			focusMode={false}
			onToggleFocus={() => {}}
		/>
	);
}

afterEach(() => vi.restoreAllMocks());

describe("ChatView composer inset publisher", () => {
	it("starts measuring when the welcome scene becomes a session", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			return this.classList.contains("gui-composer-wrap")
				? new DOMRect(0, 0, 800, 137)
				: new DOMRect(0, 0, 800, 400);
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(view(null)));
		const store = new GuiSessionStore("session-1", { entries: [], cursor: 0 }, "C:/workspace");
		await act(async () => root.render(view(store)));

		const spacer = host.querySelector<HTMLElement>(".gui-chat-tail-spacer");
		expect(spacer?.style.getPropertyValue("--chat-composer-inset")).toBe("137px");
		expect(spacer?.style.getPropertyValue("--chat-composer-tail-inset")).toBe("217px");

		await act(async () => root.unmount());
		host.remove();
		store.dispose();
	});
});
