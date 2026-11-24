import "./happy-dom-shim";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";
import { AGENT_INFO_SURFACE } from "../src/lib/surfaces/registry";

/**
 * The agent capsule is the agent info tab's launcher.
 *
 * Structural assertions only (happy-dom lays nothing out): the pill is a real
 * button with the expanded state exposed, one session has one tab, a click
 * opens-or-focuses it while expanding a folded panel, and a click on the tab
 * that is already visible folds the panel — the rail's own toggle rule. The
 * geometry and focus-ring rules live in agent-capsule-geometry.test.ts.
 */

const PANEL_KEY = "musepi-gui-panel-tabs-session-1";

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
] as unknown as SessionEntry[];

function view({
	store,
	rightPanelOpen,
	onExpandRightPanel,
	onToggleRightPanel,
}: {
	store: GuiSessionStore;
	rightPanelOpen: boolean;
	onExpandRightPanel(): void;
	onToggleRightPanel(): void;
}) {
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
			rightPanelOpen={rightPanelOpen}
			onExpandRightPanel={onExpandRightPanel}
			onToggleRightPanel={onToggleRightPanel}
			terminalOpen={false}
			focusMode={false}
			onToggleFocus={() => {}}
			sessionInfoOpen
			onToggleSessionInfo={() => {}}
		/>
	);
}

async function mount(
	options: Omit<Parameters<typeof view>[0], "store">,
): Promise<{ host: HTMLElement; store: GuiSessionStore; unmount: () => Promise<void> }> {
	const store = new GuiSessionStore("session-1", { entries, cursor: 0 }, "C:/workspace");
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(view({ ...options, store })));
	return {
		host,
		store,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
			store.dispose();
		},
	};
}

/** Seed the persisted tab layout CHATVIEW reads on mount. */
function seedAgentTab(): void {
	localStorage.setItem(
		PANEL_KEY,
		JSON.stringify({
			v: 2,
			split: false,
			splitRatio: 0.5,
			tabs: [
				{
					surface: AGENT_INFO_SURFACE,
					target: "session-1",
					label: "Agent",
					readOnly: false,
					touchedAt: 1,
					dedupeKey: "session-1",
					preview: false,
					column: 0,
				},
			],
			activeId: "session.agent::session-1",
			columnActive: ["session.agent::session-1", null],
		}),
	);
}

beforeEach(() => {
	setLocale("zh-CN");
	localStorage.setItem("musepi-gui-avatars", "0");
});

afterEach(() => {
	localStorage.clear();
	document.body.innerHTML = "";
});

afterAll(() => {
	setLocale("en-US");
});

describe("agent capsule control", () => {
	it("is a button that reports its expanded state and the agent's role", async () => {
		const { host, unmount } = await mount({
			rightPanelOpen: false,
			onExpandRightPanel: () => {},
			onToggleRightPanel: () => {},
		});
		const capsule = host.querySelector<HTMLButtonElement>(".gui-agent-capsule");
		expect(capsule?.tagName).toBe("BUTTON");
		expect(capsule?.getAttribute("type")).toBe("button");
		expect(capsule?.getAttribute("aria-expanded")).toBe("false");
		expect(capsule?.querySelector(".gui-agent-capsule-go")).not.toBeNull();
		// The role id is data; the visible name is its localized reading (the
		// workbench lane's coder before any row lands).
		expect(capsule?.dataset.agentRole).toBe("coder");
		// The visible reading IS the accessible name: no aria-label may replace
		// "助手 编码 · 空闲" (label-in-name), and the action is the tooltip.
		expect(capsule?.getAttribute("aria-label")).toBeNull();
		expect(capsule?.textContent).toContain("助手");
		expect(capsule?.querySelector(".gui-agent-role-tag")?.textContent).toBe("编码");
		expect(capsule?.textContent).toContain("空闲");
		expect(capsule?.getAttribute("title")).toBe("展开 Agent 详情");
		await unmount();
	});

	it("morphs the capsule avatar into the Agent tab's avatar", async () => {
		// The shared-element transition is the browser's; assert the primitive
		// is driven with the capsule orb as the old named snapshot.
		localStorage.setItem("musepi-gui-avatars", "1");
		const doc = document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
		const original = doc.startViewTransition;
		let calls = 0;
		let oldName: string | null = null;
		doc.startViewTransition = update => {
			calls += 1;
			oldName =
				document.querySelector<HTMLElement>(".gui-agent-capsule .gui-agent-avatar")?.style.viewTransitionName ??
				null;
			update();
			return { finished: Promise.resolve() };
		};
		try {
			const { host, unmount } = await mount({
				rightPanelOpen: false,
				onExpandRightPanel: () => {},
				onToggleRightPanel: () => {},
			});
			const capsule = host.querySelector<HTMLButtonElement>(".gui-agent-capsule")!;
			expect(capsule.querySelector(".gui-agent-avatar")).not.toBeNull();
			await act(async () => capsule.click());
			expect(calls).toBe(1);
			expect(oldName).toBe("agent-identity-avatar");
			await unmount();
		} finally {
			doc.startViewTransition = original;
		}
	});

	it("opens one session.agent tab for the session and expands a folded panel", async () => {
		let expanded = 0;
		const { host, unmount } = await mount({
			rightPanelOpen: false,
			onExpandRightPanel: () => {
				expanded += 1;
			},
			onToggleRightPanel: () => {},
		});
		const capsule = host.querySelector<HTMLButtonElement>(".gui-agent-capsule")!;
		await act(async () => capsule.click());
		expect(expanded).toBe(1);
		const state = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "null") as {
			tabs: Array<{ surface: string; target: string; dedupeKey: string }>;
			activeId: string;
		} | null;
		const tabs = state?.tabs.filter(tab => tab.surface === AGENT_INFO_SURFACE) ?? [];
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.target).toBe("session-1");
		expect(tabs[0]?.dedupeKey).toBe("session-1");
		expect(state?.activeId).toBe("session.agent::session-1");
		await unmount();
	});

	it("is expanded while its tab is the visible one", async () => {
		seedAgentTab();
		const { host, unmount } = await mount({
			rightPanelOpen: true,
			onExpandRightPanel: () => {},
			onToggleRightPanel: () => {},
		});
		const capsule = host.querySelector<HTMLButtonElement>(".gui-agent-capsule");
		expect(capsule?.getAttribute("aria-expanded")).toBe("true");
		await unmount();
	});

	it("folds the panel when its tab is already visible", async () => {
		seedAgentTab();
		let toggled = 0;
		let expanded = 0;
		const { host, unmount } = await mount({
			rightPanelOpen: true,
			onExpandRightPanel: () => {
				expanded += 1;
			},
			onToggleRightPanel: () => {
				toggled += 1;
			},
		});
		const capsule = host.querySelector<HTMLButtonElement>(".gui-agent-capsule")!;
		await act(async () => capsule.click());
		expect(toggled).toBe(1);
		expect(expanded).toBe(0);
		await unmount();
	});

	it("stays collapsed while the panel is folded even with the tab active", async () => {
		seedAgentTab();
		const { host, unmount } = await mount({
			rightPanelOpen: false,
			onExpandRightPanel: () => {},
			onToggleRightPanel: () => {},
		});
		const capsule = host.querySelector<HTMLButtonElement>(".gui-agent-capsule");
		expect(capsule?.getAttribute("aria-expanded")).toBe("false");
		await unmount();
	});

	it("keeps the session composer free of the model/thinking chip", async () => {
		const { host, unmount } = await mount({
			rightPanelOpen: false,
			onExpandRightPanel: () => {},
			onToggleRightPanel: () => {},
		});
		const composer = host.querySelector(".gui-composer");
		expect(composer).not.toBeNull();
		// The chip was the composer's only model surface; it now lives in the tab.
		expect(composer?.querySelectorAll(".gui-model-capsule").length).toBe(0);
		// The rest of the input row is untouched.
		expect(composer?.querySelectorAll(".gui-composer-ico").length ?? 0).toBeGreaterThan(0);
		expect(composer?.querySelector(".gui-composer-send")).not.toBeNull();
		await unmount();
	});
});
