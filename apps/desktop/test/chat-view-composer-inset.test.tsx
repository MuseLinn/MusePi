import "./happy-dom-shim";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { invalidateGitStatus } from "../src/lib/git-status-cache";
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
			sessionInfoOpen
			onToggleSessionInfo={() => {}}
		/>
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	// The session info card this file mounts reads the working tree through the
	// process-wide git status cache; leaving an entry behind would answer the
	// next file's `git.status` tests from here.
	invalidateGitStatus();
	localStorage.clear();
});

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

		// The floating session-info card caps itself above that same composer.
		// The composer is absolute (no flow space), so without the cap a long
		// card runs to the column's bottom and is painted under the input.
		const toggle = host.querySelector<HTMLButtonElement>(".gui-chat-info-toggle")!;
		await act(async () => toggle.click());
		const card = host.querySelector<HTMLElement>(".gui-session-info--float");
		expect(card?.style.maxHeight).toBe("calc(100% - 44px - 137px - 12px)");

		await act(async () => root.unmount());
		host.remove();
		store.dispose();
	});
});
