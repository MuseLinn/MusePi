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
 * status projection, the role read from the session's `session.list` row, and
 * no avatar (and no reserved gutter content) anywhere in the transcript rows.
 */

interface FakeRpcOptions {
	/** One `agentRole` payload returned by `session.list`, or a failure. */
	role?: { id: string; name?: string } | "fail";
}

function makeRpc(options: FakeRpcOptions = {}): { rpc: RpcClient; calls: string[] } {
	const calls: string[] = [];
	const rpc = {
		request: async (method: string) => {
			calls.push(method);
			if (method.startsWith("models.list")) return [];
			if (method === "git.branches") return { error: "not a repository" };
			if (method === "session.list") {
				if (options.role === "fail") throw new Error("daemon unreachable");
				return [{ id: "session-1", agentRole: options.role ?? { id: "coder" } }];
			}
			return {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
	return { rpc, calls };
}

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

function view(
	store: GuiSessionStore,
	rpc: RpcClient,
	{ focusMode = false, readOnly = false }: { focusMode?: boolean; readOnly?: boolean } = {},
) {
	return (
		<ChatView
			store={store}
			rpc={rpc}
			readOnly={readOnly}
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
	rpc: RpcClient,
	options: { focusMode?: boolean; readOnly?: boolean } = {},
): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(view(store, rpc, options)));
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
		const { rpc } = makeRpc();
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store, rpc);
		const heads = host.querySelectorAll(".gui-chat-head");
		expect(heads.length).toBe(1);
		expect(heads[0]?.querySelectorAll(".gui-agent-capsule").length).toBe(1);
		// The capsule is chrome, never a second transcript row.
		expect(host.querySelector(".gui-transcript .gui-agent-capsule")).toBeNull();
		await unmount();
	});

	it("projects the session agent's role and the idle state at rest", async () => {
		const { rpc, calls } = makeRpc();
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store, rpc);
		const capsule = host.querySelector<HTMLElement>(".gui-agent-capsule");
		expect(capsule?.dataset.agentStatus).toBe("idle");
		expect(capsule?.dataset.agentRole).toBe("coder");
		expect(capsule?.querySelector(".gui-agent-capsule-name")?.textContent).toBe("助手");
		// The lane rides as a compact tag beside the name, never replacing the
		// live state.
		expect(capsule?.querySelector(".gui-agent-role-tag")?.textContent).toBe("编码");
		expect(capsule?.querySelector(".gui-agent-capsule-status")?.textContent).toBe("空闲");
		// One row read, scoped to this session.
		expect(calls.filter(method => method === "session.list")).toHaveLength(1);
		await unmount();
	});

	it("falls back to the coder lane when the session row cannot be read", async () => {
		const { rpc } = makeRpc({ role: "fail" });
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store, rpc);
		const capsule = host.querySelector<HTMLElement>(".gui-agent-capsule");
		expect(capsule?.dataset.agentRole).toBe("coder");
		expect(capsule?.querySelector(".gui-agent-capsule-name")?.textContent).toBe("助手");
		expect(capsule?.querySelector(".gui-agent-role-tag")?.textContent).toBe("编码");
		await unmount();
	});

	it("shows a subagent's own definition name, never the session's coder role", async () => {
		const { rpc } = makeRpc({ role: { id: "subagent", name: "sonic" } });
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store, rpc);
		const capsule = host.querySelector<HTMLElement>(".gui-agent-capsule");
		expect(capsule?.dataset.agentRole).toBe("subagent");
		expect(capsule?.querySelector(".gui-agent-capsule-name")?.textContent).toBe("sonic");
		expect(capsule?.querySelector(".gui-agent-role-tag")?.textContent).toBe("子代理");
		await unmount();
	});

	it("starts an advisor transcript as the advisor before the row lands", async () => {
		// The app already knows a read-only transcript is an advisor; the capsule
		// must not flash the workbench's coder while the row read is in flight.
		const { rpc } = makeRpc({ role: "fail" });
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store, rpc, { readOnly: true });
		const capsule = host.querySelector<HTMLElement>(".gui-agent-capsule");
		expect(capsule?.dataset.agentRole).toBe("advisor");
		expect(capsule?.querySelector(".gui-agent-capsule-name")?.textContent).toBe("顾问");
		// The lane tag would repeat the name, so it is not rendered.
		expect(capsule?.querySelector(".gui-agent-role-tag")).toBeNull();
		await unmount();
	});

	it("projects a pending approval as the waiting state", async () => {
		const { rpc } = makeRpc();
		const pendingApprovals = [{ requestId: "approval-1", tool: "bash", prompt: "Run the test suite?" }];
		const store = new GuiSessionStore("session-1", { entries, cursor: 0, pendingApprovals }, "C:/workspace");
		const { host, unmount } = await mount(store, rpc);
		const capsule = host.querySelector<HTMLElement>(".gui-agent-capsule");
		expect(capsule?.dataset.agentStatus).toBe("waiting");
		expect(capsule?.querySelector(".gui-agent-capsule-status")?.textContent).toBe("等待批准");
		await unmount();
	});

	it("leaves the head row in focus mode, which hides the capsule with it", async () => {
		const { rpc } = makeRpc();
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store, rpc, { focusMode: true });
		const head = host.querySelector<HTMLElement>(".gui-chat-head");
		expect(head?.classList.contains("gui-chat-head--focused-hidden")).toBe(true);
		// Still the one capsule — it must not float over the full-screen composer.
		expect(head?.querySelectorAll(".gui-agent-capsule").length).toBe(1);
		await unmount();
	});

	it("leaves no avatar and no gutter content in the transcript rows", async () => {
		const { rpc } = makeRpc();
		const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
		const { host, unmount } = await mount(store, rpc);
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
