import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";

/**
 * Mini window (?mini=1) is a chat-only surface: the right rail and the panel
 * shell are workspace chrome, so neither mounts there. The welcome scene and
 * the transcript/composer still do.
 */

const rpc = {
	request: async (method: string) => {
		if (method.startsWith("models.list")) return [];
		if (method === "git.branches") return { error: "not a repository" };
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

const originalLocale = getLocaleSnapshot();

afterEach(() => {
	document.body.innerHTML = "";
	localStorage.clear();
	setLocale(originalLocale);
	vi.restoreAllMocks();
});

async function renderChatView(mini: boolean): Promise<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> {
	setLocale("en-US");
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<ChatView
				store={null}
				rpc={rpc}
				mini={mini}
				onSend={() => {}}
				onStop={() => {}}
				onDecideApproval={() => {}}
				busy={false}
				project="C:/workspace"
				onProject={() => {}}
				onSubmitNewSession={() => {}}
				rightPanelOpen
				terminalOpen={false}
				focusMode={false}
				onToggleFocus={() => {}}
				sessionInfoOpen={false}
				onToggleSessionInfo={() => {}}
			/>,
		);
	});
	return { host, root };
}

describe("ChatView mini window", () => {
	it("renders the welcome surface without the rail or the panel shell", async () => {
		const { host, root } = await renderChatView(true);
		expect(host.querySelector(".gui-welcome")).not.toBeNull();
		expect(host.querySelector(".gui-chat-surface")).not.toBeNull();
		expect(host.querySelector(".gui-right-rail")).toBeNull();
		expect(host.querySelector(".gui-pane-right")).toBeNull();
		await act(async () => root.unmount());
		host.remove();
	});

	it("keeps the rail for the workspace surface", async () => {
		const { host, root } = await renderChatView(false);
		const rail = host.querySelector(".gui-right-rail");
		const scenes = host.querySelector(".gui-scenes");
		expect(rail).not.toBeNull();
		expect(rail?.parentElement).toBe(scenes?.parentElement);
		await act(async () => root.unmount());
		host.remove();
	});
});
