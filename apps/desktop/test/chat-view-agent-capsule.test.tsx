import "./happy-dom-shim";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

/**
 * One agent identity per conversation.
 *
 * The per-row orb / user chip are gone: the agent orb lives in the centered
 * capsule above the transcript, and every row receives an EMPTY gutter so the
 * body reclaims that column (geometry is pinned by
 * agent-capsule-geometry.test.ts — happy-dom lays nothing out).
 *
 * These assertions are structural: one capsule inside the chat head, correct
 * status projection, and no avatar (and no reserved gutter content) anywhere
 * in the transcript rows.
 */

const rpc = {
	request: async (method: string) => {
		if (method.startsWith("models.list")) return [];
		if (method === "git.branches") return { error: "not a repository" };
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

const entries = [
	{
		type: "message",
		id: "user-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", timestamp: 1, content: "explain the diff" },
	},
	{
		type: "message",
		id: "assistant-1",
		parentId: "user-1",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "The diff adds one guard." }],
		},
	},
] as unknown as SessionEntry[];

function view(store: GuiSessionStore, focusMode = false) {
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
			focusMode={focusMode}
			onToggleFocus={() => {}}
			sessionInfoOpen
			onToggleSessionInfo={() => {}}
		/>
	);
}

async function mount(
	store: GuiSessionStore,
	focusMode = false,
): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(view(store, focusMode)));
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
			store.dispose();
		},
	};
}

beforeEach(() => {
	setLocale("zh-CN");
	// The orb itself is a canvas animation; keep it out of this structural test
	// so the assertion is about the capsule, not the renderer.
	localStorage.setItem("musepi-gui-avatars", "0");
});

afterEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
});

afterAll(() => {
	setLocale("en-US");
});

describe("agent identity capsule", () => {
	it("renders exactly one capsule inside the chat head", async () => {
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store);
		const heads = host.querySelectorAll(".gui-chat-head");
		expect(heads.length).toBe(1);
		expect(heads[0]?.querySelectorAll(".gui-agent-capsule").length).toBe(1);
		// The capsule is chrome, never a second transcript row.
		expect(host.querySelector(".gui-transcript .gui-agent-capsule")).toBeNull();
		await unmount();
	});

	it("carries the assistant identity and the idle state at rest", async () => {
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store);
		const capsule = host.querySelector<HTMLElement>(".gui-agent-capsule");
		expect(capsule?.dataset.agentStatus).toBe("idle");
		expect(capsule?.querySelector(".gui-agent-capsule-name")?.textContent).toBe("助手");
		expect(capsule?.querySelector(".gui-agent-capsule-status")?.textContent).toBe("空闲");
		await unmount();
	});

	it("projects a pending approval as the waiting state", async () => {
		const pendingApprovals = [{ requestId: "approval-1", tool: "bash", prompt: "Run the test suite?" }];
		const store = new GuiSessionStore("session-1", { entries, cursor: 0, pendingApprovals }, "C:/workspace");
		const { host, unmount } = await mount(store);
		const capsule = host.querySelector<HTMLElement>(".gui-agent-capsule");
		expect(capsule?.dataset.agentStatus).toBe("waiting");
		expect(capsule?.querySelector(".gui-agent-capsule-status")?.textContent).toBe("等待批准");
		await unmount();
	});

	it("leaves the head row in focus mode, which hides the capsule with it", async () => {
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store, true);
		const head = host.querySelector<HTMLElement>(".gui-chat-head");
		expect(head?.classList.contains("gui-chat-head--focused-hidden")).toBe(true);
		// Still the one capsule — it must not float over the full-screen composer.
		expect(head?.querySelectorAll(".gui-agent-capsule").length).toBe(1);
		await unmount();
	});

	it("leaves no avatar and no gutter content in the transcript rows", async () => {
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store);
		const transcript = host.querySelector(".gui-transcript");
		expect(transcript).not.toBeNull();
		expect(transcript?.querySelectorAll(".gui-user-avatar").length).toBe(0);
		expect(transcript?.querySelectorAll(".gui-agent-avatar-cycle").length).toBe(0);
		for (const gutter of transcript?.querySelectorAll(".tr-gutter") ?? []) {
			expect(gutter.textContent?.trim()).toBe("");
		}
		await unmount();
	});
});
