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
	invalidateGitStatus();
	localStorage.clear();
});

/**
 * The welcome and session scenes are two cards, but the composer is one host
 * node that lives under the scenes layer (Checkpoint: `apps/desktop/src/lib/`
 * has no second composer wrapper). These assertions are the contract the
 * pending Composer + variant merge must preserve: a scene flip may move the
 * node, never remount it.
 */
describe("ChatView composer host", () => {
	it("keeps the host and the composer wrap mounted across a scene flip", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);

		await act(async () => root.render(view(null)));
		const composerHost = host.querySelector<HTMLElement>(".gui-composer-host");
		const wrapBefore = host.querySelector<HTMLElement>(".gui-composer-wrap");
		expect(composerHost).not.toBeNull();
		expect(wrapBefore).not.toBeNull();
		expect(host.querySelectorAll(".gui-composer-host")).toHaveLength(1);

		const store = new GuiSessionStore("session-1", { entries: [], cursor: 0 }, "C:/workspace");
		await act(async () => root.render(view(store)));

		const composerHostAfter = host.querySelector<HTMLElement>(".gui-composer-host");
		const wrapAfter = host.querySelector<HTMLElement>(".gui-composer-wrap");
		// Same DOM nodes, not replacements: the flight is a transform on the node
		// the browser already has, and a remount here would restart the editor.
		expect(composerHostAfter).toBe(composerHost);
		expect(wrapAfter).toBe(wrapBefore);
		expect(host.querySelectorAll(".gui-composer-host")).toHaveLength(1);
		expect(host.querySelectorAll(".gui-composer-wrap")).toHaveLength(1);
		expect(composerHostAfter?.getAttribute("data-mode")).toBe("session");
		expect(wrapAfter?.className).toContain("gui-composer-wrap--floating");

		await act(async () => root.unmount());
		host.remove();
		store.dispose();
	});
});