import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { invalidateGitStatus } from "../src/lib/git-status-cache";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

const entries = [
	{
		type: "thinking_level_change",
		id: "thinking-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		thinkingLevel: "high",
		configured: null,
	},
	{
		type: "message",
		id: "user-1",
		parentId: "thinking-1",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", timestamp: 1, content: "hello" },
	},
] as unknown as SessionEntry[];

function view(store: GuiSessionStore, rpc: RpcClient) {
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
			sessionInfoOpen={false}
			onToggleSessionInfo={() => {}}
		/>
	);
}

afterEach(() => {
	invalidateGitStatus();
	localStorage.clear();
});

describe("ChatView thinking chip before the ladder resolves", () => {
	it("renders instead of crashing while session.thinkingInfo is still pending", async () => {
		// Regression: the model-switch clamp read `thinkingEfforts.length` on the
		// null initial state and the app error boundary covered the whole window
		// ("界面渲染出错，重新连接即可恢复"). A session that already carries a
		// thinking_level_change renders the chip before the RPC answers.
		const rpc = {
			request: async (method: string) => {
				if (method === "session.thinkingInfo") return new Promise(() => {});
				if (method.startsWith("models.list")) return [];
				if (method === "git.branches") return { error: "not a repository" };
				return {};
			},
			addEventListener: () => () => {},
		} as unknown as RpcClient;
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);

		await act(async () => root.render(view(store, rpc)));

		expect(host.querySelector(".gui-chat-body")).not.toBeNull();
		expect(host.querySelector(".gui-model-capsule-seg-text--thinking")?.textContent).not.toBe("");

		await act(async () => root.unmount());
		host.remove();
		store.dispose();
	});
});
