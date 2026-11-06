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

function view(store: GuiSessionStore, sessionInfoOpen: boolean) {
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
			sessionInfoOpen={sessionInfoOpen}
			onToggleSessionInfo={() => {}}
		/>
	);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => vi.restoreAllMocks());

describe("ChatView 会话卡窄行座位", () => {
	it("窄行不自动浮出信息卡，点按钮才打开，再点收起", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			return new DOMRect(0, 0, 600, 700);
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const store = new GuiSessionStore("session-1", { entries: [], cursor: 0 }, "C:/workspace");

		await act(async () => root.render(view(store, true)));
		const toggle = host.querySelector<HTMLButtonElement>(".gui-chat-info-toggle");
		// Preference says open, but the narrow row cannot dock: floating it over
		// the transcript automatically is the reported occlusion bug.
		expect(host.querySelectorAll(".gui-session-info--float").length).toBe(0);
		expect(toggle?.getAttribute("aria-pressed")).toBe("false");

		await act(async () => toggle?.click());
		expect(host.querySelectorAll(".gui-session-info--float").length).toBe(1);
		expect(toggle?.getAttribute("aria-pressed")).toBe("true");

		await act(async () => toggle?.click());
		// The card plays its exit animation before unmounting.
		await act(async () => {
			await sleep(240);
		});
		expect(host.querySelectorAll(".gui-session-info--float").length).toBe(0);
		expect(toggle?.getAttribute("aria-pressed")).toBe("false");

		await act(async () => root.unmount());
		host.remove();
		store.dispose();
	});
});

describe("ChatView 会话卡顶部行与停靠座", () => {
	it("对话/地图与信息卡开关在 transcript 之外的布局行里", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			return new DOMRect(0, 0, 1200, 700);
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const store = new GuiSessionStore("session-1", { entries: [], cursor: 0 }, "C:/workspace");

		await act(async () => root.render(view(store, true)));

		const head = host.querySelector<HTMLElement>(".gui-chat-head");
		expect(head).not.toBeNull();
		// The switch and the toggle share the header row, and the row is NOT part
		// of the scroller — as an overlay it covered the first row's corner.
		expect(head?.querySelector(".gui-surface-mode")).not.toBeNull();
		expect(head?.querySelector(".gui-chat-info-toggle")).not.toBeNull();
		expect(host.querySelector(".gui-transcript .gui-chat-head")).toBeNull();
		expect(head?.nextElementSibling?.classList.contains("gui-chat-body")).toBe(true);

		await act(async () => root.unmount());
		host.remove();
		store.dispose();
	});

	it("关闭信息卡时停靠座留在行内折叠，卡片走出场窗口后才卸载", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			return new DOMRect(0, 0, 1200, 700);
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const store = new GuiSessionStore("session-1", { entries: [], cursor: 0 }, "C:/workspace");

		await act(async () => root.render(view(store, true)));
		const seat = host.querySelector<HTMLElement>(".gui-session-info-seat");
		expect(seat).not.toBeNull();
		expect(seat?.classList.contains("gui-session-info-seat--closed")).toBe(false);
		expect(seat?.querySelector(".gui-session-info--dock")).not.toBeNull();

		await act(async () => root.render(view(store, false)));
		// Same seat node, folded: unmounting it here re-laid the flex row out in
		// one frame and snapped the transcript 288px wider.
		expect(seat?.isConnected).toBe(true);
		expect(seat?.classList.contains("gui-session-info-seat--closed")).toBe(true);
		expect(seat?.getAttribute("inert")).not.toBeNull();
		// The card stays through the exit animation, then unmounts.
		expect(seat?.querySelector(".gui-session-info")).not.toBeNull();
		await act(async () => {
			await sleep(240);
		});
		expect(seat?.isConnected).toBe(true);
		expect(seat?.querySelector(".gui-session-info")).toBeNull();

		await act(async () => root.unmount());
		host.remove();
		store.dispose();
	});
});
